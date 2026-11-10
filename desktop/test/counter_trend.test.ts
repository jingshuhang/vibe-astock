// 逆市候选：环境关闭时的第二视图。断言「只加信息、不放宽闸门」与严格证据门槛。
// 数字全部取自 2026-11-10 实机 /view/shortline_samples?date=2026-11-10&days=90（24 个交易日）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildCounterTrend, counterTrendSummary, qualifyCell, safeRegime, strategyFor,
  CT_MIN_SAMPLE, CT_MIN_WIN_RATE, CT_DISCLAIMER,
} from "../src/verticals/finance/shortline/counterTrend.ts";
import type { Regime, SamplesResult, Stats, StrategyResult } from "../src/verticals/finance/shortline/viewTypes.ts";
import type { ShortlineOpportunityResult, StockOpportunity } from "../src/verticals/finance/lib/shortlineOpportunities.ts";

const REGIMES: Regime[] = ["情绪强", "情绪中", "情绪弱", "环境未覆盖"];
const S = (sample: number, win: number | null, avg: number | null): Stats => ({
  sample, win_rate: win, avg, median: avg == null ? null : avg - 0.5,
  best: null, worst: avg == null ? null : -10, limit_up_rate: 0.2,
});
const cells = (over: Partial<Record<Regime, Stats>>): Record<Regime, Stats> => {
  const out = {} as Record<Regime, Stats>;
  for (const r of REGIMES) out[r] = over[r] ?? S(0, null, null);
  return out;
};
const strat = (name: string, by: Partial<Record<Regime, Stats>>): StrategyResult => ({
  name, desc: name, overall: S(0, null, null), by_regime: cells(by), daily: [], final_equity: 100,
});

// 实机 24 日 by_regime，逐格抄数
const REAL_STRATEGIES: StrategyResult[] = [
  strat("首板打板", {
    情绪强: S(530, 0.572, 1.53), 情绪中: S(301, 0.445, 0.33),
    情绪弱: S(230, 0.578, 1.94), 环境未覆盖: S(47, 0.468, 0.60),
  }),
  strat("连板接力", {
    情绪强: S(104, 0.548, 2.44), 情绪中: S(80, 0.512, 1.21),
    情绪弱: S(92, 0.467, 0.40), 环境未覆盖: S(10, 0.600, 4.25),
  }),
  strat("高标接力", {
    情绪强: S(34, 0.706, 4.41), 情绪中: S(37, 0.676, 3.74),
    情绪弱: S(31, 0.484, 0.52), 环境未覆盖: S(3, 0.667, 3.33),
  }),
];

const SAMPLES: SamplesResult = {
  date: "2026-11-10", days: 90, layer: "market_phenomenon",
  sample_caveat: "样本 = 前一天收盘还封在涨停板上的票(事后名单)。包含一字板等未必买得进的票;收益按前收→今收等权,没有成交模拟,不能推出真实收益或打法期望。这是市场现象统计,不是策略回测。",
  available: true, reason: null, days_used: 24, date_from: "2026-09-30", date_to: "2026-11-09",
  missing_days: ["2026-06-30"], unsettled_days: ["2026-11-10"],
  regime_cuts: { low: 170, high: 267.1 }, seal_curve: [], strategies: REAL_STRATEGIES,
  generated_at: "2026-11-10T14:00:00+08:00",
  gaps: ["65 个交易日的涨停样本没取到,已剔除"],
  source: "cn_shortline_settled",
};

const opp = (code: string, boards: number, seal_time: string | null = "093000"): StockOpportunity => ({
  code, name: `票${code}`, sector: "汽车零部", boards, seal_time, tags: [], pattern: null,
  limit_price: 10, change_pct: 10, float_cap_yi: 50, turnover_yi: 5, seal_amount_yi: 1,
  open_count: 0, note: "",
});
const OPPS = (list: StockOpportunity[], phase = "修复期"): ShortlineOpportunityResult => ({
  date: "2026-11-10", clock: "14:12:00", status: "partial", phase,
  limit_up_count: list.length, broken_rate: 0.292, seal_rate: 0.708,
  opportunities: list, by_sector: {}, main_sectors: ["汽车零部", "通用设备"],
  gaps: [], notes: [], source: "test",
});
const run = (list: StockOpportunity[], phase = "修复期", samples: SamplesResult | null = SAMPLES) =>
  buildCounterTrend({ opps: OPPS(list, phase), samples, phase });

