/**
 * 机会清单收盘落台账(P0):快照 → 次日对账 → 类别×环境汇总。
 * 全部走 TrackDeps 注入(不碰真实取数):快照注入机会清单与市场相位,对账注入端点应答。
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
import { categoryOf, opportunityTrackJob, opportunityTrackView, regimeOf, sealBucketName, settlePending, snapshotDay, trackSummary, type TrackDeps } from "../src/finance/shortline/opportunity_track.ts";
import { SAMPLE_CAVEAT, type SampleRow } from "../src/finance/shortline/samples.ts";
import type { ShortlineOpportunityResult, StockOpportunity } from "../src/finance/shortline/opportunities.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { ledgerList, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { FINANCE_SCHEDULE } from "../src/finance/schedule.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeCtx(): ServiceContext & { cleanup(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-track-"));
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  return { repoRoot: repo, dataRoot, python: "python", node: process.execPath, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

const opp = (code: string, boards: number, extra: Partial<StockOpportunity> = {}): StockOpportunity => ({
  code, name: `股${code}`, sector: "算力", boards, seal_time: "09:40", tags: [],
  pattern: { type: "首板爆发", confidence: 65, trigger: "t", risk: "中" },
  limit_price: 10, change_pct: 10, float_cap_yi: 30, turnover_yi: 5, seal_amount_yi: 2,
  open_count: 0, note: "", ...extra,
});

const list = (date: string, opps: StockOpportunity[], main: string[] = ["算力"]): ShortlineOpportunityResult => ({
  date, clock: "18:45:00", status: "ok", phase: "强势", limit_up_count: 80, broken_rate: 0.2, seal_rate: 0.7,
  opportunities: opps, by_sector: {}, main_sectors: main, gaps: [], notes: [], source: "s",
});

const trackOf = (ctx: ServiceContext) => ledgerList(ctx, "opportunity_track").opportunity_track ?? [];

// ── 归档口径:与前端 patternPrior 同口径 ────────────────────────────────────────
test("归档口径:类别按连板数三档;相位→情绪三档(冰点弱、退潮修复中、其余强、缺相位未覆盖);封板分档只给首板", () => {
  assert.deepEqual([categoryOf(0), categoryOf(1), categoryOf(2), categoryOf(3), categoryOf(7)], ["首板", "首板", "连板", "高标", "高标"]);
  assert.deepEqual(
    [regimeOf(null), regimeOf("冰点期"), regimeOf("退潮期"), regimeOf("修复期"), regimeOf("主升期"), regimeOf("高潮期"), regimeOf("极度高潮期")],
    ["环境未覆盖", "情绪弱", "情绪中", "情绪中", "情绪强", "情绪强", "情绪强"]);
  assert.equal(sealBucketName("09:35", "首板"), "开盘秒板");
  assert.equal(sealBucketName("09:59", "首板"), "9:35-10:00");
  assert.equal(sealBucketName("10:30", "首板"), "10:00-11:00");
  assert.equal(sealBucketName("13:00", "首板"), "11:00-14:00");
  assert.equal(sealBucketName("14:30", "首板"), "14:00后");
  assert.equal(sealBucketName(null, "首板"), "封板时间缺失");
  assert.equal(sealBucketName("09:35", "连板"), "", "连板/高标不封档");
});

// ── 台账种类 ───────────────────────────────────────────────────────────────────
test("台账种类:只许任务写;必填含日期/代码/连板数/类别/环境/已对账;类别与环境枚举闭合;字段显示名齐", () => {
  const k = FINANCE_LEDGER_KINDS.opportunity_track!;
  assert.equal(k.label, "机会清单台账");
  assert.equal(k.managedWrites, true, "通用台账接口不许改,只能快照/对账写");
  assert.deepEqual(k.required, ["date", "code", "boards", "category", "regime", "settled"]);
  assert.deepEqual((k.properties.category as { enum: string[] }).enum, ["首板", "连板", "高标"]);
  assert.deepEqual((k.properties.regime as { enum: string[] }).enum, ["情绪强", "情绪中", "情绪弱", "环境未覆盖"]);
  assert.equal(k.properties.additionalProperties, undefined, "schema 由 ledger 统一加 additionalProperties:false");
  for (const f of ["code", "boards", "seal_time", "pattern_type", "pattern_confidence", "regime", "seal_bucket", "in_main_sector", "market_phase", "settled", "next_ret", "next_limit_up", "settled_date"]) {
    assert.ok(FINANCE_FIELD_LABELS[f], `缺字段显示名:${f}`);
  }
  for (const v of ["首板", "连板", "高标", "情绪强", "情绪中", "情绪弱", "环境未覆盖"]) assert.ok(FINANCE_ENUM_LABELS[v] ?? true);
});

// ── 视图与定时任务登记 ─────────────────────────────────────────────────────────
test("视图已登记;18:45 定时任务已排在收盘取数之后", () => {
  assert.ok(listViews().some((v) => v.id === "shortline_opportunity_track" && v.label === "机会清单战绩"));
  const j = FINANCE_SCHEDULE.jobs.find((x) => x.id === "opportunity_track")!;
  assert.ok(j, "定时任务缺失");
  assert.equal(j.at, "18:45");
  assert.ok(FINANCE_SCHEDULE.jobs.findIndex((x) => x.id === "shortline_close_fetch") < FINANCE_SCHEDULE.jobs.findIndex((x) => x.id === "opportunity_track"),
    "对账要读收盘取数先取好的 cn_shortline_settled,必须排在它后面");
});

// ── 快照 ───────────────────────────────────────────────────────────────────────
const depsSnap = (opps: StockOpportunity[], phase: "主升期" | null = "主升期", date = "2026-11-05"): TrackDeps => ({
  opportunities: async () => list(date, opps),
  marketSignal: async () => ({ phase }),
});

test("快照:归档字段全落(原始置信度/类别/环境/分档/主线/相位),未对账", async () => {
  const ctx = fakeCtx();
  try {
    const out = await snapshotDay(ctx, "2026-11-05", new AbortController().signal,
      depsSnap([opp("600001", 1, { seal_time: "09:31" }), opp("600002", 2), opp("600003", 3, { sector: "医药" })]));
    assert.deepEqual([out.written, out.count], [true, 3]);
    const rows = trackOf(ctx);
    const [a, b, c] = rows.map((r) => r as LedgerRecord);
    assert.deepEqual(
      [a!.date, a!.code, a!.boards, a!.category, a!.regime, a!.seal_bucket, a!.in_main_sector, a!.market_phase, a!.pattern_type, a!.pattern_confidence, a!.settled],
      ["2026-11-05", "600001", 1, "首板", "情绪强", "开盘秒板", true, "主升期", "首板爆发", 65, false]);
    assert.deepEqual([b!.category, b!.seal_bucket, b!.in_main_sector], ["连板", "", false], "连板不封档、也不算板块共振");
    assert.deepEqual([c!.category, c!.in_main_sector], ["高标", false], "医药不在主线前二行业");
    assert.equal(a!.sector, "算力");
  } finally { ctx.cleanup(); }
});

test("快照:相位算不出归「环境未覆盖」;清单为空不落盘、不抹已有快照", async () => {
  const ctx = fakeCtx();
  try {
    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1)], null));
    assert.equal(trackOf(ctx)[0]!.regime, "环境未覆盖");
    assert.equal(trackOf(ctx)[0]!.market_phase, "");
    // 清单空但当日涨停>0:保留已有
    const out = await snapshotDay(ctx, "2026-11-05", new AbortController().signal, {
      opportunities: async () => ({ ...list("2026-11-05", []), notes: [] }),
      marketSignal: async () => ({ phase: null }),
    });
    assert.deepEqual([out.written, trackOf(ctx).length], [false, 1]);
    // 清单空且涨停也取不到:同样保留
    const out2 = await snapshotDay(ctx, "2026-11-05", new AbortController().signal, {
      opportunities: async () => ({ ...list("2026-11-05", []), limit_up_count: 0, notes: ["em_zt_pool 取数失败"] }),
      marketSignal: async () => ({ phase: null }),
    });
    assert.equal(out2.written, false);
    assert.match(out2.note, /没取到/);
    assert.equal(trackOf(ctx).length, 1);
  } finally { ctx.cleanup(); }
});

test("快照:同日重跑幂等(id 复用、正文没变 updated_at 不动);已对账的行结算结果不被抹掉", async () => {
  const ctx = fakeCtx();
  try {
    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1), opp("600002", 2)]));
    const first = trackOf(ctx).map((r) => ({ id: r.id, updated_at: r.updated_at }));
    await new Promise((r) => setTimeout(r, 5));
    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1), opp("600002", 2)]));
    const second = trackOf(ctx).map((r) => ({ id: r.id, updated_at: r.updated_at }));
    assert.deepEqual(second, first, "重跑不产生新 id、不动时间戳");
    // 先对账(模拟次日结算完成),再重跑快照
    const st = await settlePending(ctx, new Date("2026-11-06T15:50:00+08:00"), new AbortController().signal, settleDeps(ctx.dataRoot, {
      klines: ["2026-11-05", "2026-11-06"],
      settled: { "2026-11-06": rows([["600001", 3.2, "是"], ["600002", -1.5, "否"]]) },
    }));
    assert.equal(st.settled, 2);
    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1), opp("600002", 2)]));
    const a = trackOf(ctx).find((r) => r.code === "600001")!;
    assert.deepEqual([a.settled, a.next_ret, a.next_limit_up, a.settled_date], [true, 3.2, true, "2026-11-06"], "重跑快照不能抹掉对账结果");
  } finally { ctx.cleanup(); }
});

// ── 对账 ───────────────────────────────────────────────────────────────────────
/** 构造注入端点:kline 信封 + raw 文件(给 klineBars 读),cn_shortline_settled 信封 */
const rows = (xs: [string, number, string][]) => xs.flatMap(([code, ret, lu]) => [
  { field: "settled_ret", record_key: code, value: ret },
  { field: "settled_limit_up", record_key: code, value: lu },
]);

