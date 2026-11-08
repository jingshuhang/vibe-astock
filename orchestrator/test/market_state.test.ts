/**
 * 市场状态信号层单元测试
 *
 * 🔴 2026-10-30 第二轮:除了「算得出来 / 算不出来」,还要锁住
 *    ① 综合分 = 分项加权(不许再出现「分项 43.9、显示 33」)
 *    ② 阶段过门槛(广度 16% 的一天不许叫主升期/修复期)
 *    ③ 风险标签跟风险分走(不许「风险 15 分却叫低风险」)
 *    ④ 动作跟仓位上限走(0% 只能对「空仓等待」)
 *    ⑤ 分项带数据时间戳,昨天的数据要被标出来
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveMarketSignal, buildMarketStateView, extractBreadth, gateDataFrom } from "../src/finance/market_state.ts";
import { readMacroEvents } from "../src/finance/macro_events.ts";
import { breadthFrom, deriveOverviewMarketState } from "../src/finance/shortline/overview.ts";
import { boardFlowNetRows } from "../src/finance/scoring_inputs.ts";

/**
 * 涨跌分布端点返回的**真实结构**：按 record_key 分组的长表，
 * 靠 note 的「涨停 / 跌停 / 涨… / 跌… / 平盘」分档，值在 market_dist_count。
 * ⚠️ 不存在 limit_up / up_count 这种字段名 —— 早先按字段名去找，永远取不到。
 */
const BREADTH_ENV = {
  evidence: [
    { record_key: "d1", note: "涨停", field: "market_dist_count", value: 35 },
    { record_key: "d1", note: "涨停", field: "market_turnover_amount", value: 1.2e10 },
    { record_key: "d2", note: "跌停", field: "market_dist_count", value: 3 },
    { record_key: "d3", note: "涨0-3%", field: "market_dist_count", value: 1500 },
    { record_key: "d4", note: "跌0-3%", field: "market_dist_count", value: 500 },
    { record_key: "d5", note: "平盘", field: "market_dist_count", value: 200 },
  ],
};

/** 10/30 实测收盘:广度 893 涨 / 4602 跌 / 82 平;涨停 49 / 跌停 93 */
const B1030 = { limit_up: 49, limit_down: 93, up: 893, down: 4602, flat: 82 };
const GATE_1030 = {
  amountTotalYi: 16744.63,
  amountMa20Yi: 15833,
  indexShClose: 3599.02,
  indexShMa20: 3735.83,
  ladderHighest: 5,
  promotionRate: 0.5,
};
/** 三道门都真能过的闸门数据（量能 +20%、上证在 MA20 上方） */
const GATE_PASS = {
  amountTotalYi: 18000, amountMa20Yi: 15000,
  indexShClose: 3800, indexShMa20: 3700,
  ladderHighest: 5, promotionRate: 0.5,
};

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = isoDay(new Date());
const YESTERDAY = isoDay(new Date(Date.now() - 86_400_000));

describe("breadthFrom 解析", () => {
  it("真实结构（按 note 分档）能解析出家数", () => {
    const c = breadthFrom(BREADTH_ENV);
    assert.ok(c, "解析得出来");
    assert.deepEqual(
      { limit_up: c!.limit_up, limit_down: c!.limit_down, up: c!.up, down: c!.down, flat: c!.flat },
      { limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200 },
    );
    assert.equal(c!.turnover_yi, 120); // 1.2e10 元 → 120 亿
  });

  it("没有家数时返回 null（不是全 0）—— 调用方才分得清「没取到」和「真的 0 家」", () => {
    assert.equal(breadthFrom({}), null);
    assert.equal(breadthFrom({ evidence: [] }), null);
    assert.equal(breadthFrom({ evidence: [{ field: "limit_up", value: 35 }] }), null);
  });

  it("B3 回归:涨停/跌停必须精确匹配,不能把「涨超 9%(未涨停)」误判成涨停", () => {
    const env = {
      evidence: [
        { record_key: "d1", note: "涨停", field: "market_dist_count", value: 35 },
        { record_key: "d2", note: "跌停", field: "market_dist_count", value: 3 },
        { record_key: "d3", note: "涨超 9%(未涨停)", field: "market_dist_count", value: 100 },
        { record_key: "d4", note: "跌超 9%(未跌停)", field: "market_dist_count", value: 50 },
        { record_key: "d5", note: "涨 4~5%", field: "market_dist_count", value: 200 },
        { record_key: "d6", note: "跌 0~1%", field: "market_dist_count", value: 300 },
        { record_key: "d7", note: "平盘", field: "market_dist_count", value: 80 },
      ],
    };
    const c = breadthFrom(env);
    assert.ok(c);
    assert.deepEqual(
      { limit_up: c!.limit_up, limit_down: c!.limit_down, up: c!.up, down: c!.down, flat: c!.flat },
      { limit_up: 35, limit_down: 3, up: 300, down: 350, flat: 80 },
    );
  });
});

describe("extractBreadth 吃 FetchResult 外壳(旧 bug 回归)", () => {
  const shell = { envelope: BREADTH_ENV, exit_code: 0, fetched_at: "2026-10-30T07:00:00.000Z" };
  it("传外壳能解析出来 —— 早先直接把外壳递给 breadthFrom,于是永远「算不出来」", () => {
    assert.deepEqual(extractBreadth(shell), { limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200 });
  });
  it("传信封本体同样能解析", () => {
    assert.deepEqual(extractBreadth(BREADTH_ENV), { limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200 });
  });
  it("两样都没有 → 空对象(交给 breadthUsable 判「算不出来」)", () => {
    assert.deepEqual(extractBreadth(null), {});
    assert.deepEqual(extractBreadth({}), {});
  });
});

