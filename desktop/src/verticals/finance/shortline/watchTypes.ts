/**
 * 盯盘两个分页的数据形状,照后端 orchestrator/src/finance/shortline/watch.ts 与 intraday.ts。
 */
import type { Direction, ReadingKind } from "./viewTypes";
import type { MarketStateResult } from "@/lib/marketState";

export type Phase = "weekend" | "pre_open" | "auction" | "morning" | "lunch" | "afternoon" | "closing_auction" | "closed";
export type AlertKind = "急拉" | "急跌" | "封板" | "开板";
export interface WatchAlert { ts: string; code: string; name: string; kind: AlertKind; change_pct: number | null; price: number | null; pct: number | null; msg: string; sources: string[]; sectors: string[] }
export interface WatchRow { code: string; name: string; price: number | null; pct: number | null; amount_yuan: number | null; quote_time: string | null; today: boolean }
export interface LadderWatchRow extends WatchRow { boards: number; label: string; sector: string; at_limit: boolean | null }
export interface WatchView {
  date: string; clock: string; phase: Phase; phase_label: string;
  trading_day: boolean | null;
  detecting: boolean; poll_ms: number;
  quote_day: string | null;
  holdings: (WatchRow & { pnl_pct: number | null })[];
  watchlist: WatchRow[];
  ladder: { sample_date: string; quote_date: string; highest: number; rows: LadderWatchRow[] } | null;
  turnover: { date: string; rows: (WatchRow & { rank: number })[] } | null;
  bigcap: { total: number; date: string; refreshed_at: string | null; top: WatchRow[]; bottom: WatchRow[] } | null;
  alerts: WatchAlert[];
  notes: string[];
  rules: { surge_pct: number; window_min: number; cooldown_min: number };
  source: string;
}

export type OverviewBlockStatus = "ok" | "partial" | "failed" | "empty";
export interface OverviewBlock<T> { status: OverviewBlockStatus; data: T | null; note?: string }
export interface IndexRow { code: string; name: string; price: number | null; change_pct: number | null }
export interface BreadthSummary {
  scope: string;
  limit_up: number;
  limit_down: number;
  up: number;
  down: number;
  flat: number;
  turnover_yi: number | null;
}
export interface SectorRow { name: string; change_pct: number | null; up_count: number | null; down_count: number | null; rank: number | null }
export interface BoardFlowRow { name: string; net_yi: number | null; change_pct: number | null; leader: string | null; rank: number | null }
/** 板块多股共振信号 */
export interface ResonanceRow {
  name: string;
  change_pct: number | null;
  up_count: number | null;
  down_count: number | null;
  total: number | null;
  resonance_rate: number | null;
  rank: number | null;
  signal: "共振" | "强动" | "一般";
}
export interface EventTrend {
  topics: { keyword: string; count: number | null; trend: string | null }[];
}
export interface OverviewView {
  date: string; clock: string; phase_label: string; poll_ms: number;
  /** 指数实时(腾讯) */
  indices: OverviewBlock<{ rows: IndexRow[]; scope: string }>;
  /** 全市场涨跌分布 + 沪深京家数 / 成交额(东财) */
  breadth: OverviewBlock<BreadthSummary>;
  /** 短线盘中情绪:涨停 / 炸板 / 跌停 / 封板率(东财) */
  shortline: OverviewBlock<Record<string, unknown>>;
  /** 行业板块涨跌排名(东财) */
  sectors: OverviewBlock<{ rows: SectorRow[] }>;
  /** 板块多股共振信号 */
  resonance: OverviewBlock<{ rows: ResonanceRow[]; scope: string }>;
  /** 板块资金流(新浪备源) */
  boardFlow: OverviewBlock<{ rows: BoardFlowRow[] }>;
  /** 市场状态信号(复用 market_state 派生,与「市场状态信号」独立页同一套信号与容错) */
  marketState: OverviewBlock<MarketStateResult>;
  /** 事件热词(本机派生) */
  marketEventTrend: OverviewBlock<EventTrend>;
  notes: string[];
  source: string;
}

export type Slot = "09:25" | "09:35" | "10:00" | "11:30" | "14:00" | "15:00";
export type Basis = "open" | "latest";
export interface TierStat { sample: number; avg: number; median: number; up_rate: number }
export interface TopBoard { code: string; name: string; boards: number; sector: string; pct: number | null; at_limit: boolean | null }
export interface Cohort {
  expected: number; sample: number; coverage_rate: number;
  avg: number; median: number; up_count: number; down_count: number; up_rate: number; deep_loss_5: number;
  by_tier: Record<string, TierStat>;
  top_board_level: number; top_boards: TopBoard[];
}
export interface LiveCounts {
  limit_up: number | null; broken: number | null; limit_down: number | null; highest_board: number | null; consec_count: number | null;
  seal_rate: number | null; broken_rate: number | null; promotion_1to2: number | null; promotion_all: number | null;
}
export interface Snapshot {
  schema: number; date: string; slot: Slot;
  captured_at: string; clock: string; drift_minutes: number;
  basis: Basis; prev_date: string;
  cohort: Cohort;
  live: LiveCounts | null;
  live_reason?: string;
  gaps: string[];
}
export type SlotState = "saved" | "failed" | "skipped" | "missing" | "upcoming";
export interface SlotRow { slot: Slot; window_end: string; state: SlotState; reason: string | null; snapshot: Snapshot | null }
export interface CheckPoint { slot: Slot; value: number | null; actual: Direction | null; actual_label: string | null; verified: boolean | null }
export interface CheckItem {
  id: string; metric: string; label: string; unit: string; kind: ReadingKind; eps: number;
  direction: Direction; direction_label: string; reason: string;
  base_value: number | null; close_only: boolean; points: CheckPoint[];
}
export interface IntradayResult {
  date: string; today: boolean;
  /** 这一天开不开市;null = 没查到 */
  trading_day: boolean | null;
  slots: SlotRow[];
  auction: Snapshot | null;
  auction_reason: string | null;
  checks: { set_date: string | null; items: CheckItem[] };
  warnings: string[];
  gaps: string[];
  basis_labels: Record<Basis, string>;
  source: string;
  generated_at: string;
}
export interface CaptureResult { slot: string; ok: boolean; already: boolean; reason: string | null }
