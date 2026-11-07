/**
 * 后台常驻采集(异动不再靠页面带动)。
 *
 * 以前只有「盯盘页在前台」才采:页面切走 / 最小化 / 关掉,那段就一条异动都没有,
 * 而 AI 盯盘拿到的是当天已落盘的全量 —— 它会当成全天的全貌去串逻辑。
 * 这里盯的是:没人看的时候也采、页面在的时候不重复采、两个后台进程不会各采一份。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import type { ServiceContext } from "../src/service.ts";
import { currentPlugin } from "../src/plugin.ts";
import {
  collectorSleepMs, loadAlerts, resetWatchState, shortlineWatchAct, sleepUntilOpen, startAlertCollector, type Phase,
} from "../src/finance/shortline/watch.ts";

const DAY = "2026-10-12";             // 周一
const PREV = "2026-10-09";
const sh = (hms: string, day = DAY) => new Date(`${day}T${hms.length === 5 ? `${hms}:00` : hms}+08:00`);
const signal = new AbortController().signal;

function tmpCtx(): ServiceContext {
  return { repoRoot: process.cwd(), dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-collector-")), python: "python3", node: process.execPath };
}
const clean = (ctx: ServiceContext) => { fs.rmSync(ctx.dataRoot, { recursive: true, force: true }); resetWatchState(); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等到条件成立(采集是异步的,不能只看「等一下就好」) */
async function waitFor(ok: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (ok()) return; await sleep(10); }
}

const key = (c: string) => `${/^6/.test(c) ? "sh" : "sz"}${c}`;
type Q = { price: number; pct?: number; limit_up?: number; time?: string; name?: string; amount_wan?: number };
const quoteEnv = (rows: Record<string, Q>) => ({
  status: "ok",
  evidence: Object.entries(rows).flatMap(([c, q]) => Object.entries({
    price: q.price, change_pct: q.pct ?? 0, limit_up_price: q.limit_up ?? Number((q.price * 1.1).toFixed(2)),
    quote_time: q.time ?? "20261012100000", security_name: q.name ?? `股${c}`, turnover_amount: q.amount_wan ?? 1000,
  }).map(([field, value]) => ({ record_key: key(c), field, value, period: DAY }))),
});
const calEnv = (isToday = true) => ({
  status: "ok",
  evidence: Object.entries({ last_trading_day: isToday ? DAY : PREV, previous_trading_day: PREV, is_today_trading_day: isToday, session_phase: "continuous" })
    .map(([field, value]) => ({ field, value, period: DAY })),
});
const LADDER = [{ code: "600825", name: "新华传媒", boards: 4, label: "4板", sector: "出版" }];

/** 假取数:行情按 prices 表回(prices 可随时改);记下调用 */
function world() {
  const prices: Record<string, Q> = {};
  const calls: { endpoint: string; args?: Record<string, unknown> }[] = [];
  const fetch = async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
    calls.push({ endpoint: req.endpoint, args: req.args });
    if (req.endpoint === "fetch_trade_calendar") return { envelope: calEnv() };
    if (req.endpoint === "cn_shortline_ladder") return { envelope: { status: "ok", evidence: [], extra: { result: { quote_date: req.args!.date, sample_date: PREV, stocks: LADDER, highest: 4 } } } };
    if (req.endpoint === "cn_shortline_turnover_top") return { envelope: { status: "ok", evidence: [], extra: { result: { date: req.args!.date, stocks: [] } } } };
    if (req.endpoint === "cn_shortline_bigcaps") return { envelope: { status: "ok", evidence: [], extra: { result: { date: DAY, count: 0, stocks: [] } } } };
    if (req.endpoint === "tx_quotes_batch") {
      const codes = req.args!.codes as string[];
      return { envelope: quoteEnv(Object.fromEntries(codes.filter((c) => prices[c]).map((c) => [c, prices[c]!]))) };
    }
    throw new Error(`没料到的端点 ${req.endpoint}`);
  };
  return { fetch, calls, prices };
}
const dial = (hms: string) => {
  let t = sh(hms);
  return { clock: () => t, set: (x: string) => { t = sh(x); } };
};
const poll = (ctx: ServiceContext, w: ReturnType<typeof world>, c: ReturnType<typeof dial>) =>
  shortlineWatchAct(ctx, { action: "poll" }, signal, { fetch: w.fetch, clock: c.clock });
const quoteCalls = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.endpoint === "tx_quotes_batch").length;

