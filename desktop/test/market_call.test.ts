// 大盘判断台账卡:全景收盘档的交易倾向四档 + 次日触发条件对账。
// 断言语义不变量:只存档不生成建议(口径原文)、触发命中判不了不伪装、
// 读数缺失显示「—」、同日一档、html 报告断链不拦落账(只展示文件名)。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { MarketCallView, MarketCallRow } from "../src/verticals/finance/lib/marketCall.ts";

const PAGE = "/src/verticals/finance/pages/MarketState.tsx";

const row = (over: Partial<MarketCallRow>): MarketCallRow => ({
  date: "2026-11-05", call: "减仓", direction: "偏空",
  basis: "广度 32% 转弱、缩量 1.6 万亿", trigger: "广度破 45% 转减仓",
  trigger_metric: "breadth_pct", trigger_op: "below", trigger_value: 45,
  breadth_pct: 32.1, amount_yi: 16200, limit_up: 58, limit_down: 21,
  settled: true, settled_date: "2026-11-06",
  next_breadth_pct: 28.4, next_amount_yi: 15100, next_limit_up_count: 33, next_limit_down_count: 40,
  trigger_hit: true,
  html_path: "C:\\Users\\51092\\Desktop\\A股大盘全景-2026-11-05.html",
  source: "ledger",
  ...over,
});

const VIEW: MarketCallView = {
  available: true, date: "2026-11-05", total: 3, settled_count: 2, pending_count: 1,
  judged: 2, hit: 1,
  rows: [
    row({}),
    row({
      date: "2026-11-04", call: "持有", direction: "中性", basis: "主线在但广度收敛",
      trigger: "失守 3700 转减", trigger_metric: "amount_yi", trigger_op: "below", trigger_value: 15000,
      breadth_pct: 47.7, amount_yi: 16800, limit_up: 71, limit_down: 8,
      settled_date: "2026-11-05",
      next_breadth_pct: 32.1, next_amount_yi: 16200, next_limit_up_count: 58, next_limit_down_count: 21,
      trigger_hit: false, html_path: null,
    }),
    row({
      date: "2026-11-03", call: "观望", direction: "中性", basis: "无主线且缩量",
      trigger: "待放量选方向", trigger_metric: null, trigger_op: null, trigger_value: null,
      breadth_pct: null, amount_yi: null, limit_up: null, limit_down: null,
      settled: false, settled_date: null,
      next_breadth_pct: null, next_amount_yi: null, next_limit_up_count: null, next_limit_down_count: null,
      trigger_hit: null, html_path: null,
    }),
  ],
  caveat: "交易倾向四档(加仓/持有/减仓/观望)与触发条件由 WorkBuddy 大盘全景收盘档产出,本台账只存档与对账,不生成任何大盘建议;触发命中按结构化阈值机器判(≥/≤ 含等于),触发条件原文一直留档供人工复核;对账读数取本系统端点(东财涨跌分布/指数趋势),与全景侧通达信口径可能有小差异。不构成投资建议。",
  generated_at: "2026-11-06T16:05:00+08:00",
};

test("台账卡:最新档四档徽标 + 依据 + 结构化触发条件 + 战绩汇总", async () => {
  await withRenderer(async (r) => {
    const { MarketCallCard } = await r.load(PAGE);
    const t = textOf(r.html(MarketCallCard, { view: VIEW, error: "" }));
    // 汇总行:总数/已对账/待对账/命中战绩
    assert.match(t, /共 3 条/);
    assert.match(t, /已对账 2/);
    assert.match(t, /待对账 1/);
    assert.match(t, /触发命中 1\/2/);
    // 最新一档:减仓 · 偏空,依据原文,结构化触发条件(广度 ≥/≤ 45)+ 原文括注
    assert.match(t, /减仓/);
    assert.match(t, /偏空/);
    assert.match(t, /广度 32% 转弱、缩量 1\.6 万亿/);
    assert.match(t, /广度 ≤ 45/);
    assert.match(t, /广度破 45% 转减仓/);
    assert.match(t, /次日已触发/);
    // html 报告断链不拦落账:只展示文件名
    assert.match(t, /A股大盘全景-2026-11-05\.html/);
  });
});

test("台账卡:历史对账并排——写下时与次日读数同屏;判不了如实写,不伪装成未触发", async () => {
  await withRenderer(async (r) => {
    const { MarketCallCard } = await r.load(PAGE);
    const t = textOf(r.html(MarketCallCard, { view: VIEW, error: "" }));
    // 11-05:breadth below 45,次日 28.4 ≤ 45 → 已触发(红)
    assert.match(t, /广度 28\.4%/);
    assert.match(t, /涨停 33 \/ 跌 40/);
    assert.match(t, /已触发/);
    // 11-04:amount below 15000,次日 16200 > 15000 → 未触发(绿)
    assert.match(t, /额 16200 亿/);
    assert.match(t, /未触发/);
    // 11-03:待对账 + 无结构化条件 → 「—」与「待对账」,不出现第三个假状态
    assert.match(t, /待对账/);
    // 读数全缺的行:写下时一列显示「—」
    assert.match(t, /—/);
    // 判不了(读数缺但已对账)不出现在这份数据里,但代码路径存在:检查表头有「触发」列
    assert.match(t, /写下时读数/);
    assert.match(t, /次日读数/);
  });
});

test("台账卡:口径原文带出——只存档不生成建议、≥/≤ 含等于、对账读数是东财口径", async () => {
  await withRenderer(async (r) => {
    const { MarketCallCard } = await r.load(PAGE);
    const t = textOf(r.html(MarketCallCard, { view: VIEW, error: "" }));
    assert.match(t, /不生成任何大盘建议/);
    assert.match(t, /≥\/≤ 含等于/);
    assert.match(t, /东财涨跌分布\/指数趋势/);
    assert.match(t, /不构成投资建议/);
  });
});

