/**
 * 「机会发现」页喂给 AI 的上下文必须和界面一样诚实。
 *
 * 两个真实缺陷（2026-11-08 只读盘点）：
 *  ① `can_open_position` 是三态（true / false / null），AI 上下文却写成两态，
 *     `null`（算不出来、不设仓位上限）被压成「不可开新仓」这条禁止性结论；
 *  ② `gaps` / `notes` / `staleNote` 定义在 `useAiPage` **之后**，上下文一个字都没引用 ——
 *     界面上「N 项缺口 / 降级提示」只给人看，模型以为数据是完整的。
 *
 * 三态文案抽成纯函数后可真跑；其余是源码结构断言（无 jsdom，不渲染组件）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canOpenLabel } from "../src/verticals/finance/lib/marketState.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const page = read("pages/Opportunity.tsx");
const statePage = read("pages/MarketState.tsx");

test("[行为] 能不能开新仓是三态：算不出来不许写成「不可开新仓」", () => {
  assert.equal(canOpenLabel(true), "可开新仓");
  assert.equal(canOpenLabel(false), "暂不开新仓");
  assert.equal(canOpenLabel(null), "能不能开新仓：不知道（算不出来）");
  assert.equal(canOpenLabel(undefined), "能不能开新仓：不知道（算不出来）");
  assert.ok(!canOpenLabel(null).includes("不可开新仓"), "null 不能变成一条禁止性结论");
});

test("[结构] 独立页的三态文案与共享函数同源，别让两处漂移", () => {
  assert.ok(canOpenLabel(true) && statePage.includes(canOpenLabel(true)), "独立页要有「可开新仓」");
  assert.ok(statePage.includes(canOpenLabel(false)), "独立页要有「暂不开新仓」");
  assert.ok(statePage.includes("能不能开新仓：不知道"), "独立页也要有「不知道」那一态");
});

test("[结构] 缺口 / 降级 / 陈旧说明必须在 useAiPage 之前算好，并且真的进了上下文", () => {
  const aiAt = page.indexOf("useAiPage({");
  assert.ok(aiAt > 0, "useAiPage 调用要还在");
  for (const decl of ["const gaps =", "const notes =", "const staleDims =", "const staleNote ="]) {
    const at = page.indexOf(decl);
    assert.ok(at > 0, `${decl} 不能丢`);
    assert.ok(at < aiAt, `${decl} 必须定义在 useAiPage 之前，否则上下文读不到`);
  }
  const ctx = page.slice(aiAt, page.indexOf("suggestions:", aiAt));
  for (const k of ["gaps.length", "notes.length", "staleNote", "errors.length", "canOpenLabel(co)"]) {
    assert.ok(ctx.includes(k), `AI 上下文里要带 ${k}`);
  }
  assert.doesNotMatch(page, /\$\{co \? "可开新仓" : "不可开新仓"\}/, "两态旧写法不许回来");
});

test("[结构] 市场状态这一路挂了要明说，不许静默用机会链简版顶上", () => {
  assert.ok(page.includes("市场状态这一路本次没取到"), "mkt 为 null 时要有显式告警");
  assert.ok(page.includes("闸门不全、仓位上限偏宽"), "要说清简版为什么不可靠");
});