test("[行为] 严格门槛：修复期→情绪中，只有「高标接力」过线，首板/连板不进清单", () => {
  const v = run([opp("000001", 1), opp("000002", 1), opp("000003", 2), opp("000004", 3)]);
  assert.equal(v.regime, "情绪中");
  assert.equal(v.status, "ok");
  assert.deepEqual(v.rows.map((r) => r.code), ["000004"], "只有 3 板票落在 +3.74% 那个格子");
  assert.equal(v.rows[0]!.strategy, "高标接力");
  assert.equal(v.rows[0]!.stats.sample, 37);
  assert.equal(v.rejected.length, 2);
  assert.match(v.rejected.find((r) => r.strategy === "首板打板")!.reason, /胜率 44\.5% < 55%/);
  assert.match(v.rejected.find((r) => r.strategy === "连板接力")!.reason, /胜率 51\.2% < 55%/);
});

test("[行为] 环境换成情绪弱：首板打板过线、高标不过线 —— 结论随数据变，不是写死", () => {
  const v = run([opp("000001", 1), opp("000004", 3)], "冰点期");
  assert.equal(v.regime, "情绪弱");
  assert.deepEqual(v.rows.map((r) => r.code), ["000001"]);
  assert.equal(v.rows[0]!.stats.sample, 230);
  assert.match(v.rejected.find((r) => r.strategy === "高标接力")!.reason, /胜率 48\.4% < 55%/);
});

test("[行为] 排序按格子均值降序，不引入第二个主观分", () => {
  const v = run([opp("000001", 1), opp("000003", 2), opp("000004", 3)], "主升期");
  assert.equal(v.regime, "情绪强");
  assert.deepEqual(v.rows.map((r) => r.code), ["000004", "000001"], "高标 +4.41% 排在首板 +1.53% 前");
  assert.equal(v.rejected.find((r) => r.strategy === "连板接力")!.reason, "胜率 54.8% < 55%");
});

test("[行为] 首封时间不参与分档：两只首板票首封不同，必须落在同一个格子", () => {
  const v = run([opp("000001", 1, "092500"), opp("000002", 1, "144500")], "冰点期");
  assert.equal(v.rows.length, 2, "情绪弱·首板打板过线，两只都要在");
  assert.deepEqual(new Set(v.rows.map((r) => r.strategy)), new Set(["首板打板"]),
    "seal_time 是首封、samples 的早封是最后封板，口径不等价，不能混用");
});

test("[行为] 小样本格子标「待验证」，不因为均值漂亮就放行", () => {
  const v = run([opp("000004", 3)], "混沌期");
  assert.equal(v.regime, "环境未覆盖");
  assert.equal(v.status, "no_qualified_cell");
  assert.equal(v.rows.length, 0);
  assert.match(v.rejected.find((r) => r.strategy === "高标接力")!.reason, /样本 3 < 30，待验证/);
  assert.ok(v.gaps.some((g) => /市场相位没取到或不在已知档位/.test(g)), "未知相位要显式留缺口");
});

test("[行为] 样本没取到 → failed + 留白，不许把空清单写成「今天没有逆市机会」", () => {
  const v = buildCounterTrend({ opps: OPPS([opp("000004", 3)]), samples: null, phase: "修复期", samplesWhy: "样本端点超时" });
  assert.equal(v.status, "failed");
  assert.equal(v.rows.length, 0);
  assert.ok(v.gaps.some((g) => /样本端点超时/.test(g)));
  assert.ok(v.gaps.some((g) => /没取到不等于/.test(g)));
  const failed: SamplesResult = { ...SAMPLES, available: false, reason: "没数据" };
  assert.equal(buildCounterTrend({ opps: OPPS([opp("000004", 3)]), samples: failed, phase: "修复期" }).status, "failed");
});

