/**
 * 机会发现的界面数据（后端见 orchestrator/src/finance/opportunity.ts）。
 *
 * 一条链：**哪些板块在启动 → 板块里谁是龙头 → 明天这只票怎么看**。
 * 和「超短线机会发现」(`shortlineOpportunities`)的分工：
 *   - 那边是个股视角（从涨停池按形态挑票）；
 *   - 这边是板块视角（先判断钱往哪去，再在该方向里排龙头，最后串成条件式规划）。
 *
 * 🔴 三条口径（后端已锁，前端照抄，别在页面上改口径）：
 *   1. 排序只用客观量（今日涨停只数 / 连板高度 / 首封时间），没有加权总分。
 *   2. 独苗不算龙头 —— 板块只有 1~2 只涨停（或全是首板没有高度）时，
 *      那只是「跑得快的票」，不是板块效应。
 *   3. **能不能动手由市场状态决定**：`market.can_open_position` 为 false 时，
 *      这里所有机会的 `allowance` 都只能是「只观察 / 不参与」。
 */

/** 板块启动状态。词是盘口黑话，判据在后端 `ignitionOf`，页面上要能点开看到 */
export type IgnitionState = "新启动" | "加速" | "高位拥挤" | "退潮" | "延续" | "观察";

export interface QuoteLite {
  price: number | null;
  change_pct: number | null;
  turnover_rate: number | null;
  /** 已折算成亿元 */
  turnover_amount_yi: number | null;
  float_cap_yi: number | null;
  volume_ratio: number | null;
  limit_up_price: number | null;
  last_close: number | null;
  /** 距涨停价还差几个点（已封板 = 0） */
  to_limit_pct: number | null;
}

export type LeaderRole = "龙头" | "跟风" | "补涨" | "独苗";

/**
 * 封单厚度分档。阈值与后端 `SEAL_GRADE_CUT` 一致（1.5% / 3%），
 * 依据是 14 个交易日回溯：>1.5% 次日再涨停 42%、≤1.5% 只有 15%，按日配对 14/14 天方向一致。
 */
export type SealGrade = "硬" | "中" | "软";

export interface LeaderPick {
  code: string;
  name: string;
  boards: number;
  first_seal: string | null;
  broken_times: number | null;
  zt_stat: string | null;
  role: LeaderRole;
  /** 凭什么排在这 —— 全是客观字段 */
  why: string[];
  quote: QuoteLite | null;
  /** 封单额（亿元） */
  seal_fund_yi: number | null;
  /** 封单 ÷ 流通市值（%）：同一板块两只都封板时，这个数才是「哪只更硬」的答案 */
  seal_ratio: number | null;
  /** 封单厚度分档（硬 ≥3% / 中 ≥1.5% / 软 <1.5%）；null = 没拿到封单数据，不是「软」 */
  seal_grade: SealGrade | null;
  /** 末封时间（回封到最后一次） */
  last_seal: string | null;
  /** 涨停原因标签（上游编辑归因，非公司确认） */
  reason_tags: string[];
}

/**
 * 连板天梯里「某一档」的晋级情况。
 * 🔴 分母是「昨日处在 ${boards-1} 板的只数」，分子是其中今天上到 ${boards} 板的只数 ——
 *    统计的是 `${boards-1} → ${boards}` 这一跳，**不是** `${boards} → ${boards+1}`。
 *    所以它不能当龙头明天的晋级概率看，只是「到达当前高度有多难」的背景。
 */
export interface PromotionStep {
  boards: number;
  base: number;
  promoted: number;
  rate: number | null;
  fell: { code: string; name: string; prev_label: string | null; outcome: string; ret: number | null }[];
}

/**
 * 昨日各档涨停股今天的去向（`cn_shortline_facts` 的 feedback.matrix）。
 *
 * 🔴 这是全套里**唯一与龙头档位正对应**的证据：`tier = "3板"` 说的是
 *    「昨日 3 板的票今天表现如何」，所以我今天 3 板的龙头明天走的就是这个分布。
 *    （连板天梯的 `boards=3` 说的是「昨日 2 板→今日 3 板」，那是上一个档位，不能直接套。）
 */
export interface TierOutcome {
  tier: string;
  total: number;
  buckets: { label: string; count: number }[];
  promoted: number;
  promotion_rate: number | null;
  /** 其中跌停只数：这一档「打错了」的代价 */
  limit_down: number;
}

