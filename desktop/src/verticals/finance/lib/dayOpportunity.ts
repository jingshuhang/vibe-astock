/**
 * 当日机会发现（宽度优先）—— 前端类型与配色。
 *
 * 与 `lib/opportunity.ts`（板块机会链）是两条路，不是一套：
 *   - 机会链从**涨停池**出发（题材 → 龙头 → 次日规划），起点是「已经涨停」；
 *   - 这里从**指数成分股**出发（有多少只在涨），**完全不依赖涨停池**，
 *     所以「一只涨停都没有」的时候也能看出板块在动。
 *
 * 🔴 涨=红、跌=绿（A 股习惯），与全站 pctColor 一致。
 */

export type BreadthState = "在动" | "分化" | "平淡" | "走弱" | "数据不足";

/**
 * 某一天的板块宽度（回溯点）。
 *
 * 🔴 历史是**回溯**出来的（通达信盘后包带 date 参数，官网从 2022 年起都留着），
 *    不是「一天天攒」—— 第一次打开就能算近 5 天。缓存只是让第二天只新增 1 天。
 */
export interface BreadthHistoryPoint {
  date: string;
  up_rate: number;
  median: number;
  quoted: number;
  /** 同日**同一批成分**的上涨占比（相对宽度的基准），同口径才可相减 */
  base_up_rate: number;
}

export interface BoardBreadth {
  index_code: string;
  name: string;
  members: number;
  quoted: number;
  /** true = 只拿到前 30 只成分（raw 全表读取失败），广度不可信 */
  truncated: boolean;
  up: number;
  up_rate: number;
  over5: number;
  over5_rate: number;
  deep_loss: number;
  deep_loss_rate: number;
  median: number;
  mean: number;
  amount_yi: number | null;
  best: { name: string; ret: number } | null;
  worst: { name: string; ret: number } | null;
  /** 相对强度 = 本板块中位涨幅 − 全市场样本中位涨幅（pp） */
  rel_median: number;
  state: BreadthState;
  /** 近 N 个交易日的上涨占比（不含今日，按日期升序）；空数组 = 没回溯到 */
  history: BreadthHistoryPoint[];
  /** 上一交易日上涨占比；null = 没回溯到 */
  prev_up_rate: number | null;
  /** 今日上涨占比 − 昨日（pp）：正 = 参与面在扩张 */
  width_delta_pp: number | null;
  /** 相对宽度 = 今日上涨占比 − 同日基准（pp） */
  rel_width_pp: number | null;
  /** 超额宽度变化 = 今日相对宽度 − 昨日相对宽度（pp）。🔴 裸差有 44% 符号是错的，这个才是能横向读的 */
  rel_width_delta_pp: number | null;
  evidence: string[];
}

export interface IndustryFlow {
  name: string;
  change_pct: number | null;
  net_yi: number | null;
  note: string | null;
}

export interface DayOpportunityResult {
  date: string;
  clock: string;
  settled: boolean;
  boards: BoardBreadth[];
  universe: {
    quoted: number;
    median: number;
    up_rate: number;
    over5: number;
    deep_loss: number;
  } | null;
  flows: IndustryFlow[];
  /** 宽度回溯覆盖情况（历史来自通达信盘后包，不是「攒」出来的） */
  breadth_history: {
    days: number;
    from: string | null;
    to: string | null;
    priced: number | null;
    /** 真·全市场（仅 A 股）逐日宽度，只作参考，不参与相对宽度计算 */
    market: { date: string; up_rate: number; median: number; n: number }[];
  };
  gaps: string[];
  notes: string[];
  sources: string[];
}

/**
 * 档位配色。**刻意避开红绿**：红绿在这个页面已经被「涨/跌」占满了，
 * 再用红表示「在动」会和「涨」混淆。这里用蓝（在动）/琥珀（分化）/灰（平淡）/青（走弱）。
 */
export const BREADTH_META: Record<BreadthState, { color: string; bar: string; hint: string }> = {
  "在动": {
    color: "border-primary/40 bg-primary/10 text-primary",
    bar: "bg-primary",
    hint: "上涨 ≥60% 且中位涨幅 >0 —— 广度和价格同向",
  },
  "分化": {
    color: "border-warning/40 bg-warning/10 text-warning",
    bar: "bg-warning",
    hint: "上涨的多，但中位涨幅 ≤0 —— 涨的是微涨、跌的是大票，不算板块在涨",
  },
  "平淡": {
    color: "border-border/60 bg-muted/20 text-muted-foreground",
    bar: "bg-muted-foreground/40",
    hint: "上涨在 30%~60% 之间，没有明显方向",
  },
  "走弱": {
    color: "border-success/40 bg-success/10 text-success",
    bar: "bg-success",
    hint: "上涨 ≤30% —— 整体在跌（绿=跌，A 股习惯）",
  },
  "数据不足": {
    color: "border-border/40 bg-muted/10 text-muted-foreground/70",
    bar: "bg-muted-foreground/20",
    hint: "拿到的行情太少，不判广度",
  },
};

/** 档位排序（与后端一致：在动最前） */
export const BREADTH_ORDER: BreadthState[] = ["在动", "分化", "平淡", "走弱", "数据不足"];

/**
 * 与后端 `WIDTH` 同口径（上涨 ≥60% 在动、≤30% 走弱）。
 * 只用来给「近 N 日宽度」那排小柱子定色，判档位仍然以后端给的 `state` 为准。
 */
export const WIDTH_THRESHOLD = { up_strong: 0.6, up_weak: 0.3 };

/** 单日宽度的柱子色 —— 与 `BREADTH_META[...].bar` 同一套色，别在这里另起一套 */
export function widthTone(up_rate: number): string {
  if (up_rate >= WIDTH_THRESHOLD.up_strong) return BREADTH_META["在动"].bar;
  if (up_rate <= WIDTH_THRESHOLD.up_weak) return BREADTH_META["走弱"].bar;
  return BREADTH_META["平淡"].bar;
}