test("采集节奏:连续竞价 3 秒;竞价 15 秒;午休 1 分钟;盘前和收盘后不采,睡到 09:16", () => {
  assert.deepEqual(
    (["morning", "afternoon", "auction", "closing_auction", "lunch", "pre_open", "closed", "weekend"] as Phase[]).map(collectorSleepMs),
    [3_000, 3_000, 15_000, 15_000, 60_000, 0, 0, 0],
  );
  assert.equal(sleepUntilOpen(sh("08:00")), 76 * 60_000, "盘前 08:00 → 09:16,正好 76 分钟");
  assert.equal(sleepUntilOpen(sh("09:16")), 2 * 3_600_000, "正好 09:16 就已经在竞价里了,不该再睡(走不到这条,真走到也只睡一段)");
  assert.equal(sleepUntilOpen(sh("15:30")), 2 * 3_600_000, "收盘后睡到次日,一次最长两小时,醒了再对表");
  assert.equal(sleepUntilOpen(sh("06:00")), 2 * 3_600_000, "离 09:16 超过两小时就只睡两小时");
});

test("后台采集:页面一次都没请求,异动照样落盘", async () => {
  const ctx = tmpCtx();
  const w = world();
  const c = dial("10:00:00");
  let stop: (() => void) | null = null;
  try {
    w.prices["600825"] = { price: 10, limit_up: 11, time: "20261012100000" };
    await poll(ctx, w, c);                                    // 只为给「封没封」留个基线
    assert.equal(loadAlerts(ctx.dataRoot, DAY).length, 0, "第一次见到只记状态,不报封板");

    w.prices["600825"] = { price: 11, limit_up: 11, time: "20261012100005" };
    c.set("10:00:05");
    stop = startAlertCollector(ctx, { fetch: w.fetch, clock: c.clock, firstDelayMs: 0, sleepMs: () => 10, log: () => {} });

    await waitFor(() => loadAlerts(ctx.dataRoot, DAY).length > 0);
    assert.deepEqual(loadAlerts(ctx.dataRoot, DAY).map((a) => [a.kind, a.code]), [["封板", "600825"]], "页面没来,后台自己采到了");
  } finally { stop?.(); clean(ctx); }
});

test("后台采集和页面请求共用一份:同一拍不重复取行情,也不会把同一条记两遍", async () => {
  const ctx = tmpCtx();
  const w = world();
  const c = dial("10:00:00");
  let stop: (() => void) | null = null;
  try {
    w.prices["600825"] = { price: 10, limit_up: 11, time: "20261012100000" };
    await poll(ctx, w, c);
    w.prices["600825"] = { price: 11, limit_up: 11, time: "20261012100005" };
    c.set("10:00:05");
    stop = startAlertCollector(ctx, { fetch: w.fetch, clock: c.clock, firstDelayMs: 0, sleepMs: () => 10, log: () => {} });
    await waitFor(() => loadAlerts(ctx.dataRoot, DAY).length > 0);

    const taken = quoteCalls(w);
    await sleep(150);                                          // 再空转十几拍:钟没走,2.5 秒内的新鲜结果直接复用
    assert.equal(quoteCalls(w), taken, "钟没走就不重复取行情");
    assert.equal(loadAlerts(ctx.dataRoot, DAY).length, 1);

    c.set("10:00:10");
    await poll(ctx, w, c);                                     // 页面这时才来一次,跑的是同一份状态
    assert.equal(loadAlerts(ctx.dataRoot, DAY).length, 1, "两条路各判一次,同一条异动也只记一遍");
  } finally { stop?.(); clean(ctx); }
});

test("不在采集窗口(盘前 / 已收盘 / 周末)一拍都不发,也不写空文件", async () => {
  for (const hms of ["08:00:00", "15:30:00", "10:00:00"]) {
    const day = hms === "10:00:00" ? "2026-10-10" : DAY;      // 10-10 是周六
    const ctx = tmpCtx();
    const w = world();
    let t = sh(hms, day);
    const clock = () => t;
    const stop = startAlertCollector(ctx, { fetch: w.fetch, clock, firstDelayMs: 0, log: () => {} });
    try {
      await sleep(120);
      assert.equal(w.calls.length, 0, `${day} ${hms} 不该取任何数`);
      assert.equal(fs.existsSync(path.join(ctx.dataRoot, "shortline", "alerts")), false, "不采就不该建异动目录");
      assert.equal(fs.existsSync(path.join(ctx.dataRoot, "shortline", "collector.lock")), false, "不在窗口里连锁都不碰(挂着锁睡一夜会被当成死锁)");
    } finally { stop(); clean(ctx); }
  }
});

