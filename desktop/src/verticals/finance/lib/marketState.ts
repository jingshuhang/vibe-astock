/**
 * 市场状态信号的界面数据(后端见 orchestrator/src/finance/market_state.ts)。
 *
 * 五维加权健康分:情绪 0.30 / 龙头 0.15 / 抗跌度(原「风险」) 0.15 / 赚钱效应 0.25 / 事件 0.15。
 * 🔴 这五个是**名义**权重。某一维没有数据源时(例如事件面没取到新闻联播)，后端会把它让渡给
 *    其余维度并在 `signal.weights` 里返回**实际**权重 —— 页面上必须显示实际的，
 *    否则用户拿 0.30/0.15/… 自己乘一遍，永远对不上页面上的综合分。
 * 🔴 事件维度另有 **8% 封顶**：它靠宏观词典给"偏向"，可靠度远低于量价读数，
 *    名义 0.15 会让一个文本代理指标拿走综合分 15% —— 所以实际权重最高只有 0.08。
 */
export type RiskLevel = "low" | "medium" | "high" | "extreme";

/** 阶段六档：比原先多一个「退潮期」—— 高位放量下跌 / 跌停成片不是「修复期」 */
export type MarketPhase = "冰点期" | "退潮期" | "修复期" | "主升期" | "高潮期" | "极度高潮期";

/** 实际生效权重（缺项让渡后五项之和 = 1） */
export interface EffectiveWeights {
  emotion: number;
  dragon: number;
  risk: number;
  earning: number;
  event: number;
}

/** 事件面读数（后端口径：央视新闻联播标题 + 宏观词典，见 macro_events.ts） */
export interface MacroEventReading {
  /** 这一期新闻联播的日期；通常是前一晚那期 */
  date: string | null;
  /** 当期条目总数 */
  items: number;
  /** 命中宏观政策主题的条目数 */
  macro_hits: number;
  /** 利多 / 利空词命中数 */
  bullish: number;
  bearish: number;
  /** 命中的标题样本（最多 3 条） */
  samples: string[];
  /** 事件分 35~65（窄幅，防止词典误判把综合分拉走） */
  score: number;
  note: string;
}

export interface MarketSignal {
  composite: number | null;
  phase: MarketPhase | null;
  /** 只看涨停家数得到的阶段；与 phase 不同时说明是闸门把它压下来的 */
  base_phase: MarketPhase | null;
  /** base_phase ≠ phase 时的一句话解释（后端区分「跌停潮」和「闸门压制」）；一致时没有 */
  base_note?: string | null;
  /** 仓位建议上限；🔴 null = 算不出来、不设上限，不是 0（0 是「算出来了、一股别买」） */
  position_cap_pct: number | null;
  /** 赚钱效应缺的腿；空数组 = 数据齐。缺腿时分数中性补位但仓位上限压到 40%（旧快照可能没有这个字段） */
  incomplete_legs?: string[];
  /** null = 算不出来。不能因为取数失败就当成 false 去禁止开新仓 */
  can_open_position: boolean | null;
  risk_level: RiskLevel | null;
  emotion_score: number | null;
  dragon_score: number | null;
  risk_score: number | null;
  earning_score: number | null;
  /** null = 事件面没算出来（权重已让渡），不是中性 50 */
  event_score: number | null;
  /** 事件面的明细（新闻联播条数 / 宏观命中 / 利多利空词 / 样本标题），供人审计分数怎么来的 */
  event_detail?: MacroEventReading | null;
  /** 实际生效权重；全新版本后端才有，旧快照可能没有 */
  weights?: EffectiveWeights | null;
  /** 算不出来的原因；null = 算得出来 */
  unavailable: string | null;
  sources: string[];
  /** 取数降级提示（可选数据缺失等） */
  notes: string[];
  /** 闸门失败原因 */
  gate_blockers?: string[];
  /** 没数据的门（既不算通过也不算失败） */
  gate_unknown?: string[];
  /** 三道门的结构化三态；旧快照没有，前端会退回文案匹配 */
  gate_items?: GateItem[];
  /** 阶段被压下来的原因 */
  phase_reasons?: string[];
  /** 各来源的数据日期（YYYY-MM-DD） */
  data_as_of?: Record<string, string | null>;
  /** 数据不是当日的维度名 */
  stale_dimensions?: string[];
  derived_at: string;
}

export interface Dimension {
  /** null = 这一维算不出来（不是 0 分） */
  score: number | null;
  /** 该维度在综合分里的**实际**权重 */
  weight?: number | null;
  /** 该维度数据是哪一天的 */
  as_of?: string | null;
  /** 数据不是当日 */
  stale?: boolean;
  stage?: string | null;
  has_dragon?: boolean | null;
  ladder_highest?: number | null;
  limit_down?: number | null;
  up_rate?: number | null;
}