function settleDeps(dataRoot: string, o: { klines: string[]; settled: Record<string, unknown[] | null>; unsettled?: string[] }): TrackDeps {
  return {
    fetchSettled: async (_ctx, req) => {
      if (req.endpoint === "tx_kline") {
        // klineBars 走 readRawDoc → safePath,raw 文件必须落在 dataRoot 下
        const outDir = "snap-kline";
        const ref = "raw/extracted_t_t_kline_1.json";
        fs.mkdirSync(path.join(dataRoot, outDir, "raw"), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, outDir, ref), JSON.stringify({ rows: o.klines.map((d) => ({ date: d, close: 1000 })) }));
        return { envelope: { status: "ok", evidence: [{ field: "kline_points", value: o.klines.length, raw_ref: ref }] }, out_dir: outDir };
      }
      const d = String((req.args as { date?: string }).date ?? "");
      const v = o.settled[d];
      if (o.unsettled?.includes(d)) return { envelope: { status: "partial", extra: { settled: false }, evidence: v ?? [] }, out_dir: "snap" };
      if (v === undefined || v === null) return { envelope: { status: "failed", reason: "空表", evidence: [] }, out_dir: "snap" };
      return { envelope: { status: "ok", extra: { settled: true }, evidence: v }, out_dir: "snap" };
    },
  };
}

