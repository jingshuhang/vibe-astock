/**
 * 当日机会发现（宽度优先）单元测试。
 *
 * 🔴 这份测试护的是「广度不等于上涨家数多」这一条：
 *    上涨 80% 但中位涨幅 −0.3%（涨的都是微涨、跌的是大票）**不是**板块在涨，
 *    必须判成「分化」而不是「在动」。这是这类指标最容易被读反的地方。
 *
 * 另外护「数据不足不许判」：只拿到 3 只行情就下结论，等于用 3 只票代表一个板块。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { medianOf, stateOf, WIDTH } from "../src/finance/day_opportunity.ts";

describe("medianOf 中位数", () => {
  it("奇数个取中间", () => {
    assert.equal(medianOf([3, 1, 2]), 2);
  });

  it("偶数个取中间两个的平均（不是随便挑一个）", () => {
    assert.equal(medianOf([4, 1, 3, 2]), 2.5);
  });

  it("空数组返回 null —— 不拿 0 冒充", () => {
    assert.equal(medianOf([]), null, "0 会被读成「持平」，null 才是「没有」");
  });

  it("不修改入参数组", () => {
    const xs = [3, 1, 2];
    medianOf(xs);
    assert.deepEqual(xs, [3, 1, 2]);
  });

  it("极端值不影响中位数（这就是为什么不用均值做主排序）", () => {
    assert.equal(medianOf([1, 1, 1, 1, 100]), 1);
  });
});

describe("stateOf 广度档位", () => {
  const MIN = WIDTH.min_quoted;

  it("样本太少（<5 只）→ 数据不足，不许下结论", () => {
    const r = stateOf(0.9, 3, MIN - 1);
    assert.equal(r.state, "数据不足");
    assert.ok(r.why[0].includes("少于"), r.why.join(" | "));
  });

  it("上涨 ≤30% → 走弱", () => {
    assert.equal(stateOf(0.3, -1.5, 50).state, "走弱");
    assert.equal(stateOf(0.03, -5.14, 137).state, "走弱");
  });

  it("上涨 ≥60% 且中位 >0 → 在动", () => {
    const r = stateOf(0.69, 1.21, 36);
    assert.equal(r.state, "在动");
    assert.ok(r.why.join(" ").includes("价格和广度同向"));
  });

  it("🔴 上涨 80% 但中位 ≤0 → 分化，不是「在动」", () => {
    const r = stateOf(0.8, -0.3, 100);
    assert.equal(r.state, "分化", "涨的都是微涨、跌的是大票，这不叫板块在涨");
    assert.ok(r.why.join(" ").includes("微涨"), r.why.join(" | "));
  });

  it("中位刚好 0 → 也算分化（不能因为「不是负的」就放过）", () => {
    assert.equal(stateOf(0.7, 0, 50).state, "分化");
  });

  it("上涨在 30%~60% 之间 → 平淡（既不吹也不砸）", () => {
    assert.equal(stateOf(0.45, 0.2, 50).state, "平淡");
    assert.equal(stateOf(0.33, -1.42, 196).state, "平淡");
  });

  it("边界值按配置走，不是散落的魔法数", () => {
    assert.equal(stateOf(WIDTH.up_strong, 0.01, 50).state, "在动");
    assert.equal(stateOf(WIDTH.up_weak, 0.01, 50).state, "走弱");
  });

  it("每档都写清依据（含具体百分比），不留空话", () => {
    for (const r of [stateOf(0.9, 2, 50), stateOf(0.2, -3, 50), stateOf(0.8, -0.5, 50), stateOf(0.45, 0, 50)]) {
      assert.ok(r.why.length >= 2, `${r.state} 的依据少于 2 条`);
      assert.ok(r.why.some((w) => /\d/.test(w)), `${r.state} 的依据里没有数字`);
    }
  });
});
