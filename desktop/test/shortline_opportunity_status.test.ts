/**
 * 「超短线机会发现」空清单文案 / 缺口表达回归。
 *
 * 2026-11-10 实机：这一页的取数链整条断掉（日期格式 + 字段名 + 失败信封被吞），
 * 上游 53 只涨停股，页面却一直显示「今天没有匹配到模式的机会」且**零报错** ——
 * 把取数故障伪装成一条合法的市场结论。修数据链之外，界面也必须能区分
 * 「没取到」与「真的没匹配到」，并把缺口带进 AI 上下文。
 *
 * 文案判据抽成 `emptyOpportunityHint()` 纯函数真跑；其余为源码结构断言（本机无 jsdom）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptyOpportunityHint } from "../src/verticals/finance/lib/shortlineOpportunities.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const page = read("pages/ShortlineOpportunities.tsx");
const lib = read("lib/shortlineOpportunities.ts");
const backend = readFileSync(new URL("../../orchestrator/src/finance/shortline/opportunities.ts", import.meta.url), "utf8");

// ─── 行为：空清单三态 ────────────────────────────────────────────────────────────
test("[行为] failed：空清单是「没取到」，不许写成今天没有机会", () => {
  const s = emptyOpportunityHint({ status: "failed", gaps: ["涨停池没取到"], notes: [] });
  assert.match(s, /没取到/);
  assert.match(s, /≠ 今天没有机会/);
  assert.doesNotMatch(s, /今天没有匹配到模式的机会。/);
});

test("[行为] partial：有缺口要指到降级提示；ok：才是真的没匹配到", () => {
  const partial = emptyOpportunityHint({ status: "partial", gaps: ["封板率没取到"], notes: [] });
  assert.match(partial, /今天没有匹配到模式的机会/);
  assert.match(partial, /降级提示/);
  const ok = emptyOpportunityHint({ status: "ok", gaps: [], notes: [] });
  assert.equal(ok, "今天没有匹配到模式的机会。");
});

test("[行为] 老后端没有 status：用 notes 兜底，别把有降级提示的一轮当成 ok", () => {
  assert.match(emptyOpportunityHint({ notes: ["涨停池取数失败"] }), /降级提示/);
  assert.equal(emptyOpportunityHint({ notes: [] }), "今天没有匹配到模式的机会。");
  assert.match(emptyOpportunityHint({ status: "failed", notes: [] }), /≠ 今天没有机会/, "status 优先于 notes 兜底");
});

// ─── 结构：界面真的用了这套判据 ──────────────────────────────────────────────────
test("[结构] 空清单走 emptyOpportunityHint，写死的旧文案不许回来", () => {
  assert.match(page, /\{emptyOpportunityHint\(data\)\}/);
  assert.doesNotMatch(page, />今天没有匹配到模式的机会。<\/p>/, "旧文案会把取数失败伪装成合法结论");
  assert.match(lib, /status === "failed"/);
  assert.match(lib, /≠ 今天没有机会/);
});

test("[结构] 缺口合并 gaps / notes，并带进 AI 上下文", () => {
  const gapDef = page.indexOf("const allGaps");
  const ai = page.indexOf("useAiPage({");
  assert.ok(gapDef > 0 && ai > gapDef, "allGaps 必须在 useAiPage 之前算好，否则上下文引用不到");
  assert.match(page, /\.\.\.new Set\(\[\.\.\.\(data\.gaps \?\? \[\]\), \.\.\.\(data\.notes \?\? \[\]\)\]\)/);
  assert.match(page, /数据状态:\$\{data\.status/);
  assert.match(page, /本轮数据缺口/);
  assert.match(page, /allGaps\.slice\(0, 6\)/);
  assert.match(page, /allGaps\.map/);
  assert.doesNotMatch(page, /notes\.map/, "降级提示不该只读 notes（新后端的 gaps 会丢）");
});

test("[结构] failed 时概览不许把「没取到」显示成 0 家", () => {
  assert.match(page, /data\.status === "failed"/);
  assert.match(page, /没取到，不是 0 家/);
});

test("[结构] 产品口径不动：仍只列客观模式和条件，不给买卖建议", () => {
  assert.equal((page.match(/只列客观模式和条件，不给买卖建议/g) ?? []).length, 2,
    "两处副标题都不许改成推荐 / 买卖建议");
});

// ─── 结构：后端取数契约不许退回旧字段名 ──────────────────────────────────────────
test("[结构] 后端按真实信封解析，旧断链写法不许回来", () => {
  assert.doesNotMatch(backend, /field === "code"/, "mapper 根本没有 code 字段，record_key 才是代码");
  assert.doesNotMatch(backend, /q\("em_zt_pool", \{ date: day \}\)/, "日期必须 compact 成 YYYYMMDD");
  assert.match(backend, /day\.replaceAll\("-", ""\)/);
  assert.match(backend, /pool_limit_days/);
  assert.match(backend, /pool_amount/, "成交额要取 amount，不是换手率");
  assert.match(backend, /cn_shortline_daily/, "三池计数源实机会 failed，必须有 broken_rate 主源");
  assert.match(backend, /envelopeUsable\(envs\.ztPool\)/, "失败信封必须判，不能只判 allSettled");
  assert.match(backend, /status: OpportunityStatus/);
  assert.match(backend, /notes: gaps/, "台账快照读 notes，两处要同源");
});
