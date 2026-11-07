/**
 * 大盘判断台账(后端 orchestrator/src/finance/market_call.ts 的视图输出)。
 * WorkBuddy 大盘全景收盘档的「交易倾向四档」快照 + 次日触发条件对账 ——
 * 🔴 本台账**只存档与对账**:档位与触发条件由全景侧产出,这里不生成任何大盘建议。
 */

export type CallTier = "加仓" | "持有" | "减仓" | "观望";
/** 五档：全景档会写「中性偏多 / 中性偏空」，不是只有偏多/中性/偏空三个值 */
export type CallDirection = "偏多" | "中性偏多" | "中性" | "中性偏空" | "偏空";
/** 结构化触发条件的读数;trigger_op: above=≥ / below=≤ */
export type TriggerMetric = "breadth_pct" | "limit_up" | "limit_down" | "amount_yi";

export interface MarketCallRow {
  date: string;
  call: CallTier;
  direction: CallDirection;
  basis: string | null;
  /** 触发条件原文(一直留档供人工复核) */
  trigger: string | null;
  trigger_metric: TriggerMetric | null;
  trigger_op: "above" | "below" | null;
  trigger_value: number | null;
  /** 写下判断那天的读数快照 */
  breadth_pct: number | null;
  amount_yi: number | null;
  limit_up: number | null;
  limit_down: number | null;
  settled: boolean;
  settled_date: string | null;
  next_breadth_pct: number | null;
  next_amount_yi: number | null;
  /** 次日涨停/跌停家数(_count 后缀避开机会清单台账的「次日再板」) */
  next_limit_up_count: number | null;
  next_limit_down_count: number | null;
  /** null = 判不了(没给结构化条件 / 读数缺) —— 不进战绩分母 */
  trigger_hit: boolean | null;
  html_path: string | null;
  /**
   * 行来源:ledger=已落账台账;inbox=交接件还在 inbox 没落账(16:05 扫描后转 ledger)。
   * inbox 行必然 settled=false、trigger_hit=null —— 还没进对账流程。
   */
  source: "ledger" | "inbox";
}

export interface MarketCallView {
  /** 台账里还没有任何判断(全景侧还没落过件,不是故障) */
  available: boolean;
  date: string | null;
  total: number;
  settled_count: number;
  pending_count: number;
  /** 触发条件命中战绩:只统计判得了的 */
  judged: number;
  hit: number;
  rows: MarketCallRow[];
  caveat: string;
  generated_at: string;
}

// ─── 展示辅助件(市场状态页与每日复盘页共用,别在两处各写一份) ──────────────────

/** 四档徽标配色:加仓红涨、减仓绿跌、持有蓝、观望灰(中国市场习惯) */
export const CALL_COLORS: Record<string, string> = {
  加仓: "border-red-200 bg-red-50 text-red-700",
  持有: "border-blue-200 bg-blue-50 text-blue-700",
  减仓: "border-emerald-200 bg-emerald-50 text-emerald-700",
  观望: "border-border/60 bg-muted/40 text-muted-foreground",
};
export const OP_LABEL: Record<string, string> = { above: "≥", below: "≤" };
export const METRIC_LABEL: Record<string, string> = { breadth_pct: "广度", limit_up: "涨停家数", limit_down: "跌停家数", amount_yi: "成交额(亿)" };

/** 一行读数:「广度 48.6% · 额 16200 亿 · 涨停 58 / 跌 21」;全缺给「—」不伪装 0 */
export function readingsText(r: MarketCallRow, pre: "next_" | ""): string {
  const b = pre ? r.next_breadth_pct : r.breadth_pct;
  const a = pre ? r.next_amount_yi : r.amount_yi;
  const u = pre ? r.next_limit_up_count : r.limit_up;
  const d = pre ? r.next_limit_down_count : r.limit_down;
  if (b == null && a == null && u == null && d == null) return "—";
  const parts: string[] = [];
  if (b != null) parts.push(`广度 ${b}%`);
  if (a != null) parts.push(`额 ${a} 亿`);
  if (u != null || d != null) parts.push(`涨停 ${u ?? "—"} / 跌 ${d ?? "—"}`);
  return parts.join(" · ");
}