/** 盘面事实：封板质量 + 亏钱效应 + 分档反馈 + 分涨跌幅制度 */
export interface MarketFacts {
  prev_date: string | null;
  sample: number | null;
  seal_quality: {
    total: number | null;
    never_broken: number | null;
    never_broken_rate: number | null;
    avg_broken_times: number | null;
    late_seal: number | null;
    reopened: number | null;
    ever_opened_rate: number | null;
  } | null;
  loss_effect: {
    deep_loss_5_count: number | null;
    deep_loss_5_rate: number | null;
    deep_loss_7_count: number | null;
    limit_down_count: number | null;
    worst: number | null;
  } | null;
  tiers: TierOutcome[];
  by_board: { board: string; limit_up: number | null; highest: number | null; prev_base: number | null; promoted: number | null; broken: number | null; promotion_rate: number | null }[];
}

/**
 * 封板时间分档（`cn_shortline_settled` 的 `seal_time` 一维）。
 *
 * ⚠️ `seal_time` 是**最后封板时间**，不是首封。
 * ⚠️ 单日的 n 只有三四十，一档十几只 —— 所以页面上优先看 `trend`（多日累计），
 *    单日那组只在 `trend` 为 null 时才当主角。
 */
export interface SealBucket {
  label: string;
  n: number;
  still_up: number;
  still_up_rate: number;
  avg_ret: number;
  win_rate: number;
  deep_loss: number;
  deep_loss_rate: number;
}

/**
 * 多日累计的封板时点表现。
 *
 * 🔴 它是同一批数据**按日期扇出回溯**出来的，不是「一天天攒」——
 *    `cn_shortline_settled` 带 `date` 参数，东财保留约一个月，第一天就能算 20 天。
 *    每档累计到几百只，才能说「早封的次日再涨停率是晚封的两倍多」。
 */
export interface SealTrend {
  days: number;
  tried: number;
  from_date: string | null;
  to_date: string | null;
  sample: number;
  buckets: SealBucket[];
}

export interface SealTiming {
  date: string | null;
  prev_date: string | null;
  sample: number;
  coverage_rate: number | null;
  partial: boolean;
  buckets: SealBucket[];
  /** 多日累计；null = 一天都没回溯成功，此时只能看单日 */
  trend: SealTrend | null;
}

/**
 * 情绪周期位置（`cn_shortline_cycle`，回看 10 个交易日）。
 * 用途只有一个：给「新启动」加时间背景 —— 同样是新启动，
 * 「低点后第 2 天、分位 21%」和「第 8 天、分位 90%」是两回事。不参与任何档位计算。
 */
export interface CyclePosition {
  window: number;
  trough_date: string | null;
  trough_score: number | null;
  current_score: number | null;
  current_date: string | null;
  /** 距低点第几个交易日 */
  day_n: number | null;
  rising: boolean | null;
  trend: string | null;
  /** 当前分在窗口内的分位（0~1），越低说明还在低位 */
  pctile: number | null;
  series: { date: string; score: number | null; limit_up: number | null; highest_consec: number | null; broken_rate: number | null }[];
}

/** 盘中「此刻」读数（收盘后 phase = 「已收盘」，值是当时的定格） */
export interface LiveEmotion {
  phase: string | null;
  settled: boolean;
  limit_up: number | null;
  broken: number | null;
  limit_down: number | null;
  highest_board: number | null;
  consec_count: number | null;
  seal_rate: number | null;
  broken_rate: number | null;
  promotion_all: number | null;
  promotion_1to2: number | null;
  /** 昨日涨停股今日中位涨幅（%）：负数就是打板在亏钱 */
  money_effect: number | null;
  deep_loss: number | null;
  sample: number | null;
  as_of: string | null;
}

export interface SectorIgnition {
  tag: string;
  state: IgnitionState;
  today: number;
  /** 近 N 日涨停只数序列（缺数为 null，**不是 0**） */
  series: (number | null)[];
  ranks: (number | null)[];
  first_boards: number;
  consec_boards: number;
  highest: number;
  /** 题材内涨停股中**开板过**的只数 —— 不是全市场炸板数（那个在 live.broken） */
  broken: number;
  /** 该题材内跌停只数：与涨停股并存说明内部已在分化 */
  limit_down: number;
  /**
   * 昨日涨停股今天的延续情况。
   * 🔴 `rate === null` = 昨日这个题材一只涨停都没有（真·新出现），
   *    和「昨日 11 只只剩 3 只」（rate 0.273）是完全相反的两件事。
   */
  continuation: {
    prev_limit_up: number;
    still_up: number;
    broken_or_down: number;
    rate: number | null;
  };
  /** 上游状态词（扩散中 / 今日新出现 / 分歧加大 / 接力断档），与本页 state 是两套口径 */
  upstream_state: string | null;
  /** 成员明细给了几只（上游截断到 8 只，但按板数降序，龙头一定在） */
  members_shown: number;
  /** 首板 ÷ 涨停：越高说明是新资金扩散，不是老龙头独扛 */
  diffusion: number | null;
  active_days: number;
  top3_days: number;
  evidence: string[];
  leaders: LeaderPick[];
  /** 有没有资格谈「龙头」（≥3 只涨停且高度 ≥2） */
  has_sector_effect: boolean;
  /** 该板块最高板这一档的晋级情况；null = 天梯没取到 */
  promotion: PromotionStep | null;
}

