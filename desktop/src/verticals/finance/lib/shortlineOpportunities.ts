/**
 * 超短线机会发现的界面数据(后端见 orchestrator/src/finance/shortline/opportunities.ts)。
 * 从涨停股中按模式识别候选机会，给出触发清单。
 */
export interface OpportunityPattern {
  type: "首板爆发" | "弱转强" | "分歧转一致" | "N字反包" | "龙头接力";
  confidence: number;
  trigger: string;
  risk: "低" | "中" | "高";
}

export interface StockOpportunity {
  code: string;
  name: string;
  sector: string;
  boards: number;
  seal_time: string | null;
  tags: string[];
  pattern: OpportunityPattern | null;
  limit_price: number | null;
  change_pct: number | null;
  float_cap_yi: number | null;
  turnover_yi: number | null;
  seal_amount_yi: number | null;
  open_count: number;
  note: string;
}

export type OpportunityStatus = "ok" | "partial" | "failed";

export interface ShortlineOpportunityResult {
  date: string;
  clock: string;
  /** 本轮清单的数据状态。failed = opportunities 为空只是「没取到」，不是「今天没有机会」。老后端可能没有该字段 */
  status?: OpportunityStatus;
  phase: string;
  limit_up_count: number;
  broken_rate: number | null;
  seal_rate: number | null;
  opportunities: StockOpportunity[];
  by_sector: Record<string, StockOpportunity[]>;
  /** 当日涨停家数最多的两个行业(全部涨停股聚类;行业≠题材) —— 板块共振判定用。后端老版本可能没有该字段 */
  main_sectors?: string[];
  /** 本轮缺口（与 notes 同源）。老后端可能没有该字段 */
  gaps?: string[];
  notes: string[];
  source: string;
}

/**
 * 空清单时给什么话。**取数失败不许伪装成「今天没有机会」** ——
 * 2026-11-10 之前这一页的取数链全断，页面却一直显示「今天没有匹配到模式的机会」且不报任何错。
 * 老后端没有 status 时用 notes 兜底（有降级提示就按 partial 读）。
 */
export function emptyOpportunityHint(d: Pick<ShortlineOpportunityResult, "status" | "gaps" | "notes">): string {
  const status: OpportunityStatus = d.status ?? ((d.notes?.length ?? 0) > 0 ? "partial" : "ok");
  if (status === "failed") return "这一轮涨停池没取到，清单是空的 ≠ 今天没有机会。请看下方缺口说明，或稍后点「重新取数」。";
  if (status === "partial") return "今天没有匹配到模式的机会（本轮有数据缺口，见下方降级提示）。";
  return "今天没有匹配到模式的机会。";
}
