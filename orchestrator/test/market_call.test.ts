/**
 * 大盘判断台账(方案 A):全景侧 JSON 交接件 → inbox 扫描落账 → 次日对账触发条件 → 视图战绩。
 * 全部走 CallDeps 注入(不碰真实端点):对账注入 tx_kline / em_market_breadth / em_market_trend 应答。
 * 🔴 只存全景产出的判断,本系统不生成大盘建议 —— managedWrites 挡通用接口写入。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { FINANCE_ENUM_LABELS, FINANCE_FIELD_LABELS, FINANCE_LEDGER_KINDS } from "../src/finance/ledger_kinds.ts";
import { INBOX_SUBDIR, judgeTrigger, marketCallJob, marketCallViewAct, parseCallJson, parseCallText, repairLoneBackslashes, scanInbox, settleCalls, type CallDeps } from "../src/finance/market_call.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { ledgerList, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { FINANCE_SCHEDULE } from "../src/finance/schedule.ts";

function fakeCtx(): ServiceContext & { cleanup(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-call-"));
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  return { repoRoot: repo, dataRoot, python: "python", node: process.execPath, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

const callsOf = (ctx: ServiceContext) => ledgerList(ctx, "market_call").market_call ?? [];

/** 往 inbox 落一份交接 JSON(模拟全景侧收盘档写件) */
function writeInbox(ctx: ServiceContext, name: string, obj: unknown): void {
  const dir = path.join(ctx.dataRoot, INBOX_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
}

/** 一份全字段的合法交接件 */
const callJson = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-05", call: "减仓", direction: "偏空",
  basis: "广度转弱、跌停家数抬头", trigger: "广度破 45% 转减仓",
  trigger_metric: "breadth_pct", trigger_op: "below", trigger_value: 45,
  breadth_pct: 48.6, amount_yi: 18500, limit_up: 55, limit_down: 12,
  html_path: "C:/Users/51092/Desktop/A股大盘全景-2026-11-05.html",
  ...over,
});

// ── 台账种类 ───────────────────────────────────────────────────────────────────
test("台账种类:只许任务写;必填=日期/四档/方向/已对账;触发读数与比较枚举闭合;字段显示名齐", () => {
  const k = FINANCE_LEDGER_KINDS.market_call!;
  assert.equal(k.label, "大盘判断台账");
  assert.equal(k.managedWrites, true, "通用台账接口不许改,只许 inbox 扫描任务写");
  assert.deepEqual(k.required, ["date", "call", "direction", "settled"]);
  assert.deepEqual((k.properties.call as { enum: string[] }).enum, ["加仓", "持有", "减仓", "观望"]);
  assert.deepEqual((k.properties.direction as { enum: string[] }).enum, ["偏多", "中性", "偏空"]);
  assert.deepEqual((k.properties.trigger_metric as { enum: string[] }).enum, ["breadth_pct", "limit_up", "limit_down", "amount_yi"]);
  assert.deepEqual((k.properties.trigger_op as { enum: string[] }).enum, ["above", "below"]);
  assert.equal(k.properties.additionalProperties, undefined, "schema 由 ledger 统一加 additionalProperties:false");
  for (const f of [
    "call", "basis", "trigger", "trigger_metric", "trigger_op", "trigger_value",
    "breadth_pct", "amount_yi", "limit_up", "limit_down",
    "next_breadth_pct", "next_amount_yi", "next_limit_up_count", "next_limit_down_count",
    "trigger_hit", "html_path", "settled", "settled_date",
  ]) assert.ok(FINANCE_FIELD_LABELS[f], `缺字段显示名:${f}`);
  for (const v of ["加仓", "持有", "减仓", "观望", "偏多", "中性", "偏空", "above", "below"]) {
    assert.ok(FINANCE_ENUM_LABELS[v], `缺枚举显示名:${v}`);
  }
  // 字段名两义防线:next_limit_up 是 opportunity_track 的「次日再板」(boolean),本种类不共用
  assert.equal(FINANCE_FIELD_LABELS.next_limit_up, "次日再板");
  assert.ok(!("next_limit_up" in k.properties), "market_call 不许用裸的 next_limit_up(会被读成「次日再板」)");
});

