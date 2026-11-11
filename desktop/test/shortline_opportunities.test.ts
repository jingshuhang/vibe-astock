// 超短线机会发现 · 验证流:盯盘三页(实时动态 / 市场实时概况 / 竞价与盘中路径)的动态结论盖到机会清单上。
// 规则在 shortline/opportunityVerify.ts,这里断言语义不变量:环境反对时一律回避、佐证不足时不给倾向、
// 裁决理由必须能对着页面读数复核。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { IntradayResult, LadderWatchRow, LiveCounts, Snapshot, TierStat, WatchView } from "../src/verticals/finance/shortline/watchTypes.ts";
import type { ShortlineOpportunityResult, StockOpportunity } from "../src/verticals/finance/lib/shortlineOpportunities.ts";
import type { MarketStateResult } from "../src/verticals/finance/lib/marketState.ts";
import type { CounterTrendResult } from "../src/verticals/finance/shortline/counterTrend.ts";

const DIR = "/src/verticals/finance/shortline";
const PAGE = "/src/verticals/finance/pages/ShortlineOpportunities.tsx";

// ─── 机会发现层的清单(后端 shortline_opportunities 的输出形状) ─────────────────
const opp = (code: string, name: string, boards: number, type: NonNullable<StockOpportunity["pattern"]>["type"], confidence: number): StockOpportunity => ({
  code, name, sector: "算力", boards, seal_time: "09:31", tags: ["算力"],
  pattern: { type, confidence, trigger: `${type}触发`, risk: type === "龙头接力" ? "高" : "中" },
  limit_price: 11, change_pct: 10, float_cap_yi: 40, turnover_yi: 5, seal_amount_yi: 1.2, open_count: 0, note: `${type}触发`,
});
const OPPS: ShortlineOpportunityResult = {
  date: "2026-10-30", clock: "14:05", phase: "分歧", limit_up_count: 55, broken_rate: 0.29, seal_rate: 0.7,
  opportunities: [
    opp("600001", "首板A", 1, "首板爆发", 65),
    opp("600002", "高位B", 5, "龙头接力", 60),
    opp("600003", "转强C", 2, "弱转强", 75),
    opp("600004", "首板D", 1, "首板爆发", 80),
  ],
  by_sector: {}, main_sectors: ["算力"], notes: [], source: "em_zt_pool",
};

// ─── 盘中路径(竞价与盘中路径页的数据) ─────────────────────────────────────────
const tiers = (hiMedian: number, firstMedian: number): Record<string, TierStat> => ({
  首板: { sample: 30, avg: firstMedian + 0.2, median: firstMedian, up_rate: firstMedian > 0 ? 0.6 : 0.4 },
  "3板及以上": { sample: 4, avg: hiMedian, median: hiMedian, up_rate: hiMedian > 0 ? 0.8 : 0.25 },
});
const counts = (over: Partial<LiveCounts>): LiveCounts => ({
  limit_up: 55, broken: 15, limit_down: 5, highest_board: 6, consec_count: 5,
  seal_rate: 0.85, broken_rate: 0.15, promotion_1to2: 0.3, promotion_all: 0.4, ...over,
});
const snapOf = (slot: Snapshot["slot"], median: number, live: Snapshot["live"], byTier: Record<string, TierStat>): Snapshot => ({
  schema: 1, date: "2026-10-30", slot, captured_at: "", clock: `${slot}:20`, drift_minutes: 0,
  basis: slot === "09:25" ? "open" : "latest", prev_date: "2026-10-29",
  cohort: { expected: 43, sample: 42, coverage_rate: 0.98, avg: median + 0.3, median, up_count: 25, down_count: 17, up_rate: 0.6, deep_loss_5: 2, by_tier: byTier, top_board_level: 6, top_boards: [] },
  live, ...(live ? {} : { live_reason: "集合竞价阶段还没有涨停池" }), gaps: [],
});
const intraOf = (slots: IntradayResult["slots"], auction: Snapshot | null): IntradayResult => ({
  date: "2026-10-30", today: true, trading_day: true, slots, auction, auction_reason: auction ? null : "没有竞价快照",
  checks: { set_date: null, items: [] }, warnings: [], gaps: [], basis_labels: { open: "开盘价口径", latest: "最新价口径" }, source: "腾讯", generated_at: "",
});
/** 退潮:封板率 91.7% → 60.3%、跌停 25 → 82、高位板竞价中位 -5.3% —— 三盏灯全报警 */
const EBB = intraOf(
  [
    { slot: "09:35", window_end: "09:43", state: "saved", reason: null, snapshot: snapOf("09:35", -1, counts({ seal_rate: 0.917, limit_down: 25 }), tiers(3, 1)) },
    { slot: "14:00", window_end: "14:08", state: "saved", reason: null, snapshot: snapOf("14:00", -2, counts({ seal_rate: 0.603, limit_down: 82, broken: 23 }), tiers(3, 1)) },
  ],
  snapOf("09:25", -1, null, tiers(-5.3, 0.9)),
);
/** 健康:封板率稳、跌停个位数、高位板也高开 */
const HEALTHY = intraOf(
  [
    { slot: "09:35", window_end: "09:43", state: "saved", reason: null, snapshot: snapOf("09:35", 1.5, counts({ seal_rate: 0.85, limit_down: 3 }), tiers(5, 1)) },
    { slot: "14:00", window_end: "14:08", state: "saved", reason: null, snapshot: snapOf("14:00", 1.8, counts({ seal_rate: 0.9, limit_down: 5 }), tiers(5, 1)) },
  ],
  snapOf("09:25", 1.5, null, tiers(5, 1)),
);
/** 高位断、低位还行:只改竞价分板位 —— 3板以上中位 -5.3%、首板 +0.9% */
const SPLIT = intraOf(HEALTHY.slots, snapOf("09:25", 1, null, tiers(-5.3, 0.9)));

