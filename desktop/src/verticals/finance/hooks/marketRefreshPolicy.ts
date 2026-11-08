/**
 * 「判断页」自动刷新的**补刷判据**，抽成零依赖纯函数。
 *
 * 为什么单独一个文件：hook 本体依赖 React 与 document，而 desktop 的测试是
 * `node --test`（没有 DOM，也不该为一条判据引入 jsdom）。状态机里最容易回归的
 * 正是「切回前台要不要补」这一步（2026-11-06 实测：后台 31 分钟回来，
 * 读数还是「1900s 前取的」）。把它独立出来才能真跑，hook 里只剩接线。
 */
export interface RefreshPolicy {
  hidden: boolean;
  trading: boolean;
  /** 最近一次**取完数**的时刻；null = 还没取过 */
  loadedAt: number | null;
  now: number;
  intervalMs: number;
}

/** 定时器那一拍要不要取数。隐藏标签页 / 非交易时段一律跳过。 */
export function shouldTickOnInterval(p: Pick<RefreshPolicy, "hidden" | "trading">): boolean {
  return !p.hidden && p.trading;
}

/**
 * 切回前台要不要立刻补一次。
 * `loadedAt` 为 null（一次都没取过）时立刻补，不等两分钟；
 * 只有**确实过期**才补 —— 来回切标签就重跑一轮十几秒的取数不值得。
 */
export function shouldRefreshOnVisible(p: RefreshPolicy): boolean {
  if (p.hidden || !p.trading) return false;
  return p.now - (p.loadedAt ?? 0) >= p.intervalMs;
}