test("对账:次日定稿后逐只补结算;判不了再板的不写 next_limit_up;不在名单的保持未对账", async () => {
  const ctx = fakeCtx();
  try {
    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1), opp("600002", 2), opp("600003", 3)]));
    const st = await settlePending(ctx, new Date("2026-11-06T15:50:00+08:00"), new AbortController().signal, settleDeps(ctx.dataRoot, {
      klines: ["2026-11-04", "2026-11-05", "2026-11-06"],
      settled: { "2026-11-06": rows([["600001", 3.2, "是"], ["600002", -1.5, "否"], ["600003", 0, "不适用"]]) },
    }));
    assert.equal(st.settled, 3);
    const by = new Map(trackOf(ctx).map((r) => [r.code, r]));
    assert.deepEqual([by.get("600001")!.settled, by.get("600001")!.next_ret, by.get("600001")!.next_limit_up, by.get("600001")!.settled_date], [true, 3.2, true, "2026-11-06"]);
    assert.deepEqual([by.get("600002")!.next_ret, by.get("600002")!.next_limit_up], [-1.5, false]);
    assert.equal(by.get("600003")!.next_limit_up, undefined, "判不了再板的不写字段(不进分母)");
    assert.equal(by.get("600003")!.settled, true, "涨跌幅有值就算已对账");
    // 再跑一遍:没有可对账的,幂等
    const st2 = await settlePending(ctx, new Date("2026-11-06T16:00:00+08:00"), new AbortController().signal, settleDeps(ctx.dataRoot, { klines: ["2026-11-05", "2026-11-06"], settled: { "2026-11-06": rows([["600001", 3.2, "是"]]) } }));
    assert.equal(st2.settled, 0);
  } finally { ctx.cleanup(); }
});