describe("gateDataFrom 解析闸门", () => {
  const TREND_ENV = {
    evidence: [
      { record_key: "index|000001", field: "index_close", value: 3599.02, period: "2026-10-30" },
      { record_key: "index|000001", field: "index_ma20", value: 3735.83, period: "2026-10-30" },
      { record_key: "amount|2026-10-29", field: "market_amount_total", value: 1.5565e12, period: "2026-10-29" },
      { record_key: "amount|2026-10-30", field: "market_amount_total", value: 1.6744e12, period: "2026-10-30" },
      { record_key: "amount|avg", field: "market_amount_ma20", value: 1.5833e12, period: "2026-10-30" },
    ],
  };
  const LADDER_ENV = {
    evidence: [
      { record_key: "3板", field: "ladder_tier_promotion_rate", value: 0.25 },
      { record_key: "5板", field: "ladder_tier_promotion_rate", value: 0.5 },
      { field: "ladder_highest", value: 5 },
    ],
  };

  it("取最新一天的成交额、20 日均额、上证收盘与 MA20", () => {
    const { gate } = gateDataFrom(TREND_ENV, LADDER_ENV);
    assert.ok(gate);
    assert.equal(gate!.indexShClose, 3599.02);
    assert.equal(gate!.indexShMa20, 3735.83);
    assert.equal(Math.round(gate!.amountTotalYi!), 16744, "应取 10-30 那一条,不是 10-29");
    assert.equal(Math.round(gate!.amountMa20Yi!), 15833);
  });

  it("晋级率取**最高一档**(5 板),不是碰上哪个算哪个", () => {
    const { gate } = gateDataFrom(TREND_ENV, LADDER_ENV);
    assert.equal(gate!.promotionRate, 0.5);
    assert.equal(gate!.ladderHighest, 5);
  });

  it("盘中形态:有 _prior 均值时优先用它(拿半天的量比整天均值会误导)", () => {
    const env = {
      evidence: [
        ...TREND_ENV.evidence,
        { record_key: "amount|avg", field: "market_amount_ma20_prior", value: 1.7e12, period: "2026-10-29" },
      ],
    };
    const { gate } = gateDataFrom(env, LADDER_ENV);
    assert.equal(Math.round(gate!.amountMa20Yi!), 17000);
  });

  it("一项都没取到 → gate=null,并说明只保留广度门", () => {
    const { gate, notes } = gateDataFrom({ evidence: [] }, { evidence: [] });
    assert.equal(gate, null);
    assert.ok(notes.some((n) => n.includes("广度门")));
  });
});