// ─── 实时动态(昨日梯队承接) ──────────────────────────────────────────────────
const lad = (code: string, pct: number | null, at_limit: boolean | null) => ({
  code, name: code, price: pct == null ? null : 10, pct, amount_yuan: 1e8, quote_time: "20261030100130", today: true,
  boards: 1, label: "首板", sector: "算力", at_limit,
});
const watchOf = (rows: LadderWatchRow[]): WatchView => ({
  date: "2026-10-30", clock: "10:01", phase: "morning", phase_label: "上午", trading_day: true, detecting: true, poll_ms: 3000, quote_day: "2026-10-30",
  holdings: [], watchlist: [],
  ladder: { sample_date: "2026-10-29", quote_date: "2026-10-30", highest: 6, rows },
  turnover: null, bigcap: null, alerts: [], notes: [], rules: { surge_pct: 1.5, window_min: 3, cooldown_min: 5 }, source: "腾讯",
});
const LADDER_OK = watchOf([lad("600825", 10, true), lad("002001", 2, false), lad("600000", 1, false)]);
const LADDER_DEAD = watchOf([lad("600825", -8, false), lad("002001", -3, false), lad("600000", -1, false)]);

// ─── 市场状态(市场实时概况页与「市场状态」页同一份) ──────────────────────────
const dim = { score: null, weight: null };
const mktOf = (over: Partial<MarketStateResult["signal"]>): MarketStateResult => ({
  date: "2026-10-30", clock: "15:00",
  signal: {
    composite: 36, phase: "退潮期", base_phase: "退潮期", position_cap_pct: 0, can_open_position: false,
    risk_level: "high", emotion_score: 46, dragon_score: 55, risk_score: 15, earning_score: 19, event_score: 58,
    unavailable: null, sources: [], notes: [], gate_blockers: ["大盘广度 15% 低于 55%"], derived_at: "",
    ...over,
  },
  dimensions: { emotion: dim, dragon: dim, risk: dim, earning: dim, event: dim },
  recommendation: { action: "观望", confidence: 60, position_range: "0%", reason: "" },
  notes: [],
});
const MKT_CLOSED = mktOf({});
const MKT_OPEN = mktOf({ phase: "主升期", position_cap_pct: 100, can_open_position: true, gate_blockers: [], composite: 72 });

/** 逆市候选（实机 24 日「高标接力·情绪中」格子） */
const ctOf = (codes: string[], status: CounterTrendResult["status"] = "ok"): CounterTrendResult => ({
  status, regime: "情绪中",
  rows: codes.map((code) => ({
    code, name: `票${code}`, sector: "算力", boards: 3, strategy: "高标接力", regime: "情绪中",
    stats: { sample: 37, win_rate: 0.676, avg: 3.74, median: 9.98, best: 20, worst: -10.02, limit_up_rate: 0.541 },
  })),
  rejected: [], sample_days: 24, window: "2026-09-30 ~ 2026-11-09",
  caveat: "市场现象统计", gaps: [], disclaimer: "不是买卖建议", regime_note: "未回测",
});