test("同一数据目录只让一个进程采:锁在别人手里时一拍都不发,也不许删别人的锁", async () => {
  const ctx = tmpCtx();
  const w = world();
  const c = dial("10:00:00");
  const lockFile = path.join(ctx.dataRoot, "shortline", "collector.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, "另一个后台:1");
  const stop = startAlertCollector(ctx, { fetch: w.fetch, clock: c.clock, firstDelayMs: 0, sleepMs: () => 10, log: () => {} });
  try {
    await sleep(150);
    assert.equal(w.calls.length, 0);
  } finally {
    stop();
    assert.equal(fs.existsSync(lockFile), true, "不是自己抢来的锁,停的时候不许删");
    clean(ctx);
  }
});

test("锁的主人崩了(超过 90 秒没动)就把锁抢过来接着采", async () => {
  const ctx = tmpCtx();
  const w = world();
  const c = dial("10:00:00");
  const lockFile = path.join(ctx.dataRoot, "shortline", "collector.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, "已经死掉的后台:1");
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lockFile, old, old);
  w.prices["600825"] = { price: 10, limit_up: 11, time: "20261012100000" };
  const stop = startAlertCollector(ctx, { fetch: w.fetch, clock: c.clock, firstDelayMs: 0, sleepMs: () => 10, log: () => {} });
  try {
    await waitFor(() => quoteCalls(w) > 0);
    assert.ok(quoteCalls(w) > 0, "旧锁被当成死锁清掉,自己采起来了");
  } finally { stop(); clean(ctx); }
});

test("挂载点:注册后的插件带 onStartup(漏进快照就静默丢掉);VRA_ALERT_COLLECTOR=off 时入口叫了也不起", async () => {
  // 要用 currentPlugin() 而不是原始 FINANCE_PLUGIN:register() 是按显式键集重建的快照对象,
  // 新增字段忘了投影过去的话,入口拿到的就没有这一项 —— 只查原始对象会假绿。
  const p = currentPlugin();
  assert.equal(typeof p.onStartup, "function", "Core 靠 onStartup 起常驻任务,注册后必须还在");
  const ctx = tmpCtx();
  const prev = process.env.VRA_ALERT_COLLECTOR;
  process.env.VRA_ALERT_COLLECTOR = "off";
  try {
    p.onStartup?.(ctx);
    await sleep(200);
    assert.equal(fs.existsSync(path.join(ctx.dataRoot, "shortline")), false, "关掉就一点都不该动");
  } finally {
    if (prev === undefined) delete process.env.VRA_ALERT_COLLECTOR; else process.env.VRA_ALERT_COLLECTOR = prev;
    clean(ctx);
  }
});

test("collector.lock 删不掉时写释放标记 + 告警，下一个采集器立刻接管（不等 90 秒）", async () => {
  const ctx = tmpCtx();
  const w = world();
  const c = dial("10:00:00");
  const lockFile = path.join(ctx.dataRoot, "shortline", "collector.lock");
  const origRm = fs.rmSync;
  const origErr = console.error;
  const errors: string[] = [];
  let second: (() => void) | null = null;
  try {
    // 只拦锁文件本身，别影响 clean() 删临时目录（模拟环境层拦截，不是 dry-run）
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = ((p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && p.endsWith("collector.lock")) throw new Error("SAFE_DELETE_BULK_CONFIRM_REQUIRED");
      return (origRm as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.rmSync;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };

    w.prices["600825"] = { price: 10, limit_up: 11, time: "20261012100000" };
    const first = startAlertCollector(ctx, { fetch: w.fetch, clock: c.clock, firstDelayMs: 0, sleepMs: () => 10, log: () => {} });
    await waitFor(() => fs.existsSync(lockFile) && quoteCalls(w) > 0);
    first();
    assert.equal(fs.readFileSync(lockFile, "utf8"), "released", "删不掉要写释放标记，不是静默留一把活锁");
    assert.ok(errors.some((e) => e.includes("锁文件删不掉")), "降级必须显式告警，不能静默");

    // 恢复删除能力后，下一台采集器要能从 released 残骸里立刻重建
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = origRm;
    c.set("10:00:05");
    const before = quoteCalls(w);
    second = startAlertCollector(ctx, { fetch: w.fetch, clock: c.clock, firstDelayMs: 0, sleepMs: () => 10, log: () => {} });
    await waitFor(() => quoteCalls(w) > before, 1_500);
    assert.ok(quoteCalls(w) > before, "释放标记不能变成新的 90 秒死锁");
  } finally {
    second?.();
    (fs as unknown as { rmSync: typeof fs.rmSync }).rmSync = origRm;
    console.error = origErr;
    clean(ctx);
  }
});