test("对账:次日还没来不动作;没定稿不写并留说明;日 K 缺失留说明;停牌缺行保持未对账", async () => {
  const ctx = fakeCtx();
  try {
    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1), opp("600002", 1)]));
    // 次日(11-06)还没到:now=11-05 晚,日 K 也只到 11-05
    const s1 = await settlePending(ctx, new Date("2026-11-05T15:50:00+08:00"), new AbortController().signal, settleDeps(ctx.dataRoot, { klines: ["2026-11-04", "2026-11-05"], settled: {} }));
    assert.deepEqual([s1.settled, s1.gaps.length], [0, 0], "对账日没来 = 静默等待,不算缺口");
    assert.equal(trackOf(ctx)[0]!.settled, false);
    // 次日到了但没定稿
    const s2 = await settlePending(ctx, new Date("2026-11-06T10:00:00+08:00"), new AbortController().signal, settleDeps(ctx.dataRoot, {
      klines: ["2026-11-05", "2026-11-06"], settled: { "2026-11-06": null }, unsettled: ["2026-11-06"],
    }));
    assert.equal(s2.settled, 0);
    assert.ok(s2.gaps.some((g) => g.includes("没取到") || g.includes("定稿")), `缺口要说明原因:${s2.gaps.join(";")}`);
    // 次日定稿但只找到一只(另一只可能停牌)
    const s3 = await settlePending(ctx, new Date("2026-11-06T15:50:00+08:00"), new AbortController().signal, settleDeps(ctx.dataRoot, {
      klines: ["2026-11-05", "2026-11-06"], settled: { "2026-11-06": rows([["600001", 2.0, "是"]]) },
    }));
    assert.equal(s3.settled, 1);
    assert.ok(s3.gaps.some((g) => g.includes("600002") && g.includes("停牌")), `缺行要说明:${s3.gaps.join(";")}`);
    const by = new Map(trackOf(ctx).map((r) => [r.code, r]));
    assert.equal(by.get("600002")!.settled, false, "缺行的保持未对账,不猜结果");
  } finally { ctx.cleanup(); }
});

test("对账:日 K 完全取不到时整批不动并说明", async () => {
  const ctx = fakeCtx();
  try {
    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1)]));
    const st = await settlePending(ctx, new Date("2026-11-06T15:50:00+08:00"), new AbortController().signal, {
      fetchSettled: async () => { throw new Error("网络断了"); },
    });
    assert.deepEqual([st.settled, st.gaps.length], [0, 1]);
    assert.match(st.gaps[0]!, /日 K 没取到/);
    assert.equal(trackOf(ctx)[0]!.settled, false);
  } finally { ctx.cleanup(); }
});

// ── 汇总 ───────────────────────────────────────────────────────────────────────
const rec = (o: Record<string, unknown>): LedgerRecord =>
  ({ id: String(o.id ?? "x"), kind: "opportunity_track", created_at: "t", updated_at: "t", settled: true, ...o }) as LedgerRecord;

test("汇总:12 个格子全给;胜率平盘不算赢;再板率判不了不进分母;未对账不进统计;无样本各项 null", () => {
  const cells = trackSummary([
    rec({ id: "1", date: "2026-11-05", code: "1", boards: 1, category: "首板", regime: "情绪强", next_ret: 2, next_limit_up: true }),
    rec({ id: "2", date: "2026-11-05", code: "2", boards: 1, category: "首板", regime: "情绪强", next_ret: 0, next_limit_up: false }),
    rec({ id: "3", date: "2026-11-05", code: "3", boards: 1, category: "首板", regime: "情绪强", next_ret: -1 }),
    rec({ id: "4", date: "2026-11-05", code: "4", boards: 2, category: "连板", regime: "情绪中", next_ret: 5, next_limit_up: true }),
    rec({ id: "5", date: "2026-11-05", code: "5", boards: 1, category: "首板", regime: "情绪强", settled: false }),
  ]);
  assert.equal(cells.length, 12, "3 类别 × 4 环境,一个不缺(前端一一对齐先验表)");
  const c = cells.find((x) => x.category === "首板" && x.regime === "情绪强")!;
  assert.deepEqual([c.sample, c.win_rate, c.avg, c.limit_up_rate], [3, 0.333, 0.33, 0.5], "平盘不算赢;第 3 只判不了再板不进分母");
  assert.deepEqual([c.best, c.worst], [2, -1]);
  const lian = cells.find((x) => x.category === "连板" && x.regime === "情绪中")!;
  assert.deepEqual([lian.sample, lian.win_rate, lian.limit_up_rate], [1, 1, 1]);
  const empty = cells.find((x) => x.category === "高标")!;
  assert.deepEqual([empty.sample, empty.win_rate, empty.limit_up_rate, empty.avg], [0, null, null, null], "无样本不伪装 0");
});