// ── 视图与定时任务登记 ─────────────────────────────────────────────────────────
test("视图已登记;18:30 定时任务排在全景收盘档落件之后", () => {
  assert.ok(listViews().some((v) => v.id === "market_call" && v.label === "大盘判断台账"));
  const j = FINANCE_SCHEDULE.jobs.find((x) => x.id === "market_call_sync")!;
  assert.ok(j, "定时任务缺失");
  assert.equal(j.at, "18:30");
  assert.equal(j.defaultEnabled, true);
  // 只跟全景收盘档有先后关系;机会清单台账(18:45)与本任务互不依赖,谁先谁后都行
  // 🔴 落件时间按**实测**来:11-02 18:07 / 11-03 18:06 / 11-04 18:05,不是原先假设的
  //    15:00~16:00。按 16:00 留余量等于没留 —— 档还没生成就扫,daily 台账就会「少一天」。
  const hms = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3));
  assert.ok(hms(j.at) >= hms("18:05") + 15, "实测 18:05 才落件,扫描至少要晚 15 分钟");
});

// ── 交接件校验 ─────────────────────────────────────────────────────────────────
test("parseCallJson:全字段合法归一化;结构化触发三项要么齐要么全缺", () => {
  const ok = parseCallJson(callJson());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(
    [ok.call.date, ok.call.call, ok.call.direction, ok.call.trigger_metric, ok.call.trigger_op, ok.call.trigger_value, ok.call.breadth_pct, ok.call.limit_up],
    ["2026-11-05", "减仓", "偏空", "breadth_pct", "below", 45, 48.6, 55]);
  // 只给原文不给结构化:合法,trigger_metric=null(判不了,不进分母)
  const loose = parseCallJson(callJson({ trigger_metric: undefined, trigger_op: undefined, trigger_value: undefined }));
  assert.equal(loose.ok, true);
  if (loose.ok) assert.deepEqual([loose.call.trigger_metric, loose.call.trigger_op, loose.call.trigger_value], [null, null, null]);
  // 齐一半:拒,并说清楚
  const half = parseCallJson(callJson({ trigger_op: undefined, trigger_value: undefined }));
  assert.equal(half.ok, false);
  if (!half.ok) assert.match(half.why, /要么都给/);
});

test("parseCallJson:缺日期/坏四档/坏三档/坏读数/坏比较各自拒并说原因", () => {
  const why = (o: Record<string, unknown>) => {
    const r = parseCallJson(callJson(o));
    return r.ok ? "" : r.why;
  };
  assert.match(why({ date: undefined }), /date/);
  assert.match(why({ date: "2026-11-99" }), /date/);
  assert.match(why({ call: "满仓" }), /四档/);
  assert.match(why({ direction: "看戏" }), /三档/);
  assert.match(why({ trigger_metric: "turnover" }), /可对账清单/);
  assert.match(why({ trigger_op: "gte" }), /above\/below/);
  const notObj = parseCallJson("不是对象");
  assert.equal(notObj.ok, false);
});