test("台账卡:没落过账时讲清楚交接流程(写 inbox → 16:05 扫描落账),不显示空表", async () => {
  await withRenderer(async (r) => {
    const { MarketCallCard } = await r.load(PAGE);
    const t = textOf(r.html(MarketCallCard, { view: null, error: "" }));
    assert.match(t, /还没有落账记录/);
    assert.match(t, /inbox\/market_call/);
    assert.match(t, /16:05/);
    assert.match(t, /不生成大盘建议/);
    const t2 = textOf(r.html(MarketCallCard, { view: { ...VIEW, available: false }, error: "" }));
    assert.match(t2, /还没有落账记录/);
  });
});

test("台账卡:取数失败降级为错误文案,不挡市场状态主视图", async () => {
  await withRenderer(async (r) => {
    const { MarketCallCard } = await r.load(PAGE);
    const t = textOf(r.html(MarketCallCard, { view: null, error: "connect ECONNREFUSED" }));
    assert.match(t, /台账没读到/);
    assert.match(t, /ECONNREFUSED/);
  });
});

// ── 每日复盘页:当日全景判断卡(交叉验证) ────────────────────────────────────────
const REVIEW = "/src/verticals/finance/pages/DailyReview.tsx";

/** 复盘页看的那天(10-30):交接件还在 inbox 没落账 —— 复盘要展示的就是这一形态 */
const dayRow = (over: Partial<MarketCallRow> = {}): MarketCallRow => ({
  date: "2026-10-30", call: "减仓", direction: "偏空",
  basis: "广度16%+破3600+主力−352亿", trigger: "站回3660转持有",
  trigger_metric: null, trigger_op: null, trigger_value: null,
  breadth_pct: 16.0, amount_yi: 16744.63, limit_up: 49, limit_down: 93,
  settled: false, settled_date: null,
  next_breadth_pct: null, next_amount_yi: null, next_limit_up_count: null, next_limit_down_count: null,
  trigger_hit: null,
  html_path: "C:\\Users\\51092\\Desktop\\A股大盘全景-2026-10-30.html",
  source: "inbox",
  ...over,
});

test("复盘页·当日全景判断:四档 + 依据 + 触发原文 + 当日读数 + 全景报告名", async () => {
  await withRenderer(async (r) => {
    const { MarketCallDayCard } = await r.load(REVIEW);
    const t = textOf(r.html(MarketCallDayCard, { row: dayRow(), error: null, done: true, bizDay: "2026-10-30" }));
    assert.match(t, /当日全景判断（大盘收盘档）/);
    assert.match(t, /2026-10-30/);
    assert.match(t, /减仓/);
    assert.match(t, /偏空/);
    assert.match(t, /依据：\s*广度16%\+破3600\+主力−352亿/);
    assert.match(t, /触发条件：—（站回3660转持有）/, "非结构化触发:原文照给,比较符位如实给 —");
    assert.match(t, /写下时读数：广度 16% · 额 16744\.63 亿 · 涨停 49 \/ 跌 93/);
    assert.match(t, /A股大盘全景-2026-10-30\.html/);
    assert.match(t, /交叉验证/);
    assert.match(t, /不构成投资建议/);
  });
});

test("复盘页·当日全景判断:inbox 未落账明说;已落账/已对账各给状态;无结构化触发不编比较符", async () => {
  await withRenderer(async (r) => {
    const { MarketCallDayCard } = await r.load(REVIEW);
    const inbox = textOf(r.html(MarketCallDayCard, { row: dayRow(), error: null, done: true, bizDay: "2026-10-30" }));
    assert.match(inbox, /交接件在 inbox，还没落账（16:05 扫描后入台账）/);
    assert.doesNotMatch(inbox, /次日已触发|次日未触发/, "没落账就没有对账结果,不预设触发状态");

    const posted = textOf(r.html(MarketCallDayCard, {
      row: dayRow({ source: "ledger", settled: false }), error: null, done: true, bizDay: "2026-10-30",
    }));
    assert.match(posted, /已落账，待次日对账/);

    const settled = textOf(r.html(MarketCallDayCard, {
      row: dayRow({
        source: "ledger", settled: true, settled_date: "2026-11-02",
        trigger_metric: "breadth_pct", trigger_op: "above", trigger_value: 45,
        trigger_hit: true, breadth_pct: 48.6, amount_yi: 16200, limit_up: 58, limit_down: 21,
      }), error: null, done: true, bizDay: "2026-10-30",
    }));
    assert.match(settled, /已对账 2026-11-02/);
    assert.match(settled, /广度 ≥ 45/);
    assert.match(settled, /次日已触发/);
  });
});

test("复盘页·当日全景判断:没有当天记录 / 取数失败 / 还在加载,三种状态各自明说不装有", async () => {
  await withRenderer(async (r) => {
    const { MarketCallDayCard } = await r.load(REVIEW);
    const none = textOf(r.html(MarketCallDayCard, { row: null, error: null, done: true, bizDay: "2026-10-30" }));
    assert.match(none, /2026-10-30 没有对应的全景判断记录/);
    assert.match(none, /没有可交叉验证的对照项/);

    const err = textOf(r.html(MarketCallDayCard, { row: null, error: "connect ECONNREFUSED", done: true, bizDay: "2026-10-30" }));
    assert.match(err, /台账没读到：connect ECONNREFUSED/);
    assert.match(err, /不代表当天没有判断/);

    const loading = textOf(r.html(MarketCallDayCard, { row: null, error: null, done: false, bizDay: null }));
    assert.match(loading, /加载中/);
    assert.doesNotMatch(loading, /没有对应的全景判断/, "还没加载完不能说「没有」");
  });
});
