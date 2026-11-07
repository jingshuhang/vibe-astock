/**
 * 五维评分的**界面叫法**与方向说明。
 *
 * 起因:2026-11-06 截图里「风险 15」被读成「风险很低」,而这一维量的是安全度,
 * 15 分其实是极危险。改名「抗跌度」并在每个环下写清高分那一端是什么意思。
 * 🔴 这里只管文案:字段名、分数、权重、阶段与闸门判据一个都不许跟着改。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DIMENSION_LABELS } from "../src/verticals/finance/lib/marketState.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const backend = (p: string) => readFileSync(new URL(`../../orchestrator/src/finance/${p}`, import.meta.url), "utf8");

test("五维都是越高越正面;原来叫「风险」的那一维改叫「抗跌度」", () => {
  assert.equal(DIMENSION_LABELS.risk.label, "抗跌度");
  assert.equal(DIMENSION_LABELS.risk.hint, "越高越安全");
  assert.deepEqual(
    Object.entries(DIMENSION_LABELS).map(([k, v]) => [k, v.hint]),
    [["emotion", "越高越热"], ["dragon", "越高越强"], ["risk", "越高越安全"], ["earning", "越高越好赚"], ["event", "越高越偏多"]],
  );
  assert.ok(Object.values(DIMENSION_LABELS).every((v) => v.hint.startsWith("越高")), "五维同向,不许冒出反向维");
});

test("独立页与盯盘内嵌版共用同一份标签,不再各写一份", () => {
  const page = read("pages/MarketState.tsx");
  const tab = read("shortline/OverviewTab.tsx");
  for (const src of [page, tab]) {
    assert.ok(src.includes("DIMENSION_LABELS.risk.label"), "风险那一个环要走共享标签");
    assert.doesNotMatch(src, /label="风险"/, "旧叫法不能留在环上");
    assert.ok(src.includes("分越高越正面"), "页面上要写明方向");
    for (const k of ["emotion", "dragon", "risk", "earning", "event"]) {
      assert.ok(src.includes(`DIMENSION_LABELS.${k}.hint`), `${k} 少了方向说明`);
    }
  }
});

test("公式、给 AI 的上下文、后端 reason 同步改名", () => {
  const page = read("pages/MarketState.tsx");
  const view = backend("market_state.ts");
  assert.ok(page.includes('push(DIMENSION_LABELS.risk.label, dimensions.risk)'), "公式里的名字跟着环走");
  assert.ok(page.includes("抗跌度${"), "给 AI 的五维文本要写新名字与方向");
  assert.doesNotMatch(page, /风险\$\{/, "别在给 AI 的文本里留下旧的裸名字");
  assert.ok(view.includes("分越高越正面：情绪") && view.includes("抗跌度 ${signal.risk_score}"));
  assert.doesNotMatch(view, /·风险 \$\{signal\.risk_score\}/);
});

test("判据一个字没动:分数公式、字段名、权重都不受影响", () => {
  const score = backend("market_score.ts");
  assert.ok(score.includes("const riskScore = clamp(100 - (limitDown * 2 + downRate * 100), 15, 100);"), "风险分公式不许改");
  assert.ok(score.includes("risk: Math.round(riskScore)"), "维度 key 仍是 risk");
  assert.ok(score.includes("risk: 0.15"), "名义权重仍是 0.15");
});