// ── 触发命中判定 ───────────────────────────────────────────────────────────────
test("judgeTrigger:≥/≤ 含等于;缺结构化条件或缺读数返回 null(判不了)", () => {
  const r = { breadth_pct: 45, amount_yi: 18000, limit_up: 80, limit_down: 5 };
  assert.equal(judgeTrigger("breadth_pct", "below", 45, r), true, "≤ 含等于");
  assert.equal(judgeTrigger("breadth_pct", "below", 44.9, r), false);
  assert.equal(judgeTrigger("breadth_pct", "above", 45, r), true, "≥ 含等于");
  assert.equal(judgeTrigger("limit_up", "above", 80, r), true);
  assert.equal(judgeTrigger("limit_down", "below", 4, r), false);
  assert.equal(judgeTrigger("amount_yi", "below", 20000, r), true);
  assert.equal(judgeTrigger(null, "below", 45, r), null);
  assert.equal(judgeTrigger("breadth_pct", null, 45, r), null);
  assert.equal(judgeTrigger("breadth_pct", "below", null, r), null);
  assert.equal(judgeTrigger("breadth_pct", "below", 45, { ...r, breadth_pct: null }), null, "缺读数判不了");
});

// ── inbox 扫描落账 ─────────────────────────────────────────────────────────────
test("scanInbox:合法落账并挪进 processed/;不合法留原地并写缺口;目录没建不算缺口", () => {
  const ctx = fakeCtx();
  try {
    // 目录还没建
    const none = scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    assert.deepEqual([none.ingested, none.gaps.length], [0, 0]);

    writeInbox(ctx, "2026-11-05.json", callJson());
    writeInbox(ctx, "bad.json", callJson({ date: "2026-11-99" }));
    writeInbox(ctx, "broken.json", "{ 这不是 JSON");
    const out = scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    assert.deepEqual([out.ingested, out.dates], [1, ["2026-11-05"]]);
    assert.equal(out.gaps.length, 2, "坏日期 + 坏 JSON 各一条缺口");
    assert.ok(out.gaps.some((g) => g.includes("bad.json") && g.includes("留在原地")));
    assert.ok(out.gaps.some((g) => g.includes("broken.json")));

    const rows = callsOf(ctx);
    assert.equal(rows.length, 1);
    const r = rows[0] as LedgerRecord;
    assert.deepEqual(
      [r.date, r.call, r.direction, r.basis, r.trigger, r.trigger_metric, r.trigger_op, r.trigger_value, r.breadth_pct, r.amount_yi, r.limit_up, r.limit_down, r.settled, r.html_path],
      ["2026-11-05", "减仓", "偏空", "广度转弱、跌停家数抬头", "广度破 45% 转减仓", "breadth_pct", "below", 45, 48.6, 18500, 55, 12, false,
        "C:/Users/51092/Desktop/A股大盘全景-2026-11-05.html"]);
    // 合法的挪进 processed/ 留档;坏的还在原地等修
    const dir = path.join(ctx.dataRoot, INBOX_SUBDIR);
    assert.ok(fs.existsSync(path.join(dir, "processed", "2026-11-05.json")));
    assert.ok(fs.existsSync(path.join(dir, "bad.json")));
    assert.ok(!fs.existsSync(path.join(dir, "2026-11-05.json")));
  } finally { ctx.cleanup(); }
});

test("scanInbox:同日重扫幂等(id/时间戳不动);同日第二档整条替换(增量覆盖判断)", () => {
  const ctx = fakeCtx();
  try {
    writeInbox(ctx, "2026-11-05.json", callJson());
    scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    const first = callsOf(ctx).map((r) => ({ id: r.id, updated_at: r.updated_at }));
    // 幂等:同一天再落一遍同样内容
    writeInbox(ctx, "2026-11-05.json", callJson());
    scanInbox(ctx, new Date("2026-11-05T16:10:00+08:00"));
    const second = callsOf(ctx).map((r) => ({ id: r.id, updated_at: r.updated_at }));
    assert.deepEqual(second, first, "重扫不产生新 id、不动时间戳");
    // 第二档:盘后修订(方向变了),同日整条替换,不留两条
    writeInbox(ctx, "2026-11-05.json", callJson({ call: "持有", direction: "中性", trigger: undefined, trigger_metric: undefined, trigger_op: undefined, trigger_value: undefined }));
    scanInbox(ctx, new Date("2026-11-05T16:30:00+08:00"));
    const rows = callsOf(ctx);
    assert.equal(rows.length, 1, "同日只留最新一档");
    assert.deepEqual([rows[0]!.call, rows[0]!.direction, rows[0]!.trigger], ["持有", "中性", undefined]);
    assert.deepEqual([rows[0]!.id, rows[0]!.updated_at === first[0]!.updated_at], [first[0]!.id, false], "正文变了才动时间戳");
  } finally { ctx.cleanup(); }
});

