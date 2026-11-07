/**
 * 市场五维打分:全仓唯一一份实现的回归锁。
 * 目的 —— 防止 market_state.ts / overview.ts 哪天又各自内联一份、悄悄漂移。
 * 只要这两个页面都 import 这里的 scoreMarket,就不可能再出现「同一个市场两个分数」。
 *
 * 🔴 2026-10-30 第二轮:除了「不漂移」,还要锁住四件**算得出来但算得不对**的事:
 *    阶段要过门槛、综合分要等于分项加权、没数据源的维度不许占权重、风险标签要跟风险分一致。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreMarket,
  limitUpScore,
  polarityScore,
  emotionReading,
  evaluateMarketGate,
  resolvePhase,
  effectiveWeights,
  weightedComposite,
  riskLevelOf,
  positionCapOf,
  INCOMPLETE_DATA_CAP_PCT,
  MARKET_WEIGHTS,
} from "../src/finance/market_score.ts";

/** 10/30 实测收盘:上证 3599.02 / 深成 10833.78,两市 16744.63 亿;广度 893 涨 / 4602 跌 / 82 平;涨停 49 / 跌停 93 */
const D1030 = { limit_up: 49, limit_down: 93, up: 893, down: 4602, flat: 82 } as const;
const GATE_1030 = {
  amountTotalYi: 16744.63,
  amountMa20Yi: 15833,
  indexShClose: 3599.02,
  indexShMa20: 3735.83,
  ladderHighest: 5,
  promotionRate: 0.5,
} as const;

describe("情绪读数:连续化,不再有阈值跳变", () => {
  it("涨停家数分是分段线性 —— 39 家与 40 家只差不到 2 分", () => {
    const d = Math.abs(limitUpScore(40) - limitUpScore(39));
    // 旧实现:39 家 → 45 分,40 家 → 70 分,一家之差跳 25 分
    assert.ok(d < 2, `阈值附近不应跳变,实际差 ${d.toFixed(2)} 分`);
    assert.ok(limitUpScore(0) <= 12, "0 家涨停应在底部");
    assert.ok(limitUpScore(200) >= 90, "200 家涨停应在顶部");
  });

  it("涨跌停比:涨停 49 / 跌停 93 → 34.5(单看涨停家数看不出这层意思)", () => {
    assert.equal(Math.round(polarityScore(49, 93)! * 10) / 10, 34.5);
    assert.equal(polarityScore(0, 0), null, "两边都是 0 时没有极性可读,返回 null 而不是 50");
  });

  it("情绪分 = 75% 涨停家数 + 25% 涨跌停比", () => {
    const { score } = emotionReading(49, 93);
    const expect = 0.75 * limitUpScore(49) + 0.25 * polarityScore(49, 93)!;
    assert.ok(Math.abs(score - Math.round(expect)) <= 0.6, `实际 ${score} vs 期望 ${expect.toFixed(2)}`);
  });
});

