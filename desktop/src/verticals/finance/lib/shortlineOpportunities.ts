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

export interface ShortlineOpportunityResult {
  date: string;
  clock: string;
  phase: string;
  limit_up_count: number;
  broken_rate: number | null;
  seal_rate: number | null;
  opportunities: StockOpportunity[];
  by_sector: Record<string, StockOpportunity[]>;
  /** 当日涨停家数最多的两个行业(全部涨停股聚类;行业≠题材) —— 板块共振判定用。后端老版本可能没有该字段 */
  main_sectors?: string[];
  notes: string[];
  source: string;
}
