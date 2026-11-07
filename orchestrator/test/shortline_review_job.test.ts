import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { detectPython } from "../src/init.ts";
import type { JobContext } from "../src/notify.ts";
import { resetReviews, type TurnFn } from "../src/finance/shortline/review.ts";
import { shortlineReviewJob } from "../src/finance/shortline/review_job.ts";
import { ServiceError, ledgerInsertMany, ledgerList, type ServiceContext } from "../src/service.ts";

/**
 * 「AI 情绪复盘」定时任务:到点自己跑,写完才报结果。
 *
 * 🔴 钉住四件事:
 *   ① 这一天已经有一版就不再写(重跑会多出一版几乎一样的);
 *   ② **等它写完**再返回:落进台账才叫写成;有段跳过要说清是哪一段,不能只说「写完了」;
 *   ③ 情绪读数一条都没取到 → 抛错(任务状态写「没写成」),不能报成功、也不能写成「今天没什么」;
 *   ④ 没接 AI 属于配置状态,说一句、不抛错。
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const sig = () => new AbortController().signal;
const DAY = "2026-10-09";
const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
/** 和假取数器里的 evid 同一个写法:证据编号 = sha1(端点|日期|字段) */
const E = (ep: string, field: string, d = DAY) => `ev-${sha(`${ep}|${d}|${field}`)}`;

afterEach(() => resetReviews());

const FAKE = String.raw`import json,sys,os,hashlib
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json',encoding='utf-8'))
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
def evid(*p): return 'ev-'+hashlib.sha1('|'.join(p).encode()).hexdigest()[:12]
d=args.get('date') or args.get('end') or ''
src=cfg.get('src',{}).get(ep)
if src is None: done({'status':'failed','reason':'这个端点在夹具里没给','evidence':[]},3)
evs=[{'id':evid(ep,d,k),'field':k,'value':v,'unit':'只','period':d} for k,v in src.items()]
done({'status':'ok','extra':{'settled':True},'evidence':evs})
`;

/** 每个端点给哪些字段。龙虎榜(`em_daily_dragon_tiger`)故意不给:那一段应当是「跳过」,不是「没有上榜」 */
const SRC: Record<string, Record<string, number>> = {
  cn_shortline_emotion: { limit_up_count: 60, broken_rate: 0.2, promotion_1to2: 0.35 },
  cn_shortline_cycle: { cycle_position: 4 },
  cn_shortline_facts: { event_ret: 1.2 },
  cn_shortline_themes: { topic_count: 12, topic_concentration: 0.18 },
  cn_shortline_firstboard: { firstboard_count: 18 },
  cn_shortline_ladder: { ladder_highest: 4, yesterday_promoted: 6 },
  cn_shortline_turnover_top: { amount_top1: 88 },
  em_market_trend: { market_amount_total: 15000 },
  em_market_margin: { margin_balance: 16200 },
};
const CFG = { src: SRC };

const TEXTS: Record<string, string> = {
  sentiment: `涨停 60 只[${E("cn_shortline_emotion", "limit_up_count")}],高位股的分歧在这一天比较明显。`,
  capital: `两市成交额 15000 亿元[${E("em_market_trend", "market_amount_total")}],集中在少数方向。`,
  theme: `题材 12 个[${E("cn_shortline_themes", "topic_count")}],首板按首封时间靠前的先封。`,
  leader: `最高 4 板[${E("cn_shortline_ladder", "ladder_highest")}],各档梯队没有明显断层。`,
  summary: [
    `涨停 60 只[${E("cn_shortline_emotion", "limit_up_count")}]是这一天最直接的一点。龙虎榜这段没有资料,不做推断。`,
    "如果下一个交易日涨停仍在 50 只以上,说明赚钱意愿没退。",
    "",
    "```json",
    '[{"metric":"limit_up_count","direction":"up","reason":"涨停回到 50 只以上才算延续"}]',
    "```",
  ].join("\n"),
};
const NOW = new Date("2026-10-09T11:02:00Z"); // 北京 19:02
const jobOf = (ctx: ServiceContext, now = NOW, manual = false): JobContext =>
  ({ ctx, day: DAY, now, signal: sig(), state: undefined, manual });
const fakeTurn = (): TurnFn & { n: () => number } => {
  let n = 0;
  const fn = (async (_m: string, session: string) => {
    n++;
    const sec = Object.keys(TEXTS).find((k) => new RegExp(`-${k}(-format-retry)?$`).test(session));
    return sec ? TEXTS[sec]! : "";
  }) as TurnFn & { n: () => number };
  fn.n = () => n;
  return fn;
};