test("验证流:仓位上限 0 时环境关闭,清单一只不留地全部回避(模式再漂亮也是接盘)", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_CLOSED });
  assert.equal(v.known, true);
  assert.equal(v.head, "环境关闭，不加");
  assert.equal(v.tone, "danger");
  assert.match(v.note, /仓位上限压到 0/);
  assert.equal(v.counts.回避, 4);
  assert.equal(v.counts.支持, 0);
  for (const t of v.tagged) assert.equal(t.call, "回避", t.opp.code);
  // 市场状态闸门那条佐证要能追溯到来源页,读数带上限
  const gate = v.gates.find((g) => g.key === "mktstate");
  assert.equal(gate?.from, "盯盘 · 市场实时概况");
  assert.match(gate!.read, /仓位上限 0%/);
  assert.match(gate!.why, /广度/);
});

test("验证流:上限 20% 但信号不给开新仓时,逐股佐证不许把上限写成 0%(2026-11-10 实机)", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({
    opps: OPPS, intra: EBB, watch: LADDER_OK,
    mkt: mktOf({
      composite: 75, position_cap_pct: 20, can_open_position: false,
      gate_blockers: ["量能 -9.6% vs 20日均额,需 ≥+10%", "上证 3667.48 ≤ MA20 3679.81"],
    }),
  });
  assert.equal(v.head, "环境关闭，不加", "closed 优先于判断条,裁决不变");
  assert.equal(v.counts.回避, 4, "上限 20% 仍不给开新仓,全回避是判据的正确执行");
  assert.equal(v.counts.支持, 0);
  for (const t of v.tagged) {
    assert.equal(t.call, "回避", t.opp.code);
    assert.doesNotMatch(t.why, /仓位上限 0%/, `${t.opp.code} 别把 20% 编成 0%`);
    assert.match(t.why, /仓位上限 20%/, t.opp.code);
  }
  const gate = v.gates.find((g) => g.key === "mktstate");
  assert.match(gate!.read, /仓位上限 20%/, "顶部佐证读数与逐股文案必须同口径");
});

// ─── 逆市改判叠加层：环境关闭时给区分度，但不推翻大盘闸门 ──────────────────────
test("逆市改判:只有落在正期望格子的票从回避改判观察,其余仍回避", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_CLOSED });
  assert.equal(v.counts.回避, 4);
  const out = r.mergeCounterTrendCalls(v, ctOf(["600002", "600004"]));
  assert.notStrictEqual(out, v);
  assert.equal(out.counts.观察, 2);
  assert.equal(out.counts.回避, 2);
  const callOf = (code: string) => out.tagged.find((t) => t.opp.code === code)!.call;
  assert.equal(callOf("600002"), "观察");
  assert.equal(callOf("600004"), "观察");
  assert.equal(callOf("600001"), "回避");
  assert.equal(callOf("600003"), "回避");
});

test("逆市改判:大盘闸门结论一字不动,原始验证流不许被就地改写", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_CLOSED });
  const out = r.mergeCounterTrendCalls(v, ctOf(["600002"]));
  assert.equal(out.head, v.head);
  assert.equal(out.note, v.note);
  assert.equal(out.tone, v.tone);
  assert.equal(out.known, v.known);
  assert.equal(out.phase, v.phase);
  assert.deepEqual(out.gates, v.gates);
  assert.equal(v.counts.回避, 4, "原对象仍应是全回避");
  assert.equal(v.counts.观察, 0);
});

test("逆市改判:理由写明闸门外、不是放行也不是建议,并带格子的真实数字", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_CLOSED });
  const out = r.mergeCounterTrendCalls(v, ctOf(["600002"]));
  const why = out.tagged.find((t) => t.opp.code === "600002")!.why;
  assert.match(why, /逆市观察（闸门外）/);
  assert.match(why, /n=37/);
  assert.match(why, /胜率 68%/);
  assert.match(why, /均值 3\.74%/);
  assert.match(why, /最差 -10\.02%/);
  assert.match(why, /大盘闸门仍判/);
  assert.match(why, /这不是放行也不是建议/);
  assert.equal(out.tagged[0]!.opp.code, "600002", "观察要排到回避前面");
});