// ── 次日对账 ───────────────────────────────────────────────────────────────────
/** 注入端点:tx_kline 写 raw 文件(给 klineBars 读)、广度按 note 分档、趋势按 period 给成交额(元) */
function callDeps(o: { klines?: string[] | null; breadth?: Record<string, unknown>[] | null; amounts?: Record<string, number> }): CallDeps {
  const f: NonNullable<CallDeps["fetch"]> = async (ctx, req) => {
    if (req.endpoint === "tx_kline") {
      if (o.klines == null) throw new Error("网络断了");
      const outDir = "snap-kline";
      const ref = "raw/extracted_t_t_kline_1.json";
      fs.mkdirSync(path.join(ctx.dataRoot, outDir, "raw"), { recursive: true });
      fs.writeFileSync(path.join(ctx.dataRoot, outDir, ref), JSON.stringify({ rows: o.klines.map((d) => ({ date: d, close: 1000 })) }));
      return { envelope: { status: "ok", evidence: [{ field: "kline_points", value: o.klines.length, raw_ref: ref }] }, out_dir: outDir };
    }
    if (req.endpoint === "em_market_breadth") {
      if (o.breadth == null) return { envelope: { status: "failed", reason: "空表", evidence: [] }, out_dir: "snap" };
      return { envelope: { status: "ok", evidence: o.breadth }, out_dir: "snap" };
    }
    // em_market_trend:成交额按 period 给(元)
    const ev = Object.entries(o.amounts ?? {}).map(([period, value]) => ({ field: "market_amount_total", period, value }));
    return { envelope: { status: "ok", evidence: ev }, out_dir: "snap" };
  };
  return { fetch: f };
}

/** 广度证据:涨停 60 + 涨 2400 / 跌 2000 + 跌停 10 / 平盘 100 → 广度 = 2400/4500 = 53.3% */
const breadthRows = (): Record<string, unknown>[] => [
  { record_key: "r1", note: "涨停", field: "market_dist_count", value: 60 },
  { record_key: "r2", note: "涨5%以内", field: "market_dist_count", value: 2400 },
  { record_key: "r3", note: "跌3%以内", field: "market_dist_count", value: 2000 },
  { record_key: "r4", note: "平盘", field: "market_dist_count", value: 100 },
  { record_key: "r5", note: "跌停", field: "market_dist_count", value: 10 },
];

test("对账:次日=今天时补齐四项读数,触发条件按 ≥/≤ 机器判命中", async () => {
  const ctx = fakeCtx();
  try {
    writeInbox(ctx, "2026-11-05.json", callJson()); // 触发:breadth below 45;次日实测 53.3 → 未触发
    scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    const out = await settleCalls(ctx, new Date("2026-11-06T16:05:00+08:00"), new AbortController().signal, callDeps({
      klines: ["2026-11-04", "2026-11-05", "2026-11-06"],
      breadth: breadthRows(),
      amounts: { "2026-11-06": 1.86e12 },
    }));
    assert.deepEqual([out.settled, out.dates], [1, ["2026-11-05"]]);
    const r = callsOf(ctx)[0] as LedgerRecord;
    assert.deepEqual(
      [r.settled, r.settled_date, r.next_breadth_pct, r.next_amount_yi, r.next_limit_up_count, r.next_limit_down_count, r.trigger_hit],
      [true, "2026-11-06", 53.3, 18600, 60, 10, false],
      "53.3 > 45 → below 45 未触发;次日涨跌停家数走 _count 字段");
    // 再跑一遍:没有未结算的,幂等
    const out2 = await settleCalls(ctx, new Date("2026-11-06T16:10:00+08:00"), new AbortController().signal, callDeps({ klines: ["2026-11-05", "2026-11-06"], breadth: breadthRows() }));
    assert.equal(out2.settled, 0);
  } finally { ctx.cleanup(); }
});