describe("deriveMarketSignal 端到端（走真实解析结构）", () => {
  it("真实结构能算出分数，不会被当成取数失败", () => {
    const signal = deriveMarketSignal(
      { limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200 },
      { rows: [{ resonance_rate: 0.6 }] },
      { rows: [{ net_yi: 1e9 }, { net_yi: -5e8 }] },
    );
    assert.equal(signal.unavailable, null, "有家数 → 算得出来");
    assert.equal(typeof signal.phase, "string");
    assert.equal(typeof signal.position_cap_pct, "number");
    assert.equal(typeof signal.can_open_position, "boolean");
  });

  /**
   * 🔴 这一条是第一轮审查的靶子:那张卡片写「33 分 / 修复期 / 极高风险 / 0 仓」,
   *    分项自己加权却是 43.9。四件事各错一处,现在逐个对齐。
   */
  it("10/30 实测:退潮期 · 分项自洽 · 极高风险 · 仓位 0%", () => {
    const signal = deriveMarketSignal(
      B1030,
      { rows: [{ resonance_rate: 30 }], resonance_share: 0.1 } as never,
      { rows: [{ net_yi: 51 }, { net_yi: -30 }, { net_yi: -15 }] },
      GATE_1030,
    );
    // ① 阶段:广度 16% 不许叫主升期,也不许叫修复期
    assert.equal(signal.phase, "退潮期");
    assert.equal(signal.base_phase, "主升期", "只看涨停家数会误判成主升期");
    assert.equal(signal.gate_blockers.length, 3);

    // ② 综合分 = 分项 × 生效权重(一位不差)
    const w = signal.weights!;
    const manual =
      signal.emotion_score! * w.emotion +
      signal.dragon_score! * w.dragon +
      signal.risk_score! * w.risk +
      signal.earning_score! * w.earning +
      (signal.event_score ?? 0) * w.event;
    assert.equal(signal.composite, Math.round(manual), `分项加权 ${manual.toFixed(2)} 应等于显示值 ${signal.composite}`);

    // ③ 风险分在地板、标签也是极高 —— 两者不再打架
    assert.equal(signal.risk_score, 15);
    assert.equal(signal.risk_level, "extreme");

    // ④ 仓位与动作一致:三门全灭 → 0%
    assert.equal(signal.position_cap_pct, 0);
    assert.equal(signal.can_open_position, false);
  });

  it("事件面没算出来:分数是 null 且权重为 0,而不是恒定的 50", () => {
    const signal = deriveMarketSignal({ limit_up: 30, limit_down: 5, up: 1200, down: 800, flat: 200 }, {}, {});
    assert.equal(signal.event_score, null);
    assert.equal(signal.event_detail, null);
    assert.equal(signal.weights!.event, 0);
    const sum = Object.values(signal.weights!).reduce((a, c) => a + c, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, "让渡后权重之和仍应为 1");
    assert.ok(signal.notes.some((n) => n.includes("事件面没算出来")), "要说清楚这一维为什么是空的");
  });

  it("事件面有读数:权重封顶 8%,且 Σ权重仍为 1", () => {
    const event = readMacroEvents({
      date: "2026-10-29",
      titles: ["国务院常务会议部署扩大内需政策", "央行降准0.5个百分点", "我国粮食产量再创新高"],
    });
    assert.ok(event);
    const signal = deriveMarketSignal({ limit_up: 30, limit_down: 5, up: 1200, down: 800, flat: 200 }, {}, {}, null, { event });
    assert.equal(signal.event_score, event!.score);
    assert.equal(signal.weights!.event, 0.08, "事件面名义 0.15,实际封顶 0.08");
    const sum = Object.values(signal.weights!).reduce((a, c) => a + c, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, "封顶后权重之和仍应为 1");
    // 分项 × 权重 == 综合分(四舍五入误差 1 分以内)
    const manual =
      signal.emotion_score! * signal.weights!.emotion +
      signal.dragon_score! * signal.weights!.dragon +
      signal.risk_score! * signal.weights!.risk +
      signal.earning_score! * signal.weights!.earning +
      signal.event_score! * signal.weights!.event;
    assert.ok(Math.abs(manual - signal.composite!) <= 1, `分项加权 ${manual} 与综合分 ${signal.composite} 应对得上`);
  });

  it("没有闸门数据时:量能门 / 均线门进 gate_unknown,不当成通过", () => {
    const signal = deriveMarketSignal({ limit_up: 30, limit_down: 5, up: 1300, down: 700, flat: 200 }, {}, {});
    assert.equal(signal.gate_unknown.length, 2);
    assert.equal(signal.gate_blockers.length, 0, "广度 59% 过门,其余两门只是没数据");
    assert.ok(signal.notes.some((n) => n.includes("闸门未评估")));
  });

  /**
   * 🔴 这是「取不到数据 = 通过」的翻版，2026-10-30 实测抓到：
   *    广度 59% 过门、量能与均线完全没数据、涨停 60 家 → 旧逻辑判「高潮期」+「可开新仓 40%」，
   *    也就是东财趋势端点一超时，系统就从「退潮期空仓」跳成「高潮期四成仓」。
   *    没评估的门既不是通过也不是失败：阶段不许升到主升期及以上，仓位最多「轻仓试探」。
   */
  it("闸门没评估完:不许叫主升期及以上,仓位最多 40%", () => {
    const signal = deriveMarketSignal({ limit_up: 60, limit_down: 2, up: 1300, down: 700, flat: 200 }, {}, {});
    assert.equal(signal.gate_unknown.length, 2);
    assert.equal(signal.gate_blockers.length, 0);
    assert.notEqual(signal.phase, "高潮期", "两门没数据还叫高潮期，等于拿取数故障当利好");
    assert.notEqual(signal.phase, "极度高潮期");
    assert.notEqual(signal.phase, "主升期");
    assert.equal(signal.phase, "修复期", "广度 59% + 涨停 60 + 跌停 2 → 修复期");
    assert.ok((signal.position_cap_pct ?? 0) <= 40, `仓位上限应 ≤40%，实得 ${signal.position_cap_pct}`);
    assert.equal(signal.can_open_position, true, "40% 仍然是「可轻仓」，不该被禁买");
  });

  it("分项带数据时间戳:昨天的数据要进 stale_dimensions", () => {
    const stale = deriveMarketSignal({ limit_up: 30, limit_down: 5, up: 1200, down: 800, flat: 200 }, {}, {}, null, {
      provenance: { breadth: `${YESTERDAY}T15:30:00+08:00`, resonance: `${YESTERDAY}T15:30:00+08:00` },
    });
    assert.ok(stale.stale_dimensions.includes("emotion"), "情绪用昨天的涨跌分布 → 必须标出来");
    assert.ok(stale.stale_dimensions.includes("risk"));
    assert.ok(stale.notes.some((n) => n.includes("不是")));
    assert.equal(stale.data_as_of.breadth, YESTERDAY);

    const fresh = deriveMarketSignal({ limit_up: 30, limit_down: 5, up: 1200, down: 800, flat: 200 }, {}, {}, null, {
      provenance: { breadth: `${TODAY}T15:30:00+08:00`, resonance: `${TODAY}T15:30:00+08:00`, board_flow: `${TODAY}T15:30:00+08:00` },
    });
    assert.deepEqual(fresh.stale_dimensions, []);
  });
});