test("逆市改判:样本没取到 / 没格子过线 / 没有票命中,一律原样返回", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_CLOSED });
  assert.strictEqual(r.mergeCounterTrendCalls(v, null), v);
  assert.strictEqual(r.mergeCounterTrendCalls(v, ctOf(["600002"], "failed")), v);
  assert.strictEqual(r.mergeCounterTrendCalls(v, ctOf(["600002"], "no_qualified_cell")), v);
  assert.strictEqual(r.mergeCounterTrendCalls(v, ctOf([])), v);
  assert.strictEqual(r.mergeCounterTrendCalls(v, ctOf(["999999"])), v);
  assert.strictEqual(r.mergeCounterTrendCalls(null, ctOf(["600002"])), null);
});

test("逆市改判:闸门没关时一律不介入 —— 用户要的是「哪怕环境关闭」,闸门开着就不叫逆市", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const open = r.verifyOpportunities({ opps: OPPS, intra: HEALTHY, watch: LADDER_OK, mkt: MKT_OPEN });
  assert.equal(open.gateClosed, false);
  const nonAvoid = open.tagged.find((t) => t.call !== "回避");
  assert.ok(nonAvoid, "健康环境里应该有非回避档位");
  assert.strictEqual(r.mergeCounterTrendCalls(open, ctOf(["600002"])), open, "闸门开着,整层原样返回");
});

test("逆市改判:盘中判断条报警但闸门没关,不许靠 tone=danger 反推闸门", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_OPEN });
  assert.equal(v.head, "退潮中，不加");
  assert.equal(v.tone, "danger", "这次是判断条报警,不是市场状态闸门关了");
  assert.equal(v.gateClosed, false);
  assert.equal(v.counts.回避, 4);
  assert.strictEqual(r.mergeCounterTrendCalls(v, ctOf(["600002", "600004"])), v,
    "不能因为整页 danger 就把弱票贴上「逆市观察（闸门外）」——闸门根本没关");
});

test("逆市改判:市场状态没取到时不猜闸门,叠加层不介入", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: null });
  assert.equal(v.gateClosed, false, "闸门状态未知 ≠ 闸门关闭");
  assert.strictEqual(r.mergeCounterTrendCalls(v, ctOf(["600002"])), v);
});

test("逆市改判:只改回避,不把本来已判支持的票降级或覆盖", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_CLOSED });
  // 闸门关闭下真实实现是「全部回避」;这里手工混入一档非回避,专测叠加层的作用域不变量。
  const mixed = {
    ...v,
    tagged: v.tagged.map((t, i) => i === 0 ? { ...t, call: "支持" as const } : t),
  };
  const supported = mixed.tagged[0]!;
  const avoid = mixed.tagged.find((t) => t.call === "回避")!;
  assert.notEqual(supported.opp.code, avoid.opp.code, "两只必须是不同标的,别把同一只既当支持又当命中");
  const out = r.mergeCounterTrendCalls(mixed, ctOf([supported.opp.code, avoid.opp.code]));
  assert.equal(out.tagged.find((t) => t.opp.code === supported.opp.code)!.call, "支持", "已判支持的不许被覆盖");
  assert.equal(out.tagged.find((t) => t.opp.code === avoid.opp.code)!.call, "观察", "命中的回避票照常改判");
});

test("验证流带出市场状态相位,供逆市候选查同一份环境档", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: mktOf({ phase: "修复期" }) });
  assert.equal(v.phase, "修复期", "必须是 MarketPhase,不是机会页按封板率派生的「强势/温和/分歧/震荡」");
  const none = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: null });
  assert.equal(none.phase, null, "市场状态没取到就留空,不拿别处的标签顶上");
});

test("验证流:判断条能给结论时抄它的 head,不另造词 —— 两页看到的是同一句话", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  // 上限不设(市场状态没压),但盘中判断条三灯全报警
  const v = r.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_OPEN });
  assert.equal(v.head, "退潮中，不加", "必须和竞价与盘中路径页的判断条一字不差");
  assert.equal(v.tone, "danger");
  assert.match(v.note, /跌停家数/);
  // 三盏灯原样进佐证清单(不是重算,是同一个对象)
  const labels = v.gates.filter((g) => g.key.startsWith("lamp_")).map((g) => g.label);
  assert.deepEqual(labels, ["封板率斜率", "跌停家数", "高位板竞价"]);
  assert.ok(v.gates.every((g) => g.key.startsWith("lamp_") || g.from.includes("盯盘")));
  assert.equal(v.counts.回避, 4, "退潮中不加 —— 全部回避");
});