test("对账:触发方向命中写 true;命中判定只用结构化三项,缺的留白不进分母", async () => {
  const ctx = fakeCtx();
  try {
    // above 50:次日广度 53.3 ≥ 50 → 命中
    writeInbox(ctx, "2026-11-05.json", callJson({ call: "加仓", direction: "偏多", trigger: "广度站上 50 转多", trigger_op: "above", trigger_value: 50 }));
    scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    await settleCalls(ctx, new Date("2026-11-06T16:05:00+08:00"), new AbortController().signal, callDeps({
      klines: ["2026-11-05", "2026-11-06"], breadth: breadthRows(), amounts: { "2026-11-06": 1.8e12 },
    }));
    assert.equal(callsOf(ctx)[0]!.trigger_hit, true);
    // 只给原文不给结构化:对账照补读数,trigger_hit 不写(判不了)
    // 注意 11-04 的次一交易日是 11-05,不是「今天」11-06 —— 广度端点只给最新一天,补不回来如实留空
    writeInbox(ctx, "2026-11-04.json", callJson({ date: "2026-11-04", trigger: "看广度脸色", trigger_metric: undefined, trigger_op: undefined, trigger_value: undefined }));
    scanInbox(ctx, new Date("2026-11-04T16:05:00+08:00"));
    const late4 = await settleCalls(ctx, new Date("2026-11-06T16:05:00+08:00"), new AbortController().signal, callDeps({
      klines: ["2026-11-04", "2026-11-05", "2026-11-06"], breadth: breadthRows(), amounts: { "2026-11-06": 1.8e12 },
    }));
    assert.ok(late4.gaps.some((g) => g.includes("2026-11-04") && g.includes("错过对账时点")));
    const r4 = callsOf(ctx).find((r) => r.date === "2026-11-04")!;
    assert.deepEqual([r4.settled, r4.next_breadth_pct, r4.trigger_hit], [true, undefined, undefined], "无结构化条件 → trigger_hit 不写,原文留档;广度补不回来不伪装");
  } finally { ctx.cleanup(); }
});

test("对账:错过时点广度/涨跌停补不回来(如实留空+缺口),成交额从趋势回查;次日没来静默;日 K 断整批不动", async () => {
  const ctx = fakeCtx();
  try {
    // 错过时点:今天 11-07,11-05 的次一交易日是 11-06(< 今天),广度端点只给最新一天
    writeInbox(ctx, "2026-11-05.json", callJson());
    scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    const late = await settleCalls(ctx, new Date("2026-11-07T16:05:00+08:00"), new AbortController().signal, callDeps({
      klines: ["2026-11-05", "2026-11-06", "2026-11-07"],
      amounts: { "2026-11-06": 1.7e12 },
    }));
    assert.equal(late.settled, 1);
    assert.ok(late.gaps.some((g) => g.includes("错过对账时点")), `缺口要说原因:${late.gaps.join(";")}`);
    const r = callsOf(ctx)[0] as LedgerRecord;
    assert.deepEqual([r.settled, r.settled_date, r.next_amount_yi], [true, "2026-11-06", 17000], "成交额可回查");
    assert.equal(r.next_breadth_pct, undefined, "广度补不回来,如实留空");
    assert.equal(r.trigger_hit, undefined, "读数缺 → 判不了,不进分母");

    // 次日还没来:静默等待,不算缺口
    const early = await settleCalls(ctx, new Date("2026-11-05T16:05:00+08:00"), new AbortController().signal, callDeps({
      klines: ["2026-11-04", "2026-11-05"], amounts: {},
    }));
    assert.deepEqual([early.settled, early.gaps.length], [0, 0]);

    // 日 K 整批取不到:不对账、写缺口
    const ctx2 = fakeCtx();
    try {
      writeInbox(ctx2, "2026-11-05.json", callJson());
      scanInbox(ctx2, new Date("2026-11-05T16:05:00+08:00"));
      const broken = await settleCalls(ctx2, new Date("2026-11-06T16:05:00+08:00"), new AbortController().signal, callDeps({ klines: null }));
      assert.deepEqual([broken.settled, broken.gaps.length], [0, 1]);
      assert.match(broken.gaps[0]!, /日 K 没取到/);
      assert.equal(callsOf(ctx2)[0]!.settled, false);
    } finally { ctx2.cleanup(); }
  } finally { ctx.cleanup(); }
});

