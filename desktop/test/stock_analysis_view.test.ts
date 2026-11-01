/**
 * 个股分析卡片的展示层(六域读数)。
 *
 * 🔴 这一层最容易犯的错不是排版,是**把没有装成有**:`composite = null` 画成 0 分、
 *    `stage = "数据不足"` 借用「洗盘中」的配色、basic 层没取的字段显示成 0。
 *    所以断言的是「用户到底看到什么字」,不是「组件有没有渲染」。
 * 🔴 另有一条字段对齐:前端读的字段后端必须真的发 —— 少一个就是页面上永远空着的一栏。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { StockAnalysisResult } from "../src/verticals/finance/lib/stockAnalysis.ts";
import { textOf, withRenderer } from "./helpers/render.ts";

const read = (p: string) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

/** 一份「什么都取到了」的结果 */
const full = (over: Partial<StockAnalysisResult> = {}): StockAnalysisResult => ({
  symbol: "600519",
  name: "贵州茅台",
  composite: 62,
  main_capital: {
    score: 58, stage: "主升", confidence: "中",
    advice: "趋势与量能配合,持有为主,跌破 5 日线再评估",
    factors: ["近一日放量", "换手率 0.85%"],
  },
  technical: { trend_score: 70, volume_score: 60, position_score: 55, factors: ["均线多头排列(5>10>20>60)"] },
  kline_data: [],
  quote: {
    symbol: "600519", name: "贵州茅台", close: 1432.5, prev_close: 1400, pct_change: 2.32,
    turnover: 0.85, high: 1440, low: 1398, open: 1402, market_cap: 1.8e12, pe: 21.5,
  },
  money: {
    as_of: "2026-10-30",
    window: { from: "2026-07-31", to: "2026-10-30", n: 60 },
    net_1d: 1573592085.31, net_5d: 1.236e9, net_10d: 2.05e9, net_20d: 8.8e8,
    big_order_5d: 9.82e8, streak: 3, trend: "净流入",
    note: "新浪 MoneyFlow 的 netamount:主力(大单 + 特大单)净流入,60 个交易日逐日累加。",
  },
  valuation: {
    as_of: "2026-10-30",
    window: { from: "2021-11-01", to: "2026-10-30", n: 1210 },
    pe_ttm: 21.5, pb: 7.2, ps_ttm: 10.1,
    pe_percentile: 0.18, pb_percentile: 0.42,
    basis: "过去 1210 个交易日(已剔除停牌日);只算 PE>0 的样本(亏损期 PE 为负,混进来会失真)",
    note: "PE/PB 取自 baostock 的 peTTM / pbMRQ,与东财、同花顺的算法不同,换口径不能和别处的读数比",
  },
  chips: {
    as_of: "2026-10-30",
    window: { from: "2026-02-10", to: "2026-10-30", n: 168 },
    profit_ratio: 0.37, avg_cost: 1302.4, concentration_90: 0.09,
    cost_90: [1180, 1490], cost_70: [1240, 1400], peak_price: 1350,
    price_ref: 1432.5, above_avg_cost: 10,
    note: "三角分布 + 换手衰减模型推算,非交易所数据",
  },
  holders: {
    as_of: "2026-09-30", shareholder_count: 278364, shareholder_count_change_pct: -6.09,
    pledge_ratio: 0.07, pledge_as_of: "2026-10-30",
    lockup_upcoming: 0, lockup_window: "2026-11-01..2027-01-30",
    block_trade_count: 20, block_trade_latest: { date: "2026-10-29", premium_pct: -3.2 },
    holder_trade_latest: { date: "2025-12-30", direction: "增持", change_pct: 0.1 },
  },
  fetched_at: "2026-11-01T15:03:00+08:00",
  from_cache: false,
  gaps: [],
  sufficient: true,
  depth: "full",
  ...over,
});

/** 日 K 只有 20 根、行情也没取到的那一份 */
const thin = (): StockAnalysisResult => full({
  composite: null,
  main_capital: {
    score: null, stage: "数据不足", confidence: "低",
    advice: "日 K 样本或行情没取全,这一栏不给判断;先把日 K 取全再看",
    factors: ["日 K 只有 20 根(要 ≥61)、行情没取到"],
  },
  technical: { trend_score: 50, volume_score: 50, position_score: 50, factors: ["均量不足 21 根,未参与评分"] },
  quote: null,
  money: null,
  valuation: null,
  chips: null,
  holders: null,
  sufficient: false,
  depth: "basic",
  gaps: ["估值历史没取到(baostock 超时)", "筹码分布没取到(东财池为空)", "数据不足以给出可信评分,以下读数请谨慎看待"],
});

const render = async (data: StockAnalysisResult) => withRenderer(async (r) => {
  const mod = await r.load("/src/verticals/finance/components/StockAnalysisPanel.tsx");
  return textOf(r.html(mod.StockAnalysisBody, { data }));
});

