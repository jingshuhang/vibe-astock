/**
 * 「交易计划」视图的前端类型(与编排端 `orchestrator/src/finance/plans.ts` 同一份契约)。
 *
 * 这一屏补的是闭环缺的前半球:计划先于成交存在,才能把「止损写了吗 / 仓位超没超」
 * 放到**买入之前**提醒,而不是像交易日志那样亏完才抱怨一句「没写计划止损」。
 */
import type { LedgerRecord } from "./backend";

export const PLAN_KIND = "trade_plan";

/** 记录里的 `status`;`expired` 是按「今天」推导出来的,不入库 */
export const PLAN_STATUSES = ["planned", "executed", "abandoned"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanLifecycle = PlanStatus | "expired";

export const PLAN_LIFECYCLE_META: Record<PlanLifecycle, { label: string; tone: string }> = {
  planned: { label: "待执行", tone: "border-blue-200 bg-blue-50 text-blue-700" },
  expired: { label: "已过期", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  executed: { label: "已成交", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  abandoned: { label: "已放弃", tone: "border-border/60 bg-muted/30 text-muted-foreground" },
};

export interface TradePlan {
  id: string;
  symbol: string;
  name: string;
  playbook: string | null;
  thesis: string;
  planned_entry: number | null;
  planned_stop: number | null;
  planned_target: number | null;
  position_pct: number | null;
  watch: string[];
  next_check: string;
  due: string;
  valid_until: string;
  status: PlanStatus;
  /** 成交的那一轮(交易日志那行的 key);有了它才有事后对照 */
  round_ref: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface PlanGap { key: string; text: string }

/** 关联成交后的实际执行数字(全部来自交易流水,不估不猜) */
export interface PlanExecution {
  round_key: string;
  date: string;
  first_price: number | null;
  avg_cost: number | null;
  closed: boolean;
  realized_pnl_pct: number | null;
  hold_days: number | null;
  entry_gap_pct: number | null;
}

export interface CandidateRound {
  round_key: string;
  symbol: string;
  date: string;
  first_price: number | null;
}

export interface PlanView {
  plan: TradePlan;
  lifecycle: PlanLifecycle;
  due_today: boolean;
  check_arrived: boolean;
  gaps: PlanGap[];
  execution: PlanExecution | null;
  candidates: CandidateRound[];
}

export interface PlansResult {
  available: boolean;
  reason: string;
  day: string;
  hm: string;
  plans: PlanView[];
  open_count: number;
  due_count: number;
  expired_count: number;
  linked_count: number;
  issues: { id: string; symbol: string; why: string }[];
  notes: string[];
  source: string;
}

/** 新建 / 编辑计划时提交的字段;通用台账接口直接吃这一层 */
export type PlanDraft = Partial<Pick<TradePlan,
  "symbol" | "name" | "playbook" | "thesis" | "planned_entry" | "planned_stop" | "planned_target"
  | "position_pct" | "watch" | "next_check" | "due" | "valid_until" | "status" | "note"
>>;

/** 台账写入返回的是「信封 + 字段」的记录(通用接口同一返回) */
export type SavedPlan = LedgerRecord;