describe("deriveMarketSignal", () => {
  it("应返回 MarketSignal 格式", () => {
    const signal = deriveMarketSignal(
      { limit_up: 30, limit_down: 5, up: 1200, down: 800, flat: 200 },
      { rows: [{ resonance_rate: 0.6 }] },
      { rows: [{ net_yi: 1e9 }, { net_yi: -5e8 }] },
    );
    assert.equal(typeof signal.composite, "number");
    assert.equal(typeof signal.phase, "string");
    assert.equal(typeof signal.position_cap_pct, "number");
    assert.equal(typeof signal.can_open_position, "boolean");
    assert.ok(["low", "medium", "high", "extreme"].includes(signal.risk_level!));
    assert.ok(Array.isArray(signal.sources));
    assert.ok(typeof signal.derived_at === "string");
    assert.equal(signal.unavailable, null, "有涨跌分布 → 算得出来");
    assert.ok(Array.isArray(signal.gate_blockers));
    assert.ok(Array.isArray(signal.phase_reasons));
  });

  /**
   * `sources` 是**声明式清单**，不是「本次实际命中核对」。
   * 拿「一路都没取到」去调，它照样列全六路 —— 这条测试就是把这个事实钉住，
   * 免得以后有人拿它当证据链、或反过来把它改成一份拼凑出来的「命中列表」。
   */
  it("sources 是预期取数来源：算不出来时也不缩水，别当成命中核对", () => {
    const full = deriveMarketSignal(
      { limit_up: 30, limit_down: 5, up: 1200, down: 800, flat: 200 },
      { rows: [{ resonance_rate: 0.6 }] },
      { rows: [{ net_yi: 1e9 }] },
    );
    const unavailable = deriveMarketSignal({}, {}, {});
    assert.equal(full.sources.length, 6);
    assert.equal(unavailable.unavailable !== null, true, "前提：这一支确实算不出来");
    assert.deepEqual(unavailable.sources, full.sources, "声明式清单不随本次取数结果变化");
    assert.ok(full.sources.some((s) => s.includes("em_market_breadth")));
  });

  /**
   * ⚠️ 这条是**记录现状**，不是认可现状正确：`data_as_of` 装的是 `fetched_at` 的日期，
   * 内容可能属于上一交易日。改成真实归属日要逐路解析 envelope，等 2026-11-09 盘中
   * 实机取证后再动判据；届时这条测试也要跟着改，别拿它当「设计意图」的挡箭牌。
   */
  it("data_as_of 目前是取数日期：今天取的昨收内容不会被判陈旧（已知局限，待实机）", () => {
    const s = deriveMarketSignal(
      { limit_up: 30, limit_down: 5, up: 1200, down: 800, flat: 200 },
      {}, {}, null,
      { provenance: { breadth: `${TODAY}T09:00:00+08:00` } },
    );
    assert.equal(s.data_as_of.breadth, TODAY, "取数日期来自 fetched_at，不是内容归属日");
    assert.deepEqual(s.stale_dimensions, [], "近似判据：取数日期是今天，就不标陈旧");
  });

  it("limit_up < 10 时应判为冰点期", () => {
    const signal = deriveMarketSignal({ limit_up: 5, limit_down: 2, up: 500, down: 1000, flat: 100 }, {}, {});
    assert.equal(signal.phase, "冰点期");
    assert.ok(signal.composite! < 40);
    assert.equal(signal.can_open_position, false);
    assert.equal(signal.position_cap_pct, 0);
  });

  /**
   * 阶段梯档本身（涨停家数 + 广度）：**必须给全套闸门数据**。
   * 🔴 这两条早先传 `{}`，靠「没有门失败就算全过」才升到主升期/极度高潮期 ——
   *    那正是「取不到数据 = 通过」的漏洞。没评估的门不许放行，见下一条用例。
   */
  it("涨停 35 且广度 68% + 三闸门全过 → 主升期", () => {
    const signal = deriveMarketSignal({ limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200 }, {}, {}, GATE_PASS);
    assert.equal(signal.phase, "主升期");
    assert.ok(signal.composite! >= 45, `综合分应在中位区,实际 ${signal.composite}`);
    assert.equal(signal.can_open_position, true);
  });

  it("涨停 80 + 广度 87% + 三闸门全过 → 极度高潮期", () => {
    const signal = deriveMarketSignal({ limit_up: 80, limit_down: 1, up: 2000, down: 200, flat: 100 }, {}, {}, GATE_PASS);
    assert.equal(signal.phase, "极度高潮期");
    assert.ok(signal.composite! >= 65, `实际 ${signal.composite}`);
    // 🔴 这个 fixture 的共振 / 资金流都是空对象 = 两条腿全缺。阶段判定不受完备性约束（分数没动），
    //    但仓位上限必须压到 40% —— 改动前这里给 70%，正是「拿取数故障当利好」的现场样本。
    assert.deepEqual(signal.incomplete_legs, ["板块共振", "板块资金流"]);
    assert.equal(signal.position_cap_pct, 40, "缺腿日不许给 70%，与「闸门未评估」同一档");
  });

  it("同样的强势盘面但数据齐 → 仓位档不被误杀", () => {
    const b = { limit_up: 80, limit_down: 1, up: 2000, down: 200, flat: 100 };
    const signal = deriveMarketSignal(
      b,
      { rows: [{ resonance_rate: 0.6 }] },
      { rows: [{ net_yi: 1e9 }, { net_yi: -5e8 }] },
      GATE_PASS,
    );
    assert.deepEqual(signal.incomplete_legs, []);
    assert.ok(signal.position_cap_pct! > 40, `数据齐时不该被压到 40%，实得 ${signal.position_cap_pct}`);
    assert.ok(!signal.notes.some((n) => n.includes("仓位上限因此压到")), "数据齐不许冒出压仓说明");
  });

  it("缺腿要在 notes 与 reason 里都说清，不许静默", () => {
    const b = { limit_up: 80, limit_down: 1, up: 2000, down: 200, flat: 100 };
    const signal = deriveMarketSignal(b, {}, {}, GATE_PASS);
    assert.ok(signal.notes.some((n) => n.includes("仓位上限因此最多 40%")), "notes 要写出压仓天花板");
    const view = buildMarketStateView(signal, b, {}, GATE_PASS);
    assert.ok(view.recommendation.reason.includes("仓位上限压到 40%"), "完备性真的压下来时 reason 要写明");
    assert.ok(view.recommendation.reason.includes("板块共振"), "reason 要写出缺的是哪条腿");
  });

  it("闸门已把上限压得更低时：不许再说「压到 40%」跟「归零」打架", () => {
    const b = { limit_up: 5, limit_down: 80, up: 200, down: 4000, flat: 100 };
    const signal = deriveMarketSignal(b, {}, {}, GATE_PASS);
    assert.ok(signal.incomplete_legs!.length > 0, "这个 fixture 也是缺腿的");
    assert.ok(signal.position_cap_pct! < 40, `实际上限 ${signal.position_cap_pct} 应已被闸门/分数压得更低`);
    const view = buildMarketStateView(signal, b, {}, GATE_PASS);
    assert.ok(!view.recommendation.reason.includes("仓位上限压到 40%"), "完备性没起作用就别写它压了仓");
    assert.ok(signal.notes.some((n) => n.includes("实际")), "notes 仍要如实给出实际值");
  });

  it("同样的涨停与广度，但量能/均线没数据 → 只给修复期、最多 40%", () => {
    const signal = deriveMarketSignal({ limit_up: 80, limit_down: 1, up: 2000, down: 200, flat: 100 }, {}, {});
    assert.equal(signal.gate_unknown.length, 2);
    assert.equal(signal.phase, "修复期", "没评估的两门不许被当成通过");
    assert.equal(signal.position_cap_pct, 40, "有门没数据 → 上限压到「轻仓试探」档");
  });

  it("limit_down 高时 risk_score 应偏低", () => {
    const signal = deriveMarketSignal({ limit_up: 15, limit_down: 30, up: 600, down: 1200, flat: 100 }, {}, {});
    assert.ok(signal.risk_score! < 50);
  });

  it("风险分不应低于 15 的地板值", () => {
    const signal = deriveMarketSignal({ limit_up: 5, limit_down: 100, up: 200, down: 4000, flat: 100 }, {}, {});
    assert.ok(signal.risk_score! >= 15, `风险分不应低于 15,实际 ${signal.risk_score}`);
  });

  /**
   * 🔴 这一条是修掉的缺陷：空数据过去会被当成「涨停 0 家 → 冰点期 → 极高风险 → 不许开新仓」，
   * 29 分就是这么来的。真相只是一次取数失败，不是市场冰点。
   */
  it("没取到涨跌分布：算不出来，且不给仓位上限（null，不是 0）", () => {
    for (const empty of [{}, { limit_up: 0, limit_down: 0, up: 0, down: 0, flat: 0 }, { up: null, down: null, flat: null }] as const) {
      const signal = deriveMarketSignal(empty, {}, {});
      assert.equal(signal.composite, null, "不算出一个分数来");
      assert.equal(signal.phase, null, "不判成冰点期");
      assert.equal(signal.position_cap_pct, null, "null = 不知道；0 = 算出来了、一股别买，两者不能混");
      assert.equal(signal.can_open_position, null, "不能因为取数失败就禁止开新仓");
      assert.equal(signal.risk_level, null, "不能因为取数失败就判极高风险");
      assert.equal(signal.emotion_score, null);
      assert.equal(signal.earning_score, null);
      assert.equal(signal.weights, null);
      assert.ok(signal.unavailable, "要写明算不出来的原因");
    }
  });

  it("有家数就算得出来：哪怕涨停 0 家，也按真数据打分", () => {
    const signal = deriveMarketSignal({ limit_up: 0, limit_down: 0, up: 300, down: 2000, flat: 100 }, {}, {});
    assert.equal(signal.unavailable, null);
    assert.equal(signal.phase, "冰点期", "这时候的冰点期是真数据算出来的");
    assert.equal(typeof signal.position_cap_pct, "number");
  });

  it("仓位上限应随 composite 单调不降", () => {
    const caps: number[] = [];
    for (let lu = 0; lu <= 100; lu += 10) {
      const s = deriveMarketSignal({ limit_up: lu, limit_down: 0, up: 1000, down: 0, flat: 0 }, {}, {});
      caps.push(s.position_cap_pct!);
    }
    for (let i = 1; i < caps.length; i++) {
      assert.ok(caps[i]! >= caps[i - 1]!, `position_cap 在 lu=${i * 10} 时未单调: ${caps[i - 1]} -> ${caps[i]}`);
    }
  });

  it("共振率从 0-100 源端自动缩放到 0-1", () => {
    const signal = deriveMarketSignal(
      { limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200 },
      { rows: [{ resonance_rate: 100 }] },
      { rows: [] },
    );
    assert.ok(signal.earning_score! > 50, `赚钱效应应较高,实际 ${signal.earning_score}`);
  });
});