test("验证流:环境健康时按置信度分流,支持/观察各归各;竞价方向只容得下首板时接力类降级", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const callOf = (v: { tagged: { opp: StockOpportunity; call: string }[] }, code: string) =>
    v.tagged.find((t) => t.opp.code === code)!.call;

  // ① 环境健康:置信 ≥70 支持,不够观察(置信度来自实证查表,不再是模式常数)
  const ok = r.verifyOpportunities({ opps: OPPS, intra: HEALTHY, watch: LADDER_OK, mkt: MKT_OPEN });
  assert.equal(ok.head, "没亮红灯", "判断条与验证流同源;不再空指一份不存在的清单");
  assert.equal(callOf(ok, "600002"), "支持", "高标B 5板·主升期历史胜率 73.1%,≥70");
  assert.equal(callOf(ok, "600004"), "观察", "首板D 秒板+共振=68,主升期首板基线 54.8% 卡在 70 下");
  assert.equal(callOf(ok, "600001"), "观察", "首板A 同 68");
  assert.equal(callOf(ok, "600003"), "观察", "转强C 2板·连板 62.9% = 63");
  // 清单按裁决排序:支持在前(高标B)
  assert.equal(ok.tagged[0]!.opp.code, "600002");

  // ② 高位崩、低位还行 → 竞价方向「只做首板」:高位与接力类降级,首板不受竞价方向压制(按查表值分流)
  const split = r.verifyOpportunities({ opps: OPPS, intra: SPLIT, watch: LADDER_OK, mkt: MKT_OPEN });
  assert.equal(split.head, "分化，选方向");
  assert.equal(callOf(split, "600002"), "降级", "5 板龙头接力,高位板竞价中位 -5.3%");
  assert.match(split.tagged.find((t) => t.opp.code === "600002")!.why, /高位板竞价 中位/);
  assert.equal(callOf(split, "600003"), "降级", "弱转强也是接力类,竞价方向只容得下首板");
  assert.equal(callOf(split, "600004"), "观察", "首板D 不受竞价方向压制,但查表 68<70 观察");
  assert.equal(callOf(split, "600001"), "观察", "首板A 秒板+共振=68,主升期基线卡在 70 下(诚实:首板赛道最挤)");
});

test("验证流:昨日梯队没承接时接力类降级(实时动态页的读数);佐证全缺时不给倾向、个股全部观察", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts"));
  const callOf = (v: { tagged: { opp: StockOpportunity; call: string }[] }, code: string) =>
    v.tagged.find((t) => t.opp.code === code)!.call;

  // ① 昨日涨停今天红盘只有 33%(1/3 只) → 接力类降级,首板不受影响
  const dead = r.verifyOpportunities({ opps: OPPS, intra: HEALTHY, watch: LADDER_DEAD, mkt: MKT_OPEN });
  assert.equal(callOf(dead, "600003"), "降级", "弱转强吃昨日梯队的承接");
  assert.match(dead.tagged.find((t) => t.opp.code === "600003")!.why, /红盘 0%/);
  assert.equal(callOf(dead, "600004"), "观察", "首板爆发不吃昨日承接,查表 68 观察");
  const gate = dead.gates.find((g) => g.key === "ladder");
  assert.equal(gate?.from, "盯盘 · 实时动态");
  assert.equal(gate?.tone, "danger");

  // ② 三页佐证一条都没取到:总裁决不给倾向,个股全部「观察」,佐证清单照实说空
  const none = r.verifyOpportunities({ opps: OPPS, intra: null, watch: null, mkt: null });
  assert.equal(none.known, false);
  assert.equal(none.head, "佐证不足，只看不加");
  assert.equal(none.tone, "unknown");
  assert.equal(none.counts.观察, 4);
  assert.equal(none.gates.length, 0);
  assert.match(none.tagged[0]!.why, /盘中佐证不够/);
});