// ── 视图 ───────────────────────────────────────────────────────────────────────
test("视图:空台账 available=false 但口径照给;有数据按日期倒序、战绩只算判得了的", async () => {
  const ctx = fakeCtx();
  try {
    const empty = await marketCallViewAct(ctx, {}, new AbortController().signal, new Date("2026-11-06T16:00:00+08:00"));
    assert.deepEqual([empty.available, empty.total, empty.settled_count, empty.judged, empty.hit], [false, 0, 0, 0, 0]);
    assert.ok(empty.caveat.includes("不构成投资建议"), "空台账也要带口径");

    writeInbox(ctx, "2026-11-05.json", callJson()); // 触发 below 45 → 未命中
    writeInbox(ctx, "2026-11-04.json", callJson({ date: "2026-11-04", call: "加仓", direction: "偏多", trigger: undefined, trigger_metric: undefined, trigger_op: undefined, trigger_value: undefined }));
    scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    await settleCalls(ctx, new Date("2026-11-06T16:05:00+08:00"), new AbortController().signal, callDeps({
      klines: ["2026-11-04", "2026-11-05", "2026-11-06"], breadth: breadthRows(), amounts: { "2026-11-06": 1.86e12 },
    }));
    const v = await marketCallViewAct(ctx, {}, new AbortController().signal, new Date("2026-11-06T16:10:00+08:00"));
    assert.deepEqual([v.available, v.total, v.settled_count, v.pending_count, v.date], [true, 2, 2, 0, "2026-11-05"]);
    assert.deepEqual([v.judged, v.hit], [1, 0], "11-04 那条无结构化条件不进分母");
    assert.deepEqual([v.rows[0]!.date, v.rows[0]!.trigger_hit], ["2026-11-05", false]);
    assert.equal(v.rows[0]!.html_path, "C:/Users/51092/Desktop/A股大盘全景-2026-11-05.html");
    assert.ok(v.caveat.includes("本台账只存档与对账"));
  } finally { ctx.cleanup(); }
});