describe("buildMarketStateView", () => {
  it("应包含 date/clock/signal/dimensions/recommendation/gate/notes 字段", () => {
    const b = { limit_up: 40, limit_down: 3, up: 1500, down: 500, flat: 200 };
    const sig = deriveMarketSignal(b, {}, {});
    const view = buildMarketStateView(sig, b, {});
    assert.ok(typeof view.date === "string");
    assert.ok(typeof view.clock === "string");
    assert.equal(view.signal, sig);
    for (const k of ["emotion", "dragon", "risk", "earning", "event"] as const) {
      assert.ok(view.dimensions[k], `${k} 维度应存在`);
      assert.ok("weight" in view.dimensions[k], `${k} 维度要带实际权重`);
      assert.ok("as_of" in view.dimensions[k], `${k} 维度要带数据日期`);
    }
    assert.ok(view.recommendation.action);
    assert.ok(view.gate);
    assert.deepEqual(view.notes, []);
  });

  /**
   * 🔴 第二轮靶子:上一版卡片写「修复期 … 不宜开新仓」，两张嘴各说各的。
   *    现在 action 只跟仓位上限走，reason 只陈述数据与闸门。
   */
  it("10/30 实测:动作为「空仓等待」，reason 只讲数据,不拿阶段替代结论", () => {
    const sig = deriveMarketSignal(
      B1030,
      { rows: [{ resonance_rate: 30 }], resonance_share: 0.1 } as never,
      { rows: [{ net_yi: -10 }, { net_yi: -20 }] },
      GATE_1030,
    );
    const view = buildMarketStateView(sig, B1030, {}, GATE_1030);
    assert.equal(view.recommendation.action, "空仓等待");
    assert.equal(view.recommendation.position_range, "0%");
    assert.ok(view.recommendation.reason.includes("上涨家数"), "reason 要给出数据依据");
    // 🔴 只写「闸门 3 门未过」的摘要：明细在 gate_blockers 里逐条渲染，
    //    reason 再抄一遍会让同一段文字在页面上出现两次（2026-10-30 截图可见）。
    assert.ok(view.recommendation.reason.includes("闸门 3 门未过"), "reason 要说清闸门");
    assert.ok(!view.recommendation.reason.includes("≤ MA20"), "明细不该在 reason 里重复一遍");
    assert.ok(!view.recommendation.reason.includes("不宜开新仓"), "不要再拿阶段标签当结论");
    // 阶段与动作同时出现在页面上,但各自表述的是不同的事
    assert.equal(view.dimensions.emotion.stage, "退潮期");
    assert.equal(view.gate.all_pass, false);
  });

  it("composite >= 75 且三闸门全过时应推荐顺势而为", () => {
    const b = { limit_up: 85, limit_down: 0, up: 2000, down: 0, flat: 100 };
    // 满档要「三门都确定通过」；只有广度数据时上限会被压到 40%（见 positionCapOf 的 unknownCap）。
    // 顺带把共振 / 资金流给全 —— 缺这两块现在是按中性补位（不再按 0），分数会低一些但不会被误当 0
    const sig = deriveMarketSignal(
      b,
      { rows: [{ resonance_rate: 90 }], resonance_share: 0.9 } as never,
      { rows: [{ net_yi: 10 }] },
      GATE_PASS,
    );
    assert.ok(sig.composite! >= 75, `实际 ${sig.composite}`);
    const view = buildMarketStateView(sig, b, {}, GATE_PASS);
    assert.equal(view.recommendation.action, "顺势而为");
    assert.equal(view.recommendation.position_range, "100%");
  });

  it("赚钱效应的腿没取到时:note 要说清「按中性补位」,并且分数不打成 0", () => {
    const b = { limit_up: 80, limit_down: 1, up: 2000, down: 200, flat: 100 };
    const miss = deriveMarketSignal(b, {}, {}, GATE_PASS);
    const full = deriveMarketSignal(b, { rows: [{ resonance_rate: 60 }], resonance_share: 0.6 } as never, { rows: [{ net_yi: 10 }] }, GATE_PASS);
    assert.ok(miss.earning_score! > 0);
    assert.ok(miss.earning_score! < full.earning_score!, "缺腿不许比数据齐全时更高（取数故障当利好）");
    assert.ok(miss.notes.some((n) => n.includes("板块共振") && n.includes("中性补位")), `实得 ${JSON.stringify(miss.notes)}`);
    assert.ok(miss.notes.some((n) => n.includes("板块资金流")), "两条腿都缺时要都写出来");

    // 只有一条腿缺时，只提那一条
    const onlyRes = deriveMarketSignal(b, {}, { rows: [{ net_yi: 10 }] }, GATE_PASS);
    assert.ok(onlyRes.notes.some((n) => n.includes("板块共振") && !n.includes("板块资金流")));
  });

  it("仓位上限 0% 时动作必须是「空仓等待」,与阶段标签无关", () => {
    const b = { limit_up: 3, limit_down: 15, up: 400, down: 1400, flat: 100 };
    const sig = deriveMarketSignal(b, {}, {});
    const view = buildMarketStateView(sig, b, {});
    assert.equal(view.recommendation.action, "空仓等待");
    assert.equal(view.recommendation.position_range, "0%");
  });

  it("算不出来时：五维全 null、不给操作建议（连「观望」都不给）", () => {
    const sig = deriveMarketSignal({}, {}, {});
    const view = buildMarketStateView(sig, {}, {});
    assert.equal(view.recommendation.action, "算不出来");
    assert.equal(view.recommendation.position_range, "—");
    assert.equal(view.recommendation.confidence, 0);
    assert.equal(view.dimensions.emotion.score, null);
    assert.equal(view.dimensions.emotion.stage, null);
    assert.equal(view.dimensions.dragon.has_dragon, null);
    assert.equal(view.dimensions.risk.score, null);
    assert.equal(view.dimensions.earning.up_rate, null);
    assert.equal(view.dimensions.event.score, null);
  });
});