describe("综合分恒等于五维加权(第二轮核心不变量)", () => {
  it("10/30 实测数据:分项 × 生效权重 == composite,一位不差", () => {
    const d = scoreMarket({
      ...D1030,
      resonanceRates: [0.3],
      resonanceShare: 0.1,
      inflowRate: 0.1,
      promotionRate: 0.5,
      ladderHighest: 5,
      gateData: GATE_1030,
    });
    const manual =
      d.emotion * d.weights.emotion +
      d.dragon * d.weights.dragon +
      d.risk * d.weights.risk +
      d.earning * d.weights.earning +
      (d.event ?? 0) * d.weights.event;
    assert.equal(d.composite, Math.round(manual), "用户拿分项自己乘一遍必须对得上");
    // 权重之和 = 1(事件未接入时,其余四项按比例放大)
    const sum = Object.values(d.weights).reduce((a, c) => a + c, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `有效权重之和应为 1,实际 ${sum}`);
    assert.equal(d.weights.event, 0, "事件面没数据 → 权重必须是 0,不许拿中性 50 顶 15%");
  });

  it("事件面未接入时,综合分不被「幽灵 50 分」拉向中间", () => {
    const base = {
      ...D1030,
      resonanceRates: [0.3],
      inflowRate: 0.1,
      promotionRate: 0.5,
      ladderHighest: 5,
      gateData: GATE_1030,
    };
    const withoutEvent = scoreMarket(base);
    const withEvent = scoreMarket({ ...base, eventScore: 50 });
    assert.notEqual(withoutEvent.composite, withEvent.composite, "有没有事件面不能算出同一个数");
    // 未接入时,权重按 0.30/0.85 等重归一化后,四项的贡献被放大
    assert.ok(Math.abs(withoutEvent.weights.emotion - 0.3 / 0.85) < 1e-9);
  });

  it("effectiveWeights / weightedComposite 是同一个来源", () => {
    const d = scoreMarket({
      limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200,
      resonanceRates: [0.6], inflowRate: 0.5, promotionRate: null, ladderHighest: null,
    });
    const w = effectiveWeights({ emotion: d.emotion, dragon: d.dragon, risk: d.risk, earning: d.earning, event: d.event });
    const c = weightedComposite({ emotion: d.emotion, dragon: d.dragon, risk: d.risk, earning: d.earning, event: d.event });
    assert.deepEqual(w, d.weights);
    assert.equal(c, d.composite);
  });
});