test("查表置信度:陷阱档压分、板块共振加分、情绪中均值为负回避(全部来自本地 18 日实证)", async () => {
  const r = await withRenderer((x) => x.load(DIR + "/patternPrior.ts"));
  // 修复期 → 情绪中;用市场状态信号的 phase 走一遍完整链路
  const REPAIR = mktOf({ phase: "修复期", position_cap_pct: 100, can_open_position: true, gate_blockers: [], composite: 55 });
  const v = await withRenderer((x) => x.load(DIR + "/opportunityVerify.ts")).then((m) =>
    m.verifyOpportunities({ opps: OPPS, intra: HEALTHY, watch: LADDER_OK, mkt: REPAIR }));
  const callOf = (code: string) => v.tagged.find((t) => t.opp.code === code)!.call;
  // 情绪中·首板历史均值 -0.62(亏钱效应) → 回避,不管模式多漂亮
  assert.equal(callOf("600004"), "回避", "首板D 情绪中均值 -0.62,亏钱效应");
  assert.match(v.tagged.find((t) => t.opp.code === "600004")!.why, /亏钱效应/);
  // 情绪中·高标历史均值 +3.25(不为负) → 不被误伤,落到查表分流(67<70 观察)
  assert.equal(callOf("600002"), "观察", "高标B 情绪中均值 +3.25 不为负,不回避");

  // 陷阱档:同为情绪强·首板·板块内,10:30 封板(53) 显著低于 09:31 秒板(68)
  const sealOf = (seal: string) => r.rescoreOpportunity(
    { ...opp("x", "x", 1, "首板爆发", 0), seal_time: seal },
    { phase: "主升期", mainSectors: ["算力"] });
  const trap = sealOf("10:30"), fast = sealOf("09:31");
  assert.equal(trap.seal_bucket, "10:00-11:00");
  assert.equal(fast.seal_bucket, "开盘秒板");
  assert.ok(trap.confidence < fast.confidence, `陷阱档 ${trap.confidence} 应低于秒板 ${fast.confidence}`);
  assert.ok(fast.confidence - trap.confidence >= 10, "10:00-11:00 陷阱档比秒板低 10 分以上(实证:胜率 -8.7pp)");

  // 板块共振:同为情绪强·首板·秒板,板块内(68) 高于板块外(61)
  const inSector = r.rescoreOpportunity({ ...opp("y", "y", 1, "首板爆发", 0), seal_time: "09:31" }, { phase: "主升期", mainSectors: ["算力"] });
  const outSector = r.rescoreOpportunity({ ...opp("z", "z", 1, "首板爆发", 0), seal_time: "09:31", sector: "白酒" }, { phase: "主升期", mainSectors: ["算力"] });
  assert.equal(inSector.in_main_sector, true);
  assert.equal(outSector.in_main_sector, false);
  assert.ok(inSector.confidence > outSector.confidence, `板块内 ${inSector.confidence} 应高于板块外 ${outSector.confidence}`);
  // 证据里必须带读数(样本量/胜率/均值)和风险侧,不能只给一个裸分
  assert.match(inSector.evidence, /n=\d+/);
  assert.match(inSector.evidence, /历史胜率/);
  assert.match(inSector.risk_note, /非正收益/);
});

test("验证流界面:总裁决大字、每条佐证带来源页、裁决计数;档位明说不是买卖建议", async () => {
  await withRenderer(async (r) => {
    const mod = await r.load(DIR + "/opportunityVerify.ts");
    const { VerifyCard } = await r.load(PAGE);
    const v = mod.verifyOpportunities({ opps: OPPS, intra: EBB, watch: LADDER_OK, mkt: MKT_CLOSED });
    const t = textOf(r.html(VerifyCard, { v, loading: false, why: null }));
    assert.match(t, /验证流 · 盯盘三页的结论盖到清单上/);
    assert.match(t, /现在做不做 环境关闭，不加/);
    assert.match(t, /盯盘 · 市场实时概况 市场状态闸门 综合 36 · 退潮期 · 仓位上限 0%/);
    assert.match(t, /盯盘 · 竞价与盘中路径 跌停家数 25 → 82 家/);
    assert.match(t, /盯盘 · 实时动态 昨日梯队承接 红盘 100%（3\/3 只）/);
    assert.match(t, /0 支持 · 0 观察 · 0 降级 · 4 回避/);
    assert.match(t, /档位说的是「环境对这个模式的态度」,不是买卖建议/);
    // 佐证一条没回来:不编,直说
    assert.match(textOf(r.html(VerifyCard, { v: null, loading: false, why: "盯盘三页的佐证都没取到(清单本身不受影响)" })),
      /盯盘三页的佐证都没取到/);
  });
});