describe("deriveOverviewMarketState(盯盘页内嵌信号)", () => {
  const makeBreadthEnv = (counts: Record<string, number>) => ({
    evidence: Object.entries(counts).map(([note, value], i) => ({
      record_key: `b${i}`, note, field: "market_dist_count", value,
    })),
  });

  it("解析出来的涨跌分布 → 复用 market_state 派生出完整的 MarketStateView", () => {
    const c = breadthFrom(makeBreadthEnv({ 涨停: 40, 跌停: 3, "涨 4~5%": 1500, "跌 0~1%": 500, 平盘: 200 }))!;
    const breadth = { status: "ok" as const, data: { scope: "全市场涨跌分布(东财)", ...c } };
    const resonance = {
      status: "ok" as const,
      data: {
        rows: [{ name: "X", change_pct: null, up_count: null, down_count: null, total: null, resonance_rate: 60, rank: null, signal: "共振" as const }],
        scope: "s", avg_rate: 52, resonance_share: 0.2,
      },
    };
    const boardFlow = {
      status: "ok" as const,
      data: { rows: [{ name: "Y", net_yi: 10, change_pct: null, leader: null, rank: null }], all_net_yi: [10] },
    };
    const block = deriveOverviewMarketState(breadth, resonance, boardFlow, GATE_PASS);
    assert.equal(block.status, "ok");
    assert.ok(block.data, "有数据就应有 MarketStateView");
    assert.equal(block.data!.signal.unavailable, null, "有涨跌分布 → 算得出来");
    assert.equal(block.data!.signal.phase, "主升期", "40 家涨停 + 广度 68% + 三闸门全过");
    assert.ok(block.data!.signal.composite! >= 55);
    assert.equal(block.data!.dimensions.emotion.score != null, true);
    assert.equal(block.data!.dimensions.risk.score != null, true);
    assert.equal(block.data!.dimensions.earning.score != null, true);
    assert.ok(typeof block.data!.recommendation.action === "string");
  });

  it("赚钱效应吃全市场共振占比,不吃 Top10 均值", () => {
    const c = breadthFrom(makeBreadthEnv({ 涨停: 40, 跌停: 3, "涨 4~5%": 1500, "跌 0~1%": 500, 平盘: 200 }))!;
    const breadth = { status: "ok" as const, data: { scope: "x", ...c } };
    const mk = (share: number) => ({
      status: "ok" as const,
      data: {
        rows: [{ name: "X", change_pct: null, up_count: null, down_count: null, total: null, resonance_rate: 95, rank: null, signal: "共振" as const }],
        scope: "s", avg_rate: 95, resonance_share: share,
      },
    });
    const high = deriveOverviewMarketState(breadth, mk(0.9), { status: "empty" as const, data: null });
    const low = deriveOverviewMarketState(breadth, mk(0.05), { status: "empty" as const, data: null });
    assert.ok(
      high.data!.signal.earning_score! - low.data!.signal.earning_score! >= 15,
      `共振占比应实质影响赚钱效应，实际 ${high.data!.signal.earning_score} vs ${low.data!.signal.earning_score}`,
    );
  });

  it("涨跌分布没取到(breadth 无 data):状态 failed + 信号标 unavailable,不给分数/仓位上限", () => {
    const breadth = { status: "failed" as const, data: null, note: "东财主源断连" };
    const resonance = { status: "empty" as const, data: null };
    const boardFlow = { status: "empty" as const, data: null };
    const block = deriveOverviewMarketState(breadth, resonance, boardFlow);
    assert.equal(block.status, "failed");
    assert.ok(block.data);
    assert.ok(block.data!.signal.unavailable, "必须写明算不出来");
    assert.equal(block.data!.signal.composite, null);
    assert.equal(block.data!.signal.position_cap_pct, null);
    assert.equal(block.data!.signal.can_open_position, null);
  });

  it("涨跌分布取到但全 0 家:信号 unavailable,不伪装成冰点期/极高风险", () => {
    const breadth = {
      status: "ok" as const,
      data: { scope: "x", limit_up: 0, limit_down: 0, up: 0, down: 0, flat: 0, turnover_yi: null },
    };
    const block = deriveOverviewMarketState(breadth, { status: "empty" as const, data: null }, { status: "empty" as const, data: null });
    assert.ok(block.data?.signal.unavailable, "全 0 家 = 没取到,不是冰点期");
    assert.equal(block.data?.signal.composite, null);
    assert.equal(block.data?.signal.can_open_position, null);
    assert.equal(block.data?.signal.risk_level, null);
  });

  it("带闸门数据时正确降级主升期", () => {
    const c = breadthFrom(makeBreadthEnv({
      涨停: 49, 跌停: 93, "跌 4~5%": 644, "跌 5~6%": 475, "跌 6~7%": 350, "跌 7~8%": 223, "跌 8~9%": 142,
      "跌超 9%(未跌停)": 177, "涨 0~1%": 327, "涨 1~2%": 201, "涨 2~3%": 99, "涨 3~4%": 74, "涨 4~5%": 37,
      "涨 5~6%": 35, "涨 6~7%": 11, "涨 7~8%": 8, "涨 8~9%": 5, "涨超 9%(未涨停)": 12, 平盘: 74,
    }))!;
    const breadth = { status: "ok" as const, data: { scope: "全市场涨跌分布(东财)", ...c } };
    const resonance = { status: "ok" as const, data: { rows: [], scope: "s", avg_rate: null, resonance_share: 0.08 } };
    const boardFlow = { status: "ok" as const, data: { rows: [], all_net_yi: [] } };
    const block = deriveOverviewMarketState(breadth, resonance, boardFlow, GATE_1030);
    assert.equal(block.status, "ok");
    assert.ok(block.data);
    assert.notEqual(block.data.signal.phase, "主升期", "闸门应阻止主升期");
    assert.equal(block.data.signal.phase, "退潮期");
    assert.ok(block.data.signal.gate_blockers.length > 0, "应有闸门 blocker");
    assert.ok(block.data.signal.composite! < 45, `复合分应明显偏低,实际 ${block.data.signal.composite}`);
    assert.equal(block.data.signal.position_cap_pct, 0);
  });
});