/** 一道闸门的三态（后端给 key，前端不靠文案猜） */
export interface GateItem {
  key: "breadth" | "volume" | "ma20";
  label: string;
  state: "pass" | "fail" | "unknown";
  detail: string;
}

export interface Recommendation {
  action: string;
  confidence: number;
  position_range: string;
  reason: string;
}

export interface MarketStateResult {
  date: string;
  clock: string;
  signal: MarketSignal;
  dimensions: {
    emotion: Dimension;
    dragon: Dimension;
    risk: Dimension;
    earning: Dimension;
    event: Dimension;
  };
  recommendation: Recommendation;
  /** 闸门诊断 */
  gate?: { all_pass: boolean; blockers: string[]; unknown: string[]; items?: GateItem[] };
  notes: string[];
}

/**
 * 五维在界面上的**名字与方向**。两个页面（「市场状态」独立页 / 「盯盘」内嵌版）共用这一份。
 *
 * 🔴 五维的分数方向是**一致的**：0–100，分越高越正面。没有反向维。
 *    原来叫「风险」的那一维量的是 `100 − (跌停×2 + 跌家占比×100)`，即**安全度**——
 *    15 分是「极危险」，不是「风险只有 15」。名字与方向拧着，实测有人读反了，
 *    所以改名「抗跌度」，并在每个环下写明高分那一端是什么意思。
 *    **只改叫法与说明，不改字段名 `risk` / `risk_score`、不改分数、不改权重。**
 */
export const DIMENSION_LABELS = {
  emotion: { label: "情绪", hint: "越高越热" },
  dragon: { label: "龙头", hint: "越高越强" },
  risk: { label: "抗跌度", hint: "越高越安全" },
  earning: { label: "赚钱效应", hint: "越高越好赚" },
  event: { label: "事件", hint: "越高越偏多" },
} as const;

/**
 * 🔴 这是**独立的风险等级徽标**,不是五维评分之一,别拿它跟「抗跌度」并着读。
 *    它与 `risk_score` 同源但方向相反:抗跌度分越高越安全 → 徽标越靠近「低风险」;
 *    分越低越危险 → 越靠近「极高风险」。同一屏上「抗跌度 15」旁边写着「极高风险」
 *    是一致的,反倒是「低风险 + 抗跌度低」才该怀疑数据。
 *    最容易读反的是把「低风险」当成「抗跌度低」,所以徽标一律带 title,页面再写一行同源说明。
 *    只补说明,**四档的 label / 配色 / 判定条件一个都不改**。
 */
export const RISK_LEVEL_HINT =
  "风险等级是独立徽标，不是五维评分之一；与「抗跌度」方向相反：抗跌度分越低越危险，这里越靠近「极高风险」。";

export const RISK_LEVEL_META: Record<RiskLevel, { label: string; tone: string }> = {
  low: { label: "低风险", tone: "text-emerald-600 bg-emerald-50 border-emerald-200" },
  medium: { label: "中风险", tone: "text-amber-600 bg-amber-50 border-amber-200" },
  high: { label: "高风险", tone: "text-orange-600 bg-orange-50 border-orange-200" },
  extreme: { label: "极高风险", tone: "text-red-600 bg-red-50 border-red-200" },
};

export const PHASE_COLORS: Record<string, string> = {
  "冰点期": "#6366f1",
  "退潮期": "#64748b",
  "修复期": "#3b82f6",
  "主升期": "#22c55e",
  "高潮期": "#f59e0b",
  "极度高潮期": "#ef4444",
};

/** 把 0..1 的权重显示成整数百分比（四舍五入后总和可能不是 100，所以只在标签上用） */
export function weightPct(w: number | null | undefined): string {
  return w == null ? "—" : `${Math.round(w * 100)}%`;
}

/**
 * 「能不能开新仓」的**三态**文案 —— 界面与给 AI 的上下文共用一份。
 *
 * 🔴 `null` = 算不出来（连仓位上限都不设），**不是**「不可开新仓」。
 *    机会发现页给 AI 的上下文以前写成 `${co ? "可开新仓" : "不可开新仓"}`，
 *    把「不知道」压成一条禁止性结论 —— 模型会把它当成真实的市场判断继续往下推。
 *    独立页 `CompositeBadge` 一直是对的（三态），这里抽出来让两处不再漂移。
 */
export function canOpenLabel(v: boolean | null | undefined): string {
  if (v === true) return "可开新仓";
  if (v === false) return "暂不开新仓";
  return "能不能开新仓：不知道（算不出来）";
}
