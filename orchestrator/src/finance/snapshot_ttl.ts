/**
 * 快照时效：**每个端点都必须在表里有名字，任何键都不许永不过期。**
 *
 * 🔴 为什么需要这张表（2026-11-06 的事故）：
 *    `DEFAULT_CONSISTENCY` 是 `{ mode: "prefer_cache" }`，**不带 `max_age_ms`**；而
 *    `snapshotUsable` 在「一个上限都没有」时直接 `return true`。快照键又只由「端点 + 参数」
 *    决定、**不含日期** —— 于是同一把键一旦被写，就永远命中、永不重取。
 *    实测：`cn_shortline_themes{top:12}` 自 **10-30** 起再没换过，页面上「三季报增长 15 只 /
 *    最高 5 板 / 龙头青岛食品封单 0.57 亿」摆了整整 7 天，而同屏的「涨停 26 / 炸板 11」是当天实时。
 *    看着「新」的端点其实都是**别人在替它刷**（live 靠后台常驻采集、em_* 靠市场状态、
 *    sina_board_flow 靠盯盘概况轮询）—— 没有第二个调用方的那把键就永久冻结。
 *    这类 bug 不报错，只让同屏并存两个日期。
 *
 *    还有第二道门：视图动作的 `body` 参数常年写作 `_body`、全程没读过，页面 `?refresh=1`
 *    被直接丢掉 —— **点「刷新」也救不回来**。所以这里一并给出 `wantsFresh()`。
 *
 * 取值原则：**这份数据本身多久变一次**，不是「我想多久刷一次」。
 *  - 跟盘走（盘中每几秒就变）→ 秒级；
 *  - 收盘档 / 日更 / 一天只该换一次 → 12 小时（早上开盘前必然过期重取，拿到昨晚那份）；
 *  - 键里带日期、内容不可变的**不进这张表**（如「过去某天的涨停明细」），
 *    给它们加时效只会让一次刷新把 20 天全部重取一遍。
 *
 * ⚠️ **这层不是最终生效的那张表，别把它当成唯一真源**。还有第二套硬上限：
 *    `datasources/registry.json` 每个端点的 `cache_max_age_sec`，由 `service.ts` 读出后
 *    传给 `snapshotUsable`，与这里给的 `max_age_ms` 取 `Math.min` —— 谁更严听谁的。
 *    2026-11-08 实测：注册表 182 个端点里 54 个有声明，与本表重叠 11 个、其中 8 个数值不同
 *    （`cn_shortline_live` 本表 30s / 注册表 15s → 实际 15s；`tx_quotes_batch` 本表 20s /
 *    注册表 300s → 实际 20s；`em_market_trend`、`cctv_news` 两侧一致）。
 *    **刻意不把两张表并成一张**：统一数值会改变真实取数频率（可能把 15s 放宽到 30s，
 *    也可能把 300s 收紧到 20s 而打爆上游），那是行为变更、需要盘中实机验证，不能顺手做。
 *    口径与分叉清单写在 README「快照时效」，护栏见 `test/ttl_declarations.test.ts`。
 */
import { DEFAULT_PREFER_CACHE_MAX_AGE_MS, type Consistency } from "../snapshot.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 批量行情：跟盘走，但一轮要打好几批，比逐笔略放宽 */
export const QUOTE_MAX_AGE_MS = 20_000;

export const SNAPSHOT_MAX_AGE_MS: Record<string, number> = {
  // ── 盘中此刻：跟盘走 ───────────────────────────────────────────────────────
  cn_shortline_live: 30_000,
  tx_quotes_batch: QUOTE_MAX_AGE_MS,
  em_market_breadth: MIN,
  em_industry_comparison: MIN,
  // 指数日线 + 两市成交额：日线一天不变，成交额随盘变；但一次要 38s（尾部 88s），
  // 给太短等于每屏都重跑一遍慢路径，给 5 分钟是「够新」与「别把闸门拖死」的折中。
  em_market_trend: 5 * MIN,
  // ── 收盘档 / 日更：一天只该换一次 ─────────────────────────────────────────
  cn_shortline_themes: 12 * HOUR,
  cn_shortline_theme_rotation: 12 * HOUR,
  cn_shortline_board_ladder: 12 * HOUR,
  cn_shortline_cycle: 12 * HOUR,
  cn_shortline_facts: 12 * HOUR,
  cn_shortline_settled: 12 * HOUR,
  // 成分清单：一天一变（板块成分调整才会动），但**没人给过上限**，等于永久冻结
  index_constituents: 12 * HOUR,
  // 新闻联播：一天一期
  cctv_news: 60 * MIN,
  // ── 键里带日期、但「今天」那一份还在变 ────────────────────────────────────
  // 这几个端点的 args 含 `date`：过去的日子内容不可变，而 `date=今天` 那一份盘中一直在变。
  // 统一给 5 分钟 —— 过去的日子多花几次重取（每个约 2 秒），换今天那份不许冻住。
  em_zt_pool: 5 * MIN,
  em_limit_up_sentiment: 5 * MIN,
  cn_shortline_ladder: 5 * MIN,
  cn_shortline_firstboard: 5 * MIN,
  // ── 旁证：仅当日、随盘变 ──────────────────────────────────────────────────
  sina_board_flow: 2 * MIN,
};

/** 表里没有的端点用这个兜底 —— 漏写最多是慢一点，不是错一屏；与 Core 的缺省同一个值 */
export const SNAPSHOT_FALLBACK_MAX_AGE_MS = DEFAULT_PREFER_CACHE_MAX_AGE_MS;

/** 视图 query 里的 `?refresh=1` 是「我不信缓存」，原样交给取数层 */
export function wantsFresh(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * 取一次数该用哪种一致性。
 * `force`（页面点了刷新）→ 真取；否则按端点的时效上限命中/重取，且**永不无限期命中**。
 */
export function consistencyFor(endpoint: string, force = false): Consistency {
  if (force) return { mode: "fresh" };
  return {
    mode: "prefer_cache",
    max_age_ms: SNAPSHOT_MAX_AGE_MS[endpoint] ?? SNAPSHOT_FALLBACK_MAX_AGE_MS,
  };
}