/**
 * 2026-10-30：同一个收盘，市场状态页 37 分、盯盘概况 39 分。
 *
 * 差异只在赚钱效应（22 vs 28），而赚钱效应有一条腿是「净流入板块占比」。两处各写一份解析：
 *   - 概况页把**展示用的净流入 Top12** 喂给评分 —— 12 行全为正，占比恒等于 100%；
 *   - 独立页没按 `field` 过滤 —— 一个板块出 5 条证据，48 个板块混成「240 行」，
 *     分母里塞进了「流入」（恒正）、「涨跌幅」、「净占比」。
 * 两条都不对。这组用例锁住「一份解析、两个入口」，别再各写一份。
 */
describe("评分输入：板块资金流只认净额、且必须全量（37 vs 39 的根因）", () => {
  const makeBreadthEnv = (counts: Record<string, number>) => ({
    evidence: Object.entries(counts).map(([note, value], i) => ({
      record_key: `b${i}`, note, field: "market_dist_count", value,
    })),
  });
  /** sina_board_flow 的真实形状：一个板块出 5 条证据，靠 field 区分 */
  const boardFlowEnv = (nets: number[]) => ({
    evidence: nets.flatMap((net, i) => {
      const note = `板块${i} 排名 ${i + 1};领涨 某某${i} 5.0%`;
      const rk = `industry|b${i}`;
      return [
        { record_key: rk, note, field: "board_net_sina", value: net },
        { record_key: rk, note, field: "board_inflow_sina", value: Math.abs(net) + 1e8 },
        { record_key: rk, note, field: "board_outflow_sina", value: 1e8 },
        { record_key: rk, note, field: "board_change_pct_sina", value: 1.23 },
        { record_key: rk, note, field: "board_net_ratio_sina", value: 3.45 },
      ];
    }),
  });

  it("按 field 过滤：48 个板块 5 个字段的信封 → 48 行净额，不是 240 行", () => {
    const nets = Array.from({ length: 48 }, (_, i) => (i < 26 ? 1e8 : -1e8));
    const rows = boardFlowNetRows(boardFlowEnv(nets));
    assert.equal(rows.length, 48, "分母必须是板块数，不是证据条数");
    assert.equal(rows.filter((r) => r.net_yi > 0).length, 26);
    assert.ok(rows.every((r) => Math.abs(r.net_yi) === 1), "元 → 亿 的换算不能丢");
  });

  it("资金流缺失/字段名不符时不瞎猜：返回空数组，而不是把涨跌幅当净额", () => {
    const env = { evidence: [{ record_key: "industry|b0", field: "board_change_pct_sina", value: 3.2 }] };
    assert.deepEqual(boardFlowNetRows(env), []);
  });

  it("概况页的赚钱效应用 all_net_yi（全量），不看展示用 Top12", () => {
    const c = breadthFrom(makeBreadthEnv({ 涨停: 40, 跌停: 3, "涨 4~5%": 1500, "跌 0~1%": 500, 平盘: 200 }))!;
    const breadth = { status: "ok" as const, data: { scope: "x", ...c } };
    const resonance = { status: "empty" as const, data: null };
    // 展示行都是「净流入的 Top12」（必然全正），区别只在全量里有多少板块是净流入
    const displayRows = Array.from({ length: 12 }, (_, i) => ({
      name: `S${i}`, net_yi: 30 - i, change_pct: 2, leader: null, rank: i + 1,
    }));
    const allPositive = deriveOverviewMarketState(
      breadth, resonance, { status: "ok" as const, data: { rows: displayRows, all_net_yi: Array(50).fill(10) } },
    );
    const halfNegative = deriveOverviewMarketState(
      breadth, resonance, { status: "ok" as const, data: { rows: displayRows, all_net_yi: [...Array(25).fill(10), ...Array(25).fill(-9)] } },
    );
    const diff = allPositive.data!.signal.earning_score! - halfNegative.data!.signal.earning_score!;
    assert.ok(diff > 9, `净流入占比从 100% 掉到 50% 应让赚钱效应掉 10 分,实际差 ${diff}`);
  });
});