function fakeCtx(): ServiceContext & { setCfg(c: unknown): void; cleanup(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-reviewjob-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

const savedOf = (ctx: ServiceContext) => ledgerList(ctx, "shortline_review").shortline_review ?? [];

test("这一天已经有一版:不再写第二版;手动运行才照写", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    ledgerInsertMany(ctx, { kind: "shortline_review", records: [{
      date: DAY, settled: true, ai: "手点的那一版",
      sections: [{ id: "sentiment", label: "情绪", status: "done", text: "旧版正文", evidence_count: 1 }],
    }] });
    const turn = fakeTurn();
    const r = await shortlineReviewJob(jobOf(ctx), { turn });
    assert.deepEqual(r.messages, []);
    assert.match(r.note!, /2026-10-09 已经有 1 版情绪复盘,今天不再写/);
    assert.equal(turn.n(), 0, "没调模型");
    assert.equal(savedOf(ctx).length, 1);

    const manual = await shortlineReviewJob(jobOf(ctx, NOW, true), { turn });
    assert.equal(manual.messages.length, 1);
    assert.ok(turn.n() > 0);
    assert.equal(savedOf(ctx).length, 2, "手动运行照写一版");
  } finally { ctx.cleanup(); }
});

test("正常跑:等它写完才报结果,落进台账的标「定时任务」,跳过的段要写清是哪一段", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const turn = fakeTurn();
    const r = await shortlineReviewJob(jobOf(ctx), { turn });

    assert.equal(r.status, "partial", "有段跳过 + 资料包有缺口,任务状态必须显式报 partial");
    assert.equal(r.messages.length, 1);
    const m = r.messages[0]!;
    assert.equal(m.title, `AI 情绪复盘 ${DAY} 已写完并存档`);
    assert.equal(m.link, "/shortline/review");
    assert.equal(m.dedupeKey, `shortline_review_ai:${DAY}`);
    // 龙虎榜一整块都没取到 ⇒ 那一段是 skipped:消息里必须点出是哪一段,不能只说「写完了」
    assert.match(m.lines[0]!, /^5 段写成了,1 段跳过\(龙虎榜\),合计 \d+ 字$/);
    assert.match(m.lines[1]!, /资料包有 \d+ 处缺口/);
    assert.match(m.lines[2]!, /另给了 1 条明日验证建议/);
    assert.match(m.lines[3]!, /台账里/);
    assert.equal(r.note, `${DAY} 的 AI 情绪复盘已存档`);

    // 和页面上点「开始」写的是同一张表;「写的 AI」这一栏要能看出是定时任务写的
    const saved = savedOf(ctx);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.date, DAY);
    assert.equal(saved[0]!.ai, "定时任务");
    assert.deepEqual((saved[0]!.conditions as { metric: string }[]).map((c) => c.metric), ["limit_up_count"]);
    const dragon = (saved[0]!.sections as { id: string; status: string }[]).find((s) => s.id === "dragon_tiger")!;
    assert.equal(dragon.status, "skipped");

    // 再跑一次(定时路径)不会再写
    const again = await shortlineReviewJob(jobOf(ctx), { turn });
    assert.deepEqual(again.messages, []);
    assert.equal(savedOf(ctx).length, 1);
  } finally { ctx.cleanup(); }
});

test("情绪读数一条都没取到:抛错(任务状态要说「没写成」,不能报成功)", async () => {
  const ctx = fakeCtx();
  try {
    const { cn_shortline_emotion, ...rest } = SRC;
    assert.ok(cn_shortline_emotion);
    ctx.setCfg({ src: rest });
    await assert.rejects(shortlineReviewJob(jobOf(ctx), { turn: fakeTurn() }),
      (e: unknown) => e instanceof ServiceError && e.code === "no_data" && /情绪数据没取到/.test(e.message));
    assert.deepEqual(savedOf(ctx), []);
  } finally { ctx.cleanup(); }
});

test("没接 AI:只写一句、不抛错(抛错会被重试三次再进收件箱)", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const r = await shortlineReviewJob(jobOf(ctx));
    assert.deepEqual(r.messages, []);
    assert.match(r.note!, /^没写:/);
    assert.match(r.note!, /AI 来源/);
    assert.deepEqual(savedOf(ctx), []);
  } finally { ctx.cleanup(); }
});