export type PlanAllowance = "可参与" | "只观察" | "不参与";

/** 条件式规划：只有「看什么 / 什么算触发 / 什么算失效」，没有买卖动作 */
export interface PlanDraft {
  sector: string;
  symbol: string;
  name: string;
  role: LeaderRole;
  allowance: PlanAllowance;
  allowance_note: string;
  watch: string[];
  trigger: string[];
  invalidate: string[];
  sizing: string;
}

export interface OpportunityMarketBrief {
  phase: string | null;
  composite: number | null;
  position_cap_pct: number | null;
  risk_level: string | null;
  can_open_position: boolean | null;
  gate_blockers: string[];
}

export interface OpportunityResult {
  date: string;
  clock: string;
  settled: boolean;
  /** 市场状态（联动闸门）：null = 没算出来，此时所有机会一律降为只观察 */
  market: OpportunityMarketBrief | null;
  sectors: SectorIgnition[];
  /** 盘中「此刻」读数；null = 没取到 */
  live: LiveEmotion | null;
  /** 情绪周期位置；null = 没取到（要回看 10 天，是全套最慢的一个） */
  cycle: CyclePosition | null;
  /** 打板反馈：封板质量 / 亏钱效应 / 各档昨日涨停股今天去向 */
  facts: MarketFacts | null;
  /** 封板时点 → 次日表现；与 facts 同源，增量只有「最后封板时间」这一维 */
  seal_timing: SealTiming | null;
  /** 行业资金流只做旁证（题材名与行业名不是一套命名，无法 join） */
  board_flow: {
    available: boolean;
    top: { name: string; net_yi: number | null; change_pct: number | null; note: string | null }[];
    note: string;
  };
  plans: PlanDraft[];
  gaps: string[];
  notes: string[];
  sources: string[];
}

// ─── 展示用口径 ─────────────────────────────────────────────────────────────────

export const IGNITION_META: Record<IgnitionState, { color: string; desc: string }> = {
  新启动: { color: "text-danger border-danger/40 bg-danger/10", desc: "从榜外 / 低位突然放量，且当天挤进前三" },
  加速: { color: "text-danger border-danger/40 bg-danger/10", desc: "本来就在榜，今天涨停更多且仍在前三" },
  高位拥挤: { color: "text-warning border-warning/40 bg-warning/10", desc: "连续多日在榜，但今天不再放大" },
  退潮: { color: "text-muted-foreground border-border/60 bg-muted/20", desc: "昨天还有涨停，今天归零" },
  延续: { color: "text-muted-foreground border-border/60 bg-muted/20", desc: "有涨停但没满足前面几条的强度" },
  观察: { color: "text-muted-foreground border-dashed border-border/60", desc: "数据不足或今日无涨停，判断不了" },
};

/**
 * 仓位档位不用红绿 —— 红绿在这套界面里已经被「涨 / 跌」占住了，
 * 再拿它们表示「能不能买」会读成「这只票在涨」。用蓝 / 琥珀 / 灰。
 */
export const ALLOWANCE_META: Record<PlanAllowance, { color: string; icon: "check" | "eye" | "ban" }> = {
  可参与: { color: "text-info border-info/40 bg-info/10", icon: "check" },
  只观察: { color: "text-warning border-warning/40 bg-warning/10", icon: "eye" },
  不参与: { color: "text-muted-foreground border-border/60 bg-muted/20", icon: "ban" },
};

export const ROLE_META: Record<LeaderRole, { color: string; hint: string }> = {
  龙头: { color: "text-danger border-danger/40 bg-danger/10", hint: "板块内高度最高（同高度比开板次数、首封时间）" },
  跟风: { color: "text-foreground/70 border-border/60 bg-muted/20", hint: "同方向但没走到最前" },
  补涨: { color: "text-muted-foreground border-border/60 bg-muted/10", hint: "1 板，跟着板块动" },
  独苗: { color: "text-muted-foreground border-dashed border-border/60", hint: "板块没有效应，这只是个股行为，不算龙头" },
};

/** 序列里 null 与 0 在图上必须长得不一样：null 是「没取到」，0 是「真的没有涨停」 */
export function seriesMax(series: (number | null)[]): number {
  return Math.max(1, ...series.map((v) => v ?? 0));
}
