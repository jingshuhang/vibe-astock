/**
 * 机会清单台账(后端 orchestrator/src/finance/shortline/opportunity_track.ts 的视图输出)。
 * 收盘快照的机会清单 + 次日对账结果,按『类别 × 环境』汇总的**本页实测**战绩 ——
 * 页面把它和 patternPrior 的先验表并排;先验数值只在前端,这里只有实测。
 */
import type { PatternCategory, Regime } from "../shortline/patternPrior";

/** 与后端 samples.ts 的 Stats 同形状(胜率平盘不算赢;再板率判不了不进分母;无样本 null 不伪装 0) */
export interface TrackStats {
  sample: number;
  win_rate: number | null;
  avg: number | null;
  median: number | null;
  best: number | null;
  worst: number | null;
  limit_up_rate: number | null;
}

export interface TrackCell extends TrackStats {
  category: PatternCategory;
  regime: Regime;
}

export interface TrackPendingRow {
  date: string;
  code: string;
  name: string;
  category: PatternCategory;
  regime: Regime;
}

export interface OpportunityTrackResult {
  /** 台账里还没有任何快照(还没跑过第一次收盘快照,不是故障) */
  available: boolean;
  date: string | null;
  snapshot_days: number;
  total: number;
  settled_count: number;
  pending_count: number;
  /** 12 个格子(3 类别 × 4 环境),与 PRIOR 一一对齐 */
  cells: TrackCell[];
  pending_rows: TrackPendingRow[];
  sample_caveat: string;
  generated_at: string;
}