describe("阶段是门槛制,不是分数区间", () => {
  it("10/30 实测:涨停 49 家但广度 16% / 破 MA20 → 退潮期,不是主升期也不是修复期", () => {
    const d = scoreMarket({
      ...D1030,
      resonanceRates: [0.3],
      resonanceShare: 0.1,
      inflowRate: 0.1,
      promotionRate: 0.5,
      ladderHighest: 5,
      gateData: GATE_1030,
    });
    assert.equal(d.stage, "退潮期");
    assert.equal(d.base_stage, "主升期", "只看涨停家数会误判成主升期 —— 这正是 base_stage 存在的意义");
    assert.ok(d.gate.blockers.length === 3, `三个门都应失败,实际 ${d.gate.blockers.join(";")}`);
    assert.ok(d.phase_reasons.length > 0, "阶段被压下来要能说清为什么");
    /**
     * 🔴 2026-10-30 截图暴露:那天涨停 49 / **跌停 93** / 广度 14%,
     *    页面却写「情绪读数本可到主升期,被准入闸门压到退潮期」—— 给人一种「其实很强」的错觉。
     *    跌停潮的日子里，错的是「只看涨停家数」这个粗口径，不是闸门。
     */
    assert.ok(d.base_note, "阶段与基准口径不一致时必须给解释");
    assert.ok(d.base_note!.includes("跌停"), `跌停潮要说跌停,实得「${d.base_note}」`);
    assert.ok(!d.base_note!.includes("本可到"), "跌停成片时不许说「情绪本可到主升期」");
  });

  it("修复期本身也要门槛:广度 < 40% 不许叫修复", () => {
    const p = resolvePhase({
      limitUp: 49, limitDown: 93, upRate: 0.16,
      gate: { allPass: false, blockers: ["广度 16% < 55%"], passed: [], unknown: [] },
    });
    assert.equal(p.phase, "退潮期");
    assert.ok(p.reasons.some((r) => r.includes("修复期")), "应说明为什么不够修复期");
  });

  /** 反面情形:涨停家数够、跌停很少,只是闸门没过 —— 这时才该说「被闸门压到」 */
  it("跌停不多而是闸门没过时,解释要用「被准入闸门压到」而不是「跌停潮」", () => {
    const p = resolvePhase({
      limitUp: 62, limitDown: 3, upRate: 0.25,
      gate: { allPass: false, blockers: ["量能 +2% < +10%"], passed: ["广度"], unknown: [] },
    });
    assert.equal(p.phase, "退潮期");
    assert.equal(p.base_stage, "高潮期");
    assert.ok(p.base_note?.includes("被准入闸门压到"), `实得「${p.base_note}」`);
    assert.ok(!p.base_note!.includes("跌停潮"));
  });

  it("阶段与基准口径一致时不产生解释", () => {
    const p = resolvePhase({
      limitUp: 3, limitDown: 2, upRate: 0.2,
      gate: { allPass: false, blockers: ["广度 20% < 55%"], passed: [], unknown: [] },
    });
    assert.equal(p.phase, "冰点期");
    assert.equal(p.base_stage, "冰点期");
    assert.equal(p.base_note, null);
  });

  /**
   * 🔴 两套阈值本来就不一样：纯涨停口径要 30 家才算主升，带闸门的口径 25 家 + 三门全过就放行。
   *    于是涨停 27 家 + 全过闸门 → phase 主升期 / base 修复期，旧文案会输出
   *    「情绪读数本可到「修复期」，被准入闸门压到「主升期」」—— 闸门往上"压"，读起来像 bug。
   */
  it("闸门把阶段抬上去时，不许说「被闸门压到」", () => {
    const p = resolvePhase({
      limitUp: 27, limitDown: 2, upRate: 0.70,
      gate: { allPass: true, blockers: [], passed: ["广度", "量能", "指数>MA20"], unknown: [] },
    });
    assert.equal(p.phase, "主升期");
    assert.equal(p.base_stage, "修复期");
    assert.ok(p.base_note, "不一致就要解释");
    assert.ok(!p.base_note!.includes("被准入闸门压到"), `方向反了：「${p.base_note}」`);
    assert.ok(p.base_note!.includes("升到"), `要说成升上去：「${p.base_note}」`);
  });

  it("三闸门全过 + 涨停 60 → 高潮期;广度不足则退回修复期", () => {
    const pass = evaluateMarketGate(60, 0.62, {
      amountTotalYi: 18000, amountMa20Yi: 15000, indexShClose: 3800, indexShMa20: 3700,
      ladderHighest: 5, promotionRate: 0.5,
    });
    assert.equal(resolvePhase({ limitUp: 60, limitDown: 2, upRate: 0.62, gate: pass }).phase, "高潮期");
    assert.equal(
      resolvePhase({ limitUp: 80, limitDown: 1, upRate: 0.70, gate: evaluateMarketGate(80, 0.70, {
        amountTotalYi: 18000, amountMa20Yi: 15000, indexShClose: 3800, indexShMa20: 3700,
        ladderHighest: 5, promotionRate: 0.5,
      }) }).phase,
      "极度高潮期",
    );
    // 广度只有 50%:闸门本身就带广度 blocker,主升期也就不成立
    const narrow = evaluateMarketGate(60, 0.50, {
      amountTotalYi: 18000, amountMa20Yi: 15000, indexShClose: 3800, indexShMa20: 3700,
      ladderHighest: 5, promotionRate: 0.5,
    });
    assert.equal(narrow.allPass, false);
    assert.equal(resolvePhase({ limitUp: 60, limitDown: 2, upRate: 0.50, gate: narrow }).phase, "修复期", "广度不到 55% 不许叫主升期/高潮期");
  });

  it("涨停家数不够时,闸门再全过也到不了主升期", () => {
    const pass = { allPass: true, blockers: [], passed: ["广度"], unknown: [] };
    assert.equal(resolvePhase({ limitUp: 8, limitDown: 0, upRate: 0.70, gate: pass }).phase, "冰点期");
  });

  it("阶段单调:涨停家数增加不会让阶段往回退(同一广度/闸门条件下)", () => {
    const order = ["冰点期", "退潮期", "修复期", "主升期", "高潮期", "极度高潮期"];
    const pass = { allPass: true, blockers: [], passed: [], unknown: [] };
    let prev = -1;
    for (let lu = 0; lu <= 140; lu += 5) {
      const idx = order.indexOf(resolvePhase({ limitUp: lu, limitDown: 0, upRate: 0.65, gate: pass }).phase);
      assert.ok(idx >= prev, `涨停 ${lu} 家时阶段倒退:${order[prev]} → ${order[idx]}`);
      prev = idx;
    }
  });
});