test("视图:inbox 里没落账的交接件也进视图(source=inbox,不进战绩);同日已有台账行时以台账为准", async () => {
  const ctx = fakeCtx();
  try {
    // 还没扫描:11-05 只在 inbox,11-04 已落账(提前一天手写台账不现实,这里直接落账再塞一件模拟)
    writeInbox(ctx, "2026-11-04.json", callJson({ date: "2026-11-04", call: "持有", direction: "中性", trigger: undefined, trigger_metric: undefined, trigger_op: undefined, trigger_value: undefined }));
    scanInbox(ctx, new Date("2026-11-04T16:05:00+08:00"));
    writeInbox(ctx, "2026-11-05.json", callJson()); // 全景 15:00 落件,16:05 还没扫
    // 坏件不进视图(缺口由扫描任务报,视图只给能看的)
    writeInbox(ctx, "bad.json", callJson({ call: "满仓" }));

    const v = await marketCallViewAct(ctx, {}, new AbortController().signal, new Date("2026-11-05T15:30:00+08:00"));
    assert.deepEqual([v.available, v.total, v.date], [true, 2, "2026-11-05"]);
    const fresh = v.rows[0]!;
    assert.deepEqual(
      [fresh.date, fresh.call, fresh.source, fresh.settled, fresh.trigger_hit, fresh.settled_date],
      ["2026-11-05", "减仓", "inbox", false, null, null],
      "没落账的行:source=inbox、未对账、不进战绩分母");
    assert.equal(fresh.breadth_pct, 48.6, "交接件里的读数照给");
    const posted = v.rows.find((r) => r.date === "2026-11-04")!;
    assert.equal(posted.source, "ledger");
    // 11-04 只落账没对账(settleCalls 没跑过),所以两条都 pending;inbox 行不进 judged/hit
    assert.deepEqual([v.judged, v.hit, v.settled_count, v.pending_count], [0, 0, 0, 2]);

    // 同日两边都有(扫描前的修订件):以台账为准,不出两行
    writeInbox(ctx, "2026-11-04.json", callJson({ date: "2026-11-04", call: "减仓" }));
    const v2 = await marketCallViewAct(ctx, {}, new AbortController().signal, new Date("2026-11-05T15:40:00+08:00"));
    assert.equal(v2.rows.filter((r) => r.date === "2026-11-04").length, 1, "同日只出一行");
    assert.equal(v2.rows.find((r) => r.date === "2026-11-04")!.source, "ledger");

    // 扫描落账后:同一行转 source=ledger
    scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    const v3 = await marketCallViewAct(ctx, {}, new AbortController().signal, new Date("2026-11-05T16:10:00+08:00"));
    assert.equal(v3.rows.find((r) => r.date === "2026-11-05")!.source, "ledger");
    assert.equal(v3.rows.filter((r) => r.date === "2026-11-04").length, 1);
  } finally { ctx.cleanup(); }
});

// ── 定时任务整链 ───────────────────────────────────────────────────────────────
test("定时任务:先扫 inbox 落账、再对账到期的,一次跑完;重跑幂等", async () => {
  const ctx = fakeCtx();
  try {
    writeInbox(ctx, "2026-11-05.json", callJson());
    const j = { ctx, now: new Date("2026-11-06T16:05:00+08:00"), signal: new AbortController().signal };
    const out = await marketCallJob(j, callDeps({
      klines: ["2026-11-05", "2026-11-06"], breadth: breadthRows(), amounts: { "2026-11-06": 1.86e12 },
    }));
    assert.deepEqual(out.messages, []);
    assert.match(out.note, /落账 1 条/);
    assert.match(out.note, /对账 1 条\(2026-11-05\)/);
    const r = callsOf(ctx)[0] as LedgerRecord;
    assert.deepEqual([r.settled, r.next_breadth_pct, r.trigger_hit], [true, 53.3, false]);
    // 重跑:文件已进 processed/,没有未对账的
    const again = await marketCallJob({ ctx, now: new Date("2026-11-06T16:20:00+08:00"), signal: new AbortController().signal }, callDeps({
      klines: ["2026-11-05", "2026-11-06"], breadth: breadthRows(),
    }));
    assert.match(again.note, /落账 0 条/);
    assert.match(again.note, /没有到期可对账/);
  } finally { ctx.cleanup(); }
});

// ── 漏转义的反斜杠(2026-11-04 真实踩到:一份档写坏,台账静默缺一天) ──────────────