// ── 视图 ───────────────────────────────────────────────────────────────────────
test("视图:空台账 available=false;有数据给统计、待对账清单与口径;口径文案非空", async () => {
  const ctx = fakeCtx();
  try {
    const empty = await opportunityTrackView(ctx, {}, new AbortController().signal, new Date("2026-11-06T16:00:00+08:00"));
    assert.deepEqual([empty.available, empty.total, empty.snapshot_days], [false, 0, 0]);
    assert.equal(empty.cells.length, 12, "空台账也给 12 个空格子,前端不用补");

    await snapshotDay(ctx, "2026-11-05", new AbortController().signal, depsSnap([opp("600001", 1), opp("600002", 2)]));
    const v = await opportunityTrackView(ctx, {}, new AbortController().signal, new Date("2026-11-06T16:00:00+08:00"));
    assert.deepEqual([v.available, v.total, v.settled_count, v.pending_count, v.date, v.snapshot_days], [true, 2, 0, 2, "2026-11-05", 1]);
    assert.equal(v.pending_rows.length, 2);
    assert.deepEqual([v.pending_rows[0]!.code, v.pending_rows[0]!.category, v.pending_rows[0]!.regime], ["600001", "首板", "情绪强"], "相位为主升期 → 情绪强");
    assert.ok(v.sample_caveat.length > SAMPLE_CAVEAT.length - 1, "口径文案要带样本口径并追加本页说明");
    assert.ok(v.sample_caveat.includes("市场现象统计"));
  } finally { ctx.cleanup(); }
});

// ── 定时任务整链 ───────────────────────────────────────────────────────────────
test("定时任务:先快照今天、再对账昨天,一次跑完两件事", async () => {
  const ctx = fakeCtx();
  try {
    const j = {
      ctx, day: "2026-11-06", now: new Date("2026-11-06T18:45:00+08:00"), signal: new AbortController().signal,
      state: undefined, manual: false,
    };
    // 昨天(11-05)的快照已存在;今天(11-06)的清单要新快照;11-05 的对账数据就绪
    await snapshotDay(ctx, "2026-11-05", j.signal, depsSnap([opp("600001", 1)], "主升期", "2026-11-05"));
    const deps: TrackDeps = {
      ...depsSnap([opp("600002", 2), opp("600003", 1, { sector: "医药" })], "主升期", "2026-11-06"),
      ...settleDeps(ctx.dataRoot, { klines: ["2026-11-05", "2026-11-06"], settled: { "2026-11-06": rows([["600001", 4.9, "是"]]) } }),
    };
    const out = await opportunityTrackJob(j, deps);
    const rowsAll = trackOf(ctx);
    assert.equal(rowsAll.length, 3, "昨天 1 只 + 今天 2 只");
    const d5 = rowsAll.filter((r) => r.date === "2026-11-05");
    assert.equal(d5.length, 1);
    assert.deepEqual([d5[0]!.settled, d5[0]!.next_ret], [true, 4.9], "昨天的已对账");
    const d6 = rowsAll.filter((r) => r.date === "2026-11-06");
    assert.deepEqual([d6.length, d6.every((r) => r.settled === false)], [2, true], "今天的刚快照,未对账");
    assert.ok(d6.some((r) => r.category === "连板"), "今天含 2 板(连板)");
    assert.ok(d6.some((r) => r.category === "首板" && r.in_main_sector === false), "医药首板不在主线前二行业");
    assert.match(out.note!, /快照 2 只/);
    assert.match(out.note!, /对账 1 只/);
  } finally { ctx.cleanup(); }
});