describe("evaluateMarketGate 主升期闸门", () => {
  it("全部通过 → allPass=true,无 blockers", () => {
    const gate = evaluateMarketGate(50, 0.60, {
      amountTotalYi: 18000, amountMa20Yi: 15000, indexShClose: 3800, indexShMa20: 3700,
      ladderHighest: 5, promotionRate: 0.5,
    });
    assert.equal(gate.allPass, true);
    assert.equal(gate.blockers.length, 0);
    assert.equal(gate.passed.length, 3);
    assert.equal(gate.unknown.length, 0);
  });

  it("广度不足 → 阻止主升期", () => {
    const gate = evaluateMarketGate(47, 0.16, {
      amountTotalYi: 18000, amountMa20Yi: 15000, indexShClose: 3800, indexShMa20: 3700,
      ladderHighest: 5, promotionRate: 0.5,
    });
    assert.equal(gate.allPass, false);
    assert.ok(gate.blockers.some((b) => b.includes("广度")));
  });

  it("量能不足 → 阻止主升期", () => {
    const gate = evaluateMarketGate(50, 0.60, {
      amountTotalYi: 14000, amountMa20Yi: 15000, indexShClose: 3800, indexShMa20: 3700,
      ladderHighest: 5, promotionRate: 0.5,
    });
    assert.ok(gate.blockers.some((b) => b.includes("量能")));
  });

  it("指数低于 MA20 → 阻止主升期", () => {
    const gate = evaluateMarketGate(50, 0.60, {
      amountTotalYi: 18000, amountMa20Yi: 15000, indexShClose: 3599, indexShMa20: 3735,
      ladderHighest: 5, promotionRate: 0.5,
    });
    assert.ok(gate.blockers.some((b) => b.includes("MA20")));
  });

  /**
   * 🔴 这一条是第二轮的关键:没数据的门必须进 unknown,**不能**被当成「通过」。
   * 早先闸门在生产路径上从来没拿到 trend / ladder 数据,于是两道门形同不存在。
   */
  it("没有闸门数据时:广度门照样判,量能门与均线门记「未知」而不是「通过」", () => {
    const gate = evaluateMarketGate(50, 0.60, null);
    // 🔴 旧断言是 `allPass === true`（「没有门失败 → 放行」）—— 这正是漏洞所在：
    //    量能与均线根本没评估，却让主升期放行、仓位给到满档。现在有未知门就不是全过。
    assert.equal(gate.allPass, false, "有门没评估 → 不算全过（不知道 ≠ 通过）");
    assert.deepEqual(gate.passed, ["广度"], "只有广度门真的有数据");
    assert.equal(gate.unknown.length, 2, "量能门与均线门是「不知道」,不是「通过」");
    assert.equal(gate.blockers.length, 0, "但也没有门失败 —— 未知不等于失败");
  });

  it("模拟 10/30 收盘数据 → 三个门全不通过", () => {
    const gate = evaluateMarketGate(49, 0.1601, GATE_1030);
    assert.equal(gate.allPass, false);
    assert.ok(gate.blockers.some((b) => b.includes("广度")), "广度应不通过");
    assert.ok(gate.blockers.some((b) => b.includes("量能")), "量能应不通过(+5.8% < +10%)");
    assert.ok(gate.blockers.some((b) => b.includes("MA20")), "均线应不通过");
  });

  /**
   * 🔴 结构化三态：前端必须按 key 渲染，不许拿文案关键字猜。
   *    旧实现是 `blockers.some(b => b.includes("MA20"))` —— 措辞一改就静默变「通过」，
   *    把本该红的地方画成绿的。这里锁住 key / state / 顺序，三态各测一遍。
   */
  it("gate_items:三门顺序固定,state 三态齐全,且与 blockers/unknown 一致", () => {
    const all = evaluateMarketGate(49, 0.1601, GATE_1030);
    assert.deepEqual(all.items?.map((i) => i.key), ["breadth", "volume", "ma20"]);
    assert.deepEqual(all.items?.map((i) => i.state), ["fail", "fail", "fail"]);

    const mixed = evaluateMarketGate(50, 0.60, null); // 广度过，量能/均线没数据
    assert.deepEqual(mixed.items?.map((i) => i.state), ["pass", "unknown", "unknown"]);
    assert.ok(mixed.items?.every((i) => typeof i.label === "string" && i.detail.length > 0));

    const pass = evaluateMarketGate(50, 0.60, {
      amountTotalYi: 18000, amountMa20Yi: 15000, indexShClose: 3800, indexShMa20: 3700,
      ladderHighest: 5, promotionRate: 0.5,
    });
    assert.deepEqual(pass.items?.map((i) => i.state), ["pass", "pass", "pass"]);
    assert.equal(pass.allPass, true);

    // items 的 fail 数必须等于 blockers 数 —— 两套表达不许漂移
    assert.equal(
      all.items!.filter((i) => i.state === "fail").length,
      all.blockers.length,
      "items 与 blockers 说的必须是同一件事",
    );
  });
});

