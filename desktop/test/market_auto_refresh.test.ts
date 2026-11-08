/**
 * 自动刷新状态机的回归护栏。
 *
 * 这个 hook 修过「后台放半小时、切回来还是 1900s 前取的」，但此前**零测试**：
 * 去掉 visibilitychange、把 `>=` 改回 `<`、把 loadedAt 记进 finally，
 * 都不会有任何测试变红。判据已抽到 marketRefreshPolicy.ts，这里真跑纯函数；
 * hook 本体（依赖 document / React）用结构断言钉住接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shouldRefreshOnVisible, shouldTickOnInterval } from "../src/verticals/finance/hooks/marketRefreshPolicy.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const hook = read("hooks/useMarketAutoRefresh.ts");
const NOW = 1_700_000_000_000;
const MS = 120_000;

test("[行为] 定时器那一拍：只在页面可见且交易时段取数", () => {
  assert.equal(shouldTickOnInterval({ hidden: false, trading: true }), true);
  assert.equal(shouldTickOnInterval({ hidden: true, trading: true }), false, "隐藏标签页跳过,省 CPU 与取数进程");
  assert.equal(shouldTickOnInterval({ hidden: false, trading: false }), false, "休市不取");
  assert.equal(shouldTickOnInterval({ hidden: true, trading: false }), false);
});

test("[行为] 切回前台：只有确实过期才补,一次没取过就立刻补", () => {
  const base = { hidden: false, trading: true, now: NOW, intervalMs: MS };
  assert.equal(shouldRefreshOnVisible({ ...base, loadedAt: null }), true, "从没取过不许再等两分钟");
  assert.equal(shouldRefreshOnVisible({ ...base, loadedAt: NOW - 1 }), false, "刚取完,切回来不重跑");
  assert.equal(shouldRefreshOnVisible({ ...base, loadedAt: NOW - MS + 1 }), false, "差 1ms 没过期就不补");
  assert.equal(shouldRefreshOnVisible({ ...base, loadedAt: NOW - MS }), true, "正好到期要补(>=,不是 >)");
  assert.equal(shouldRefreshOnVisible({ ...base, loadedAt: NOW - 31 * 60_000 }), true, "后台半小时回来必须补");
});

test("[行为] 隐藏页 / 休市时即使数据早已过期也不补", () => {
  const stale = { trading: true, loadedAt: NOW - 10 * MS, now: NOW, intervalMs: MS };
  assert.equal(shouldRefreshOnVisible({ ...stale, hidden: true }), false);
  assert.equal(shouldRefreshOnVisible({ ...stale, hidden: false, trading: false }), false);
});

test("[结构] hook 的接线不许回退：纯函数、ref 稳定化、清理与依赖都在", () => {
  assert.ok(hook.includes("shouldRefreshOnVisible({"), "补刷要走共享判据");
  assert.ok(hook.includes("shouldTickOnInterval({"), "定时器那一拍也要走共享判据");
  assert.doesNotMatch(hook, /Date\.now\(\) - \(loadedAt \?\? 0\) < intervalMs/, "不许退回内联的两套判据");
  assert.ok(hook.includes("const tick = useRef(opts.onTick)") && hook.includes("tick.current()"),
    "onTick 必须走 ref,否则每次渲染都重挂定时器");
  assert.ok(hook.includes("window.clearInterval(timer)"), "定时器要清理");
  assert.ok(hook.includes('document.removeEventListener("visibilitychange", onVisible)'), "监听器要清理");
  assert.ok(hook.includes("[enabled, intervalMs, loadedAt]"), "loadedAt 变了要重挂补刷监听");
  assert.ok(hook.includes("document.addEventListener(\"visibilitychange\", onVisible)"), "visibilitychange 不能丢");
});

test("[结构] 四个判断页都挂了同一个 hook，不许某页悄悄掉队", () => {
  for (const p of ["pages/MarketState.tsx", "pages/Opportunity.tsx", "pages/ShortlineOpportunities.tsx", "pages/TradePlans.tsx"]) {
    assert.ok(read(p).includes("useMarketAutoRefresh({"), `${p} 没挂自动刷新`);
  }
});