test("字段对齐:前端读的每个字段后端都真的发(少一个就是永远空着的一栏)", () => {
  const front = read("../src/verticals/finance/lib/stockAnalysis.ts");
  const back = read("../../orchestrator/src/finance/stock_analysis.ts");
  /** 取一个 interface 的字段名(只看首层,注释先剔掉) */
  const fields = (src: string, name: string): string[] => {
    const m = src.match(new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `找不到 interface ${name}`);
    const body = m[0].replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    return body.split("\n").slice(1, -1)
      .map((l) => l.trim().split(/[?:]/)[0]!.trim())
      .filter((k) => /^[a-z_][\w]*$/i.test(k));
  };
  const pairs: [string, string][] = [
    ["StockAnalysisResult", "StockAnalysisResult"],
    ["StockMainCapital", "MainCapitalStage"],
    ["StockTechnical", "TechnicalFactors"],
    ["StockMoney", "MoneyView"],
    ["StockValuation", "ValuationView"],
    ["StockChips", "ChipsView"],
    ["StockHolders", "HoldersView"],
  ];
  for (const [f, b] of pairs) {
    assert.deepEqual(fields(front, f), fields(back, b), `${f} 与后端 ${b} 的字段必须一一对应`);
  }
});

test("数据齐全:现价、评分、分位、筹码口径、股东户数都在页面上", async () => {
  const t = await render(full());
  assert.match(t, /数据截至 2026-11-01 15:03/);
  assert.match(t, /现价 1432\.50 \+2\.32%/);
  assert.match(t, /不含|含质押\/解禁\/大宗\/增减持/);
  assert.match(t, /62\s*\/\s*100/, "有结论时才是「数字 / 100」");
  assert.match(t, /历史分位 18%/);
  assert.match(t, /1210 个交易日/);
  assert.match(t, /非交易所数据/, "筹码是模型推算,口径必须跟着数一起上屏");
  assert.match(t, /股东户数 278,364/);
  assert.match(t, /增持 0\.10%/);
  assert.doesNotMatch(t, /不下判断/);
});

test("资金流向:真金白银的证据上屏,5/20 日与连续天数都在;有钱就不再说「只有量价」", async () => {
  const t = await render(full());
  assert.match(t, /资金流向/);
  assert.match(t, /净流入/);
  assert.match(t, /\+15\.74 亿/, "今日净流入");
  assert.match(t, /\+12\.36 亿/, "近 5 日累计");
  assert.match(t, /\+8\.80 亿/, "近 20 日累计");
  assert.match(t, /3 日净流入/, "连续天数");
  assert.match(t, /\+9\.82 亿/, "超大单 5 日");
  assert.match(t, /netamount/, "口径跟着数一起走");
  assert.doesNotMatch(t, /没有资金流数据/, "这次钱是取到了的,不能还挂着「只有量价」");
});

test("资金流没取到:这栏明说空着,并交代主力行为只剩量价代理", async () => {
  const t = await render(full({ money: null }));
  assert.match(t, /没取到资金流序列/);
  assert.doesNotMatch(t, /\+15\.74 亿/);
  assert.match(t, /量价代理/, "没资金证据时必须说清「主力」是代理词");
});

test("样本不足:说「不下判断」,不画 0 分、也不借「洗盘中」的漂亮话", async () => {
  const t = await render(thin());
  assert.match(t, /不下判断/);
  assert.doesNotMatch(t, /\/ 100/, "不给总分,就别出现满分的分母");
  assert.match(t, /数据不足,评分与阶段不作数/);
  assert.match(t, /日 K 只有 20 根/);
  // 阶段徽章只能是中性的「数据不足」,不能是洗盘中 / 主升浪
  assert.doesNotMatch(t, /洗盘中|主升浪|吸筹中/);
  // 三个维度的占位 50 分不能当作读数显示
  assert.match(t, /三项按中性 50 占位/);
  for (const label of ["趋势", "量能", "位置"]) {
    assert.match(t, new RegExp(`${label}\\s*—`), `${label} 这一栏不该出现数字`);
  }
});

test("缺的域:写「没取到」而不是 0", async () => {
  const t = await render(thin());
  assert.match(t, /有几项没取到|数据不足/);
  assert.match(t, /估值历史没取到\(baostock 超时\)/);
  assert.match(t, /没取到估值序列/);
  assert.match(t, /没取到筹码分布/);
  assert.match(t, /没取到股东户数/);
});

test("basic 层:慢端点没取就明说按需取,不显示成 0 笔 / 0 批", async () => {
  const t = await render(full({
    depth: "basic",
    holders: {
      as_of: "2026-09-30", shareholder_count: 278364, shareholder_count_change_pct: -6.09,
      pledge_ratio: null, pledge_as_of: null,
      lockup_upcoming: null, lockup_window: null,
      block_trade_count: null, block_trade_latest: null, holder_trade_latest: null,
    },
  }));
  assert.match(t, /基础层/);
  assert.match(t, /点右上角「取更全」/);
  assert.doesNotMatch(t, /质押比例/);
  assert.doesNotMatch(t, /0 批/);
});

test("full 层:0 批解禁是确切结论,和「没取到」显示成两个样子", async () => {
  const ok = await render(full());
  assert.match(ok, /质押比例 0\.07%/);
  assert.match(ok, /未来待解禁 0 批/);
  assert.match(ok, /溢价率 -3\.2%/, "折价只是负溢价,标签要用中性的「溢价率」");

  const missing = await render(full({
    holders: { ...full().holders!, lockup_upcoming: null, lockup_window: null },
  }));
  assert.doesNotMatch(missing, /未来待解禁 0 批/, "没取到不能写成 0 批");
  assert.match(missing, /未来待解禁 —/);
});

test("读的是快照就要在页面上标明", async () => {
  assert.match(await render(full({ from_cache: true })), /部分读数来自快照/);
  assert.doesNotMatch(await render(full({ from_cache: false })), /部分读数来自快照/);
});
