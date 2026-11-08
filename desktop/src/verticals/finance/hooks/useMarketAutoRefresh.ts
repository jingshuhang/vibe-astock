/**
 * 「判断页」的自动刷新：交易时段定时取一次 + 切回前台时补一次。
 *
 * 为什么要有这个 hook：`Opportunity` 早就各写了一遍（2 分钟定时 + `document.hidden` 跳过），
 * 而 `MarketState` / `ShortlineOpportunities` / `TradePlans` 三页**连定时器都没有**，
 * 只有「重新取数」按钮 —— 用户看到的是「这一屏永远不动」。手动复制三遍必然漂移，
 * 所以收到一处，三页共用；`Opportunity` 也换成它，行为对齐。
 *
 * 🔴 两条容易踩的：
 *  1. **隐藏标签页里浏览器会把 `setInterval` 降频到 1 分钟一拍**，而这里又主动跳过
 *     （`document.hidden` 时不取数，省 CPU 和取数进程）。两条叠在一起 →
 *     「切走半小时再切回」看到的还是切走前那份，而按钮上写着「自动刷新 开」。
 *     所以必须有 `visibilitychange` 补刷（2026-11-06 实测：后台 31 分钟回来，
 *     读数还是「1900s 前取的」）。
 *  2. **只在数据确实过期时补**：一轮要跑十几秒、起好几个取数进程，
 *     来回切标签就重跑不值得。判据用页面自己的「上次取完的时刻」，不用 hook 内部时钟 ——
 *     内部时钟只知道「我上次触发过」，不知道「你在别处也取过」。
 */
import { useEffect, useRef } from "react";

import { isMarketTrading } from "@/lib/marketSymbol";
import { shouldRefreshOnVisible, shouldTickOnInterval } from "./marketRefreshPolicy";

export const REFRESH_MS = 120_000;

export function useMarketAutoRefresh(opts: {
  /** 到了该取数的时候调用。**必须是稳定的引用**（useCallback），否则不会重新挂定时器 */
  onTick: () => void;
  /** 页面最近一次「取完数」的时刻（`Date.now()`）；null = 还没取过 */
  loadedAt: number | null;
  /** 关掉开关时传 false */
  enabled?: boolean;
  intervalMs?: number;
}): void {
  const { loadedAt, enabled = true, intervalMs = REFRESH_MS } = opts;
  // onTick 放 ref：页面每次渲染都会新建闭包，直接进依赖会让定时器每渲染重置一次，
  // 高频重渲染的页面上「每 2 分钟」会退化成「永远差一点」。
  const tick = useRef(opts.onTick);
  tick.current = opts.onTick;

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      // 判据与补刷共用一份纯函数,免得「定时器那一拍」和「切回前台那一拍」慢慢漂移。
      if (shouldTickOnInterval({ hidden: document.hidden, trading: isMarketTrading("CN") })) tick.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (!shouldRefreshOnVisible({
        hidden: document.hidden,
        trading: isMarketTrading("CN"),
        loadedAt,
        now: Date.now(),
        intervalMs,
      })) return;
      tick.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, intervalMs, loadedAt]);
}