describe("风险等级由风险分决定,不与综合分打架", () => {
  it("风险分 15(地板)→ 极高风险,而不是「低风险」", () => {
    assert.equal(riskLevelOf(15, { limitDown: 0, downRate: 0 }), "extreme");
    assert.equal(riskLevelOf(80, { limitDown: 0, downRate: 0 }), "low");
  });

  it("盘面硬约束:跌停 ≥ 50 家时最少高风险,≥80 家且跌家占比 ≥70% 直接极高", () => {
    assert.equal(riskLevelOf(80, { limitDown: 55, downRate: 0.40 }), "high", "风险分说低风险,但跌停成片 → 至少高风险");
    assert.equal(riskLevelOf(80, { limitDown: 93, downRate: 0.83 }), "extreme");
  });

  it("算不出来(风险分 null)→ 等级也是 null,不许编", () => {
    assert.equal(riskLevelOf(null, { limitDown: 0, downRate: 0 }), null);
  });
});

describe("仓位上限:分数梯档 ∩ 闸门梯档", () => {
  const noBlocker = { blockers: [] as string[] };
  it("分数梯档单调", () => {
    assert.equal(positionCapOf(80, noBlocker), 100);
    assert.equal(positionCapOf(65, noBlocker), 70);
    assert.equal(positionCapOf(50, noBlocker), 40);
    assert.equal(positionCapOf(35, noBlocker), 20);
    assert.equal(positionCapOf(20, noBlocker), 0);
  });

  it("闸门失败越多压得越死,三闸门全灭 → 0", () => {
    assert.equal(positionCapOf(80, { blockers: ["a"] }), 40);
    assert.equal(positionCapOf(80, { blockers: ["a", "b"] }), 20);
    assert.equal(positionCapOf(80, { blockers: ["a", "b", "c"] }), 0, "三条都不配合,不让加仓");
  });

  it("10/30 实测:综合分 33 + 三门全灭 → 0%", () => {
    assert.equal(positionCapOf(33, { blockers: ["a", "b", "c"] }), 0);
  });

  /**
   * 🔴 2026-10-30 抓到的大坑：`allPass` 原本是 `blockers.length === 0`，
   *    于是东财趋势端点超时（量能 / 均线两门没数据）时，只要广度够 55%，
   *    就判「高潮期 · 可开新仓 40%」—— 恰好在最该保守的时候最激进。
   */
  it("有门没评估:不算通过,上限最多 40%,再高的分数也压住", () => {
    assert.equal(positionCapOf(80, { blockers: [], unknown: ["量能", "MA20"] }), 40);
    assert.equal(positionCapOf(95, { blockers: [], unknown: ["MA20"] }), 40);
    // 有失败门时仍按失败门走，不会因为 unknown 反而放宽
    assert.equal(positionCapOf(80, { blockers: ["a", "b", "c"], unknown: ["d"] }), 0);
  });

  it("三门都确定通过才给满档", () => {
    assert.equal(positionCapOf(80, { blockers: [], unknown: [] }), 100);
  });
});