test("补反斜杠:合法的一个字节都不改,合法转义原样,只补真漏掉的", () => {
  // ① 本来合法的,输出必须与输入**逐字节相同** —— 否则这条「容错」就成了篡改数据
  const good = JSON.stringify(callJson());
  assert.equal(repairLoneBackslashes(good), good, "合法 JSON 不许被改动一个字节");
  // ② 合法转义一律不动
  for (const s of ['"\\u4e2d\\u6587"', '"a\\nb"', '"a\\tb"', '"a\\\\b"', '"a\\"b"']) {
    assert.equal(repairLoneBackslashes(s), s, `合法转义被改了:${s}`);
  }
  // ③ 真漏掉的补回来(源码里 \\ 是单个反斜杠,所以下面这些是真坏文本)
  const bad = '{"p":"C:\\Users\\51092\\Desktop\\A.html"}';
  assert.equal(JSON.parse(repairLoneBackslashes(bad)).p, "C:\\Users\\51092\\Desktop\\A.html");
  const badD = '{"p":"C:\\data\\x.html"}';
  assert.equal(JSON.parse(repairLoneBackslashes(badD)).p, "C:\\data\\x.html");
  // ④ \u 后面不是 4 位十六进制 → 同样算漏转义,而不是当成 Unicode 转义
  const badU = '{"p":"C:\\Users"}';
  assert.equal(JSON.parse(repairLoneBackslashes(badU)).p, "C:\\Users");
  // ⑤ 结构性的坏不在这里修:修完还是解析不了,就老实报错
  assert.equal(parseCallText('{"a":"b"').ok, false);
});

test("🔴 路径漏转义的档照旧落账并说明补过;结构坏的才留在原地", async () => {
  const ctx = fakeCtx();
  try {
    const dir = path.join(ctx.dataRoot, INBOX_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    // 模拟全景侧写坏的那一份:把合法 JSON 里的双反斜杠降成单个
    const obj = callJson({ html_path: "C:\\Users\\51092\\Desktop\\A股大盘全景-2026-11-05.html" });
    fs.writeFileSync(path.join(dir, "2026-11-05.json"), JSON.stringify(obj).replace(/\\\\/g, "\\"));
    // 另一份是真坏(缺右括号)—— 这份必须留在原地等人改
    fs.writeFileSync(path.join(dir, "2026-11-06.json"), '{"date":"2026-11-06","call":"持有"');

    const out = scanInbox(ctx, new Date("2026-11-05T16:05:00+08:00"));
    assert.equal(out.repaired, 1, "要报出「有 1 份是补过转义才解析出来的」,不能悄悄修");
    assert.equal(out.ingested, 1, "补好的照常落账");
    assert.equal(out.gaps.length, 1, "结构坏的仍算缺口");
    assert.match(out.gaps[0]!, /2026-11-06\.json/);

    const recs = callsOf(ctx);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.html_path, "C:\\Users\\51092\\Desktop\\A股大盘全景-2026-11-05.html", "路径要还原成完整的,不能留半截");

    // 原文件(坏的也算)挪进 processed 留档,别删 —— 要能回头查到当初写坏的是什么样
    assert.ok(fs.existsSync(path.join(dir, "processed", "2026-11-05.json")));
    assert.ok(fs.existsSync(path.join(dir, "2026-11-06.json")), "没修的留在原地等改好");
  } finally { ctx.cleanup(); }

  // ② 再走一遍任务入口:note 里必须交代「补过转义」,
  //    否则用户只看到「今天落账了」,不知道这天差点又静默缺一次。
  {
    const ctx2 = fakeCtx();
    try {
      const dir = path.join(ctx2.dataRoot, INBOX_SUBDIR);
      fs.mkdirSync(dir, { recursive: true });
      const obj = callJson({ html_path: "C:\\Users\\51092\\Desktop\\A股大盘全景-2026-11-05.html" });
      fs.writeFileSync(path.join(dir, "2026-11-05.json"), JSON.stringify(obj).replace(/\\\\/g, "\\"));
      const r = await marketCallJob(
        { ctx: ctx2, now: new Date("2026-11-05T16:05:00+08:00"), signal: new AbortController().signal },
        callDeps({ klines: null }),
      );
      assert.match(r.note, /落账 1 条/);
      assert.match(r.note, /反斜杠转义/, "note 要交代补过转义");
    } finally { ctx2.cleanup(); }
  }
});
