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
import { weeklyReviewJob } from "../src/finance/shortline/weekly_job.ts";
import { ServiceError, ledgerInsertMany, ledgerList, type ServiceContext } from "../src/service.ts";

/**
 * 「AI 周报」定时任务:到点自己跑,写完才报结果。
 *
 * 🔴 钉住四件事:
 *   ① 只在周五写(其余几天一句 note 就结束,不联网、不调模型);
 *   ② 这一周已经有版本就不再写(重跑会多出一版几乎一样的);
 *   ③ **等它写完**再返回:落进台账才叫写成,失败要说失败;
 *   ④ 没接 AI 属于配置状态,说一句、不抛错。
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const sig = () => new AbortController().signal;
const id = (name: string) => `ev-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`;

afterEach(() => resetReviews());

const FAKE = String.raw`import json,sys,os,hashlib
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json',encoding='utf-8'))
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
def evid(*p): return 'ev-'+hashlib.sha1('|'.join(p).encode()).hexdigest()[:12]
d=args.get('date','')
if ep=='tx_kline':
  rows=cfg.get('klines',[])
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_k_%d.json'%os.getpid()
  json.dump({'rows':[{'date':x,'open':1,'high':1,'low':1,'close':1000,'volume':1} for x in rows]},open(os.path.join(out,ref),'w',encoding='utf-8'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep=='cn_shortline_daily':
  v=cfg.get('daily',{}).get(d)
  if v is None: done({'status':'failed','reason':'东财池为空','evidence':[]},3)
  evs=[{'id':evid(d,k),'field':k,'value':x,'unit':'只','period':d} for k,x in v.items()]
  done({'status':'ok','extra':{'settled':True},'evidence':evs})
if ep=='cn_shortline_themes':
  n=cfg.get('themes',{}).get(d)
  if n is None: done({'status':'failed','reason':'同花顺没取到','evidence':[]},3)
  done({'status':'ok','extra':{'settled':True},'evidence':[
    {'id':evid(d,'topic_concentration'),'field':'topic_concentration','value':0.12,'unit':'小数','period':d}]})
if ep=='cn_shortline_structure':
  done({'status':'ok','extra':{'settled':True},'evidence':[
    {'id':evid(d,'ladder'),'field':'ladder_highest','value':4,'unit':'板','period':d}]})
done({'status':'failed','reason':'没有','evidence':[]},3)
`;

interface Cfg { klines?: string[]; daily?: Record<string, Record<string, number>>; themes?: Record<string, number> }

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; cleanup(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-weeklyjob-"));
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

const K = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
const day = (lu: number) => ({ limit_up_count: lu, ladder_highest: 4, broken_rate: 0.2, money_effect_median_ret: 1.5 });
// 2026-10-05 起这一周:10-05、10-06、10-07 国庆休市,交易日只有 10-08、10-09
const DAILY: Record<string, Record<string, number>> = Object.fromEntries(K.map((d) => [d, day(40)]));
Object.assign(DAILY, { "2026-10-08": day(50), "2026-10-09": day(80) });
const CFG: Cfg = { klines: K, daily: DAILY, themes: { "2026-10-08": 3, "2026-10-09": 3 } };
const TEXTS = {
  trend: `涨停从 50 只[${id("2026-10-08|limit_up_count")}]到 80 只[${id("2026-10-09|limit_up_count")}]。`,
  themes: `10-08 集中度 0.12[${id("2026-10-08|topic_concentration")}]。`,
  verify: "本周没有对账条件。",
  summary: `这一周涨停回升到 80 只[${id("2026-10-09|limit_up_count")}]。如果下周涨停继续在 60 只以上,说明情绪延续。`,
};
const FRIDAY = new Date("2026-10-09T11:10:00Z");  // 北京 19:10,周五
const SATURDAY = new Date("2026-10-10T11:10:00Z");
const jobOf = (ctx: ServiceContext, now = FRIDAY, manual = false): JobContext =>
  ({ ctx, day: "2026-10-09", now, signal: sig(), state: undefined, manual });
const fakeTurn = (): TurnFn & { n: () => number } => {
  let n = 0;
  const fn = (async (_m: string, session: string) => {
    n++;
    const sec = Object.keys(TEXTS).find((k) => new RegExp(`-${k}(-format-retry)?$`).test(session));
    return TEXTS[sec as keyof typeof TEXTS] ?? "";
  }) as TurnFn & { n: () => number };
  fn.n = () => n;
  return fn;
};

test("不是周五:一句说明就结束,不联网、不调模型", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const turn = fakeTurn();
    const r = await weeklyReviewJob(jobOf(ctx, SATURDAY), { turn });
    assert.deepEqual(r.messages, []);
    assert.equal(r.note, "今天不是周五:AI 周报只在周五写");
    assert.equal(turn.n(), 0);
    assert.deepEqual(ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? [], []);
  } finally { ctx.cleanup(); }
});

test("这一周已经有版本:不再写第二版;手动运行才照写", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    ledgerInsertMany(ctx, { kind: "shortline_weekly_review", records: [{
      date: "2026-10-09", week_start: "2026-10-05", days: ["2026-10-08", "2026-10-09"], settled: true, ai: "手点的那一版",
      sections: [{ id: "trend", label: "情绪走势", status: "done", text: "旧版正文", evidence_count: 1 }],
    }] });
    const turn = fakeTurn();
    const r = await weeklyReviewJob(jobOf(ctx), { turn });
    assert.deepEqual(r.messages, []);
    assert.match(r.note!, /2026-10-05 起这一周已经有 1 版 AI 周报,今天不再写/);
    assert.equal(turn.n(), 0, "没调模型");
    assert.equal((ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? []).length, 1);

    const manual = await weeklyReviewJob(jobOf(ctx, FRIDAY, true), { turn });
    assert.equal(manual.messages.length, 1);
    assert.ok(turn.n() > 0);
    assert.equal((ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? []).length, 2, "手动运行照写一版");
  } finally { ctx.cleanup(); }
});

test("周五正常跑:等它写完才报结果,消息里写清几段写成、合计多少字、去哪看", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const turn = fakeTurn();
    const r = await weeklyReviewJob(jobOf(ctx), { turn });
    assert.equal(r.messages.length, 1);
    const m = r.messages[0]!;
    assert.equal(m.title, "AI 周报 2026-10-05 这一周已写完并存档");
    assert.equal(m.link, "/shortline/weekreview");
    assert.equal(m.dedupeKey, "weekly_ai:2026-10-05");
    // 本周没有明日验证条件 ⇒ 验证回看那一段是 skipped:消息里必须说清哪段跳了,不能只说「写完了」
    assert.match(m.lines[0]!, /写到 2026-10-09;3 段写成了,1 段跳过\(验证回看\),合计 \d+ 字/);
    assert.match(m.lines[1]!, /资料包(有 \d+ 处缺口|没有缺口)/);
    assert.match(m.lines[2]!, /台账里/);

    // 落到台账就算写成:与页面上点「开始写」得到的是同一张表
    const saved = ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? [];
    assert.equal(saved.length, 1);
    assert.deepEqual([saved[0]!.date, saved[0]!.week_start], ["2026-10-09", "2026-10-05"]);
    assert.equal(r.note, "2026-10-05 起这一周的 AI 周报已存档");

    // 再跑一次(定时路径)不会再写
    const again = await weeklyReviewJob(jobOf(ctx), { turn });
    assert.deepEqual(again.messages, []);
    assert.equal((ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? []).length, 1);
  } finally { ctx.cleanup(); }
});

test("本周一天数据都没有:抛错(任务状态要说「没写成」,不能报成功)", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ ...CFG, daily: {} });
    await assert.rejects(weeklyReviewJob(jobOf(ctx), { turn: fakeTurn() }),
      (e: unknown) => e instanceof ServiceError && e.code === "no_data" && /一天都没取到/.test(e.message));
    assert.deepEqual(ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? [], []);
  } finally { ctx.cleanup(); }
});

test("没接 AI:只写一句、不抛错(抛错会被重试三次再进收件箱)", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const r = await weeklyReviewJob(jobOf(ctx));
    assert.deepEqual(r.messages, []);
    assert.match(r.note!, /^没写:/);
    assert.match(r.note!, /AI 来源/);
    assert.deepEqual(ledgerList(ctx, "shortline_weekly_review").shortline_weekly_review ?? [], []);
  } finally { ctx.cleanup(); }
});