/**
 * 🔴 2026-11-06 补的覆盖面：闸门没评估时早就压到 40%，但赚钱效应缺腿（共振 / 资金流
 *    没取到）不进 gate.unknown，分数按中性补位看着正常 → 实测 composite 78 直接给到 100% 上限。
 *    同一类「数据不全」两条路径一条挡一条不挡。这里复用同一档天花板，不另设标准。
 */
describe("仓位上限:数据完备性(与闸门未评估同一档)", () => {
  const pass = { blockers: [] as string[], unknown: [] as string[] };

  it("缺腿时不许给满档,分数再高也压住", () => {
    assert.equal(INCOMPLETE_DATA_CAP_PCT, 40, "刻意复用「闸门未评估」那一档,不引入第二套标准");
    assert.equal(positionCapOf(78, pass, { dataIncomplete: true }), 40);
    assert.equal(positionCapOf(95, pass, { dataIncomplete: true }), 40);
  });

  it("数据齐时一分不压,不许误杀好日子", () => {
    assert.equal(positionCapOf(78, pass), 100);
    assert.equal(positionCapOf(78, pass, { dataIncomplete: false }), 100);
  });

  it("闸门已经压得更死时不许被完备性抬高,取小始终成立", () => {
    assert.equal(positionCapOf(80, { blockers: ["a", "b"] }, { dataIncomplete: true }), 20);
    assert.equal(positionCapOf(80, { blockers: ["a", "b", "c"] }, { dataIncomplete: true }), 0);
    assert.equal(positionCapOf(35, pass, { dataIncomplete: true }), 20);
  });

  it("向后兼容:不传第三参时行为与改动前逐位一致", () => {
    assert.equal(positionCapOf(80, pass), 100);
    assert.equal(positionCapOf(65, pass), 70);
    assert.equal(positionCapOf(50, pass), 40);
    assert.equal(positionCapOf(35, pass), 20);
    assert.equal(positionCapOf(20, pass), 0);
  });
});

describe("退潮盘面下龙头维度不许靠独苗连板刷分", () => {
  it("广度 < 35% 且 跌停 ≥ 涨停 时,龙头分上限 55", () => {
    const d = scoreMarket({
      ...D1030,
      resonanceRates: [0.3], inflowRate: 0.1, promotionRate: 0.5, ladderHighest: 5,
      gateData: GATE_1030,
    });
    // 原始公式 min(5*10,60) + 0.5*30 = 65,退潮特征下压到 55
    assert.equal(d.dragon, 55);
  });

  it("普涨日子里同样的 5 板龙头,不会被打折", () => {
    const d = scoreMarket({
      limit_up: 60, limit_down: 2, up: 2800, down: 1200, flat: 200,
      resonanceRates: [0.7], inflowRate: 0.6, promotionRate: 0.5, ladderHighest: 5,
    });
    assert.equal(d.dragon, 65);
  });

  it("无梯队数据时龙头退化为涨停家数估分", () => {
    const d = scoreMarket({
      limit_up: 30, limit_down: 3, up: 1500, down: 500, flat: 200,
      resonanceRates: [0.5], inflowRate: 0.4, promotionRate: null, ladderHighest: null,
    });
    assert.equal(d.dragon, 36);
  });
});

describe("赚钱效应不吃「Top10 共振均值」的送分", () => {
  it("同样的广度下,全市场共振占比低 → 赚钱效应显著降低", () => {
    const base = {
      limit_up: 40, limit_down: 5, up: 2000, down: 1500, flat: 500,
      resonanceRates: [1.0], inflowRate: 0.3, promotionRate: null, ladderHighest: null,
    };
    const high = scoreMarket({ ...base, resonanceShare: 0.9 });
    const low = scoreMarket({ ...base, resonanceShare: 0.1 });
    assert.ok(high.earning - low.earning >= 15, `共振占比应有实质影响,实际 ${high.earning} vs ${low.earning}`);
  });

  it("没有聚合读数时退回展示行均值(向后兼容)", () => {
    const d = scoreMarket({
      limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200,
      resonanceRates: [0.6, 0.8, 0.7], inflowRate: 0.5, promotionRate: null, ladderHighest: null,
    });
    assert.ok(d.earning > 60, `赚钱效应应较高,实际 ${d.earning}`);
  });
});