test("[行为] 口径说明必须随结果带出：不是打板收益、不是买卖建议、regime 映射未回测", () => {
  const v = run([opp("000004", 3)]);
  assert.equal(v.disclaimer, CT_DISCLAIMER);
  assert.match(v.disclaimer, /不是买卖建议/);
  assert.match(v.disclaimer, /闸门结论仍以验证流为准/);
  assert.match(v.caveat, /一字板/);
  assert.match(v.caveat, /不是策略回测/);
  assert.match(v.regime_note, /未经回测/);
  assert.match(v.regime_note, /不是同一维度/);
  assert.equal(v.window, "2026-09-30 ~ 2026-11-09");
  assert.equal(v.sample_days, 24);
  assert.ok(v.gaps.some((g) => /65 个交易日/.test(g)), "样本自身的缺口要透传");
});

test("[行为] AI 摘要与页面同源：带免责、失败时不说「没有逆市机会」", () => {
  const ok = counterTrendSummary(run([opp("000004", 3)]));
  assert.match(ok, /000004/);
  assert.match(ok, /n=37/);
  assert.match(ok, /不是买卖建议/);
  const failed = counterTrendSummary(buildCounterTrend({ opps: OPPS([]), samples: null, phase: "修复期" }));
  assert.match(failed, /没取到/);
  assert.match(failed, /不是今天没有逆市机会/);
  assert.equal(counterTrendSummary(null), "逆市候选:还在取数");
});

test("[纯函数] 门槛常量与安全映射", () => {
  assert.equal(CT_MIN_SAMPLE, 30);
  assert.equal(CT_MIN_WIN_RATE, 0.55);
  assert.equal(strategyFor(0), "首板打板");
  assert.equal(strategyFor(2), "连板接力");
  assert.equal(strategyFor(9), "高标接力");
  assert.equal(safeRegime("修复期").regime, "情绪中");
  assert.equal(safeRegime("乱写的").regime, "环境未覆盖", "不许悄悄落到情绪强");
  assert.equal(safeRegime(null).gap !== null, true);
  assert.equal(qualifyCell(S(37, 0.676, 3.74)), null);
  assert.match(qualifyCell(S(301, 0.72, -0.5))!, /不为正/);
  assert.match(qualifyCell(S(10, 0.9, 9))!, /待验证/);
  assert.match(qualifyCell(null)!, /没有这个格子/);
});

test("[结构] 闸门结论仍在、判据本体不动；叠加层只在闸门关闭时介入", () => {
  const src = readFileSync(new URL("../src/verticals/finance/shortline/opportunityVerify.ts", import.meta.url), "utf8");
  assert.match(src, /tone === "danger"[\s\S]{0,300}call: "回避"/, "环境关闭时 verifyOpportunities 仍全部回避(判据本体未改)");
  assert.match(src, /!v\.gateClosed/, "叠加层必须显式检查闸门关闭,不许靠 tone 反推");
  assert.match(src, /gateClosed: closed/, "闸门标记要从同一个 closed 局部变量带出,不另算一套");
  const page = readFileSync(new URL("../src/verticals/finance/pages/ShortlineOpportunities.tsx", import.meta.url), "utf8");
  assert.match(page, /CounterTrendCard/, "新视图是并列新增的一块");
  assert.match(page, /counterTrendSummary/, "AI 上下文要带同一份摘要");
  assert.match(page, /phase:\s*verify\?\.phase/, "环境档必须取市场状态页的 MarketPhase");
  assert.doesNotMatch(page, /phase:\s*data\?\.phase/, "机会页的封板率派生相位不是同一套标签,不能拿来查 regime");
  assert.match(page, /mergeCounterTrendCalls/, "逆市改判叠加层要接进页面");
  assert.match(page, /displayVerify\.tagged/, "清单要渲染叠加后的档位,不能还是全回避");
  assert.match(page, /<VerifyCard v=\{displayVerify\}/, "验证流卡片仍收同一份闸门结论(head 由展开保留)");
  assert.match(page, /counterTrendNote/, "改判要在验证流卡片里显式说明");
  assert.match(page, /rejudged=\{ctRejudged\}/, "逆市候选文案要跟着改判只数走");
  assert.doesNotMatch(page, /清单照旧全部回避/, "叠加层已上线,这句过期文案不许回来");
});
