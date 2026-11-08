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
import { DIMENSION_LABELS, RISK_LEVEL_HINT, RISK_LEVEL_META } from "../src/verticals/finance/lib/marketState.ts";

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

test("风险等级徽标与「抗跌度」方向相反:同源说明 + 悬停提示都到位,四档判据仍未动", () => {
  const page = read("pages/MarketState.tsx");
  const tab = read("shortline/OverviewTab.tsx");
  assert.match(RISK_LEVEL_HINT, /方向相反/);
  assert.match(RISK_LEVEL_HINT, /抗跌度分越低越危险/);
  assert.ok(page.includes("title={RISK_LEVEL_HINT}"), "徽标要带悬停说明");
  assert.ok(page.includes("{RISK_LEVEL_HINT}"), "说明要看得见,不能只藏在 title 里");
  assert.ok(tab.includes("方向相反"), "盯盘内嵌版也要当场说破");
  assert.deepEqual(Object.values(RISK_LEVEL_META).map((x) => x.label), ["低风险", "中风险", "高风险", "极高风险"],
    "四档 label 一个都不许改");
  assert.equal(Object.keys(RISK_LEVEL_META).length, 4, "不许顺手加档/改判据");
});

/**
 * 2026-11-08 盘点：后端 `sources` 是六路**预期**来源常量，页面和 AI 上下文却写成
 * 「数据来源」；`data_as_of` 装的是取数日期，字段名却叫「数据日期」。两处都会让人
 * 把「设计上会取」读成「这次取到了」、把「什么时候取」读成「数据是哪天的」。
 * 本轮只钉口径、不动任何判据（真实归属日待 2026-11-09 盘中实机取证）。
 */
test("来源清单与取数日期的口径不许读反:页面 / AI 上下文都写明是「预期」和「取数时间」", () => {
  const page = read("pages/MarketState.tsx");
  const view = backend("market_state.ts");
  assert.match(view, /const DECLARED_SOURCES = \[/, "常量名要说清是声明式清单");
  assert.match(view, /声明式清单,不是本次实际命中核对/);
  assert.match(view, /不是数据归属日/, "字段注释要当场说破");
  assert.match(view, /2026-11-09.*实机取证/, "改判据要等实机，别凭静态推断");
  assert.equal((page.match(/不代表本次全部取到/g) ?? []).length, 2,
    "算不出来 / 算得出来两条 AI 上下文都要带这句");
  assert.ok(page.includes("不是本次实际命中核对"), "页面也要看得见，不能只藏在 title 里");
  assert.ok(page.includes("各来源取数日期（不是数据归属日）"));
  assert.doesNotMatch(page, /各来源数据日期：/, "旧口径不许回来");
  assert.doesNotMatch(page, /`数据来源: \$\{data\.signal\.sources/, "旧两态文案不许回来");
});