/**
 * 🔴 2026-11-07:缺腿不许当 0 分,也不许当成利好。
 *
 * 旧写法「共振没取到 → 0、资金流没取到 → 0」会让数据源抽风那天凭空少 25 / 20 分,
 * 表现成「今天很差」;而单纯把权重全让给广度又会反过来把故障日算成好日子。
 * 现在的口径:缺的腿按 `min(中性先验, 已看到部分的加权均值)` 补位。
 */
describe("赚钱效应缺腿:按中性补位,既不按 0 也不按最优", () => {
  const 大涨 = { limit_up: 80, limit_down: 1, up: 2000, down: 200, flat: 100 };
  const 齐全 = { resonanceRates: [0.6], resonanceShare: 0.6, inflowRate: 0.5 };
  const 全缺 = { resonanceRates: [], resonanceShare: null, inflowRate: null };

  it("共振与资金流都没取到:分数高于「按 0 算」,低于数据齐全的好日子", () => {
    const miss = scoreMarket({ ...大涨, ...全缺, promotionRate: null, ladderHighest: null });
    const full = scoreMarket({ ...大涨, ...齐全, promotionRate: null, ladderHighest: null });
    const zero = scoreMarket({ ...大涨, resonanceRates: [0], resonanceShare: 0, inflowRate: 0, promotionRate: null, ladderHighest: null });
    assert.ok(miss.earning > zero.earning, `缺数据(${miss.earning})不该比真的差(${zero.earning})还低`);
    assert.ok(miss.earning < full.earning, `缺数据(${miss.earning})不该比数据齐全的好日子(${full.earning})还高 —— 那是取数故障当利好`);
  });

  it("只缺共振 / 只缺资金流:都能算出来,且只比齐全时低一点", () => {
    const noRes = scoreMarket({ ...大涨, resonanceRates: [], resonanceShare: null, inflowRate: 0.5, promotionRate: null, ladderHighest: null });
    const noFlow = scoreMarket({ ...大涨, resonanceRates: [0.6], resonanceShare: 0.6, inflowRate: null, promotionRate: null, ladderHighest: null });
    const full = scoreMarket({ ...大涨, ...齐全, promotionRate: null, ladderHighest: null });
    assert.ok(noRes.earning > 0 && noFlow.earning > 0);
    assert.ok(noRes.earning <= full.earning && noFlow.earning <= full.earning);
  });

  it("显式给 0 仍然按 0 算:那是「真的差」,不是「没数据」", () => {
    const a = scoreMarket({ ...大涨, resonanceRates: [], resonanceShare: 0, inflowRate: 0, promotionRate: null, ladderHighest: null });
    const b = scoreMarket({ ...大涨, resonanceRates: [], resonanceShare: null, inflowRate: null, promotionRate: null, ladderHighest: null });
    assert.ok(a.earning < b.earning, `显式 0(${a.earning})应低于没数据(${b.earning})`);
  });

  it("盘面很差时缺腿不会把分数拉回来", () => {
    const 大跌 = { limit_up: 12, limit_down: 30, up: 400, down: 1800, flat: 100 };
    const miss = scoreMarket({ ...大跌, ...全缺, promotionRate: null, ladderHighest: null });
    assert.ok(miss.earning < 25, `广度 17% 的一天缺了数据也应是低分,实际 ${miss.earning}`);
  });
});

describe("权重定义", () => {  it("五项原始权重之和为 1", () => {
    const sum = Object.values(MARKET_WEIGHTS).reduce((a, c) => a + c, 0);
    assert.equal(Math.round(sum * 100) / 100, 1);
  });
});
