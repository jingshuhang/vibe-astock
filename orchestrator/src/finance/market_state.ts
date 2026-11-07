/**
 * 市场状态判断 —— 独立信号层（上游工具）
 *
 * 这是 Vibe-AStock 的「决策链最上游」：
 *   - 其他工具（超短线机会发现 / 交易计划）都要读它来决定仓位上限
 *   - 数据全部来自 registry 现有端点，不新接源
 *   - 纯规则派生，不调 LLM，无 mock 隐患
 *
 * 输出两类产品：
 *   1. MarketSignal —— 结构化信号（供其他工具消费）
 *   2. MarketStateView —— 展示给盯盘页的完整视图（供人阅读）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 2026-10-30 第二轮修复（对照两张实测截图）：
 *
 *  A. **闸门在生产路径上从来没生效过。** `extractGateData` 读的是 `block.envelope`，
 *     而 `extractRaw` 把信封放在 `block.data` 里 —— 于是量能门 / 均线门永远是「没数据」，
 *     只有广度门在跑；`market_state.ts` 自己那两个端点更是压根不取 trend / ladder。
 *     现在闸门数据由 `gateDataFrom` 统一解析（全仓唯一一份），两个入口都取。
 *
 *  B. **本文件解析信封时把 FetchResult 当成了 envelope。** `extractBreadth(env)` 传进来的是
 *     `{envelope, exit_code, ...}`，而 `breadthFrom` 要的是 `{evidence:[...]}` ——
 *     于是独立页永远是「算不出来」。现在统一传 `env.envelope`。
 *
 *  C. **状态标签与仓位建议各自映射。** 原先 `action` 由 composite 分档、`reason` 里塞
 *     `市场${phase}，不宜开新仓`，于是出现「修复期 + 仓位 0%」这种自相矛盾。
 *     现在 action 只由**仓位上限**派生（0 就对「空仓等待」），reason 只陈述数据和闸门，
 *     phase 只说明情绪周期 —— 三者各说各的，不再互相冒充。
 *
 *  D. **分项没有时间戳。** 赚钱效应连续两天 49 分没人发现，是因为没人知道那是哪天的数据。
 *     现在每个分项带 `as_of`，非当日数据进 `stale_dimensions`，前端标灰。
 * ────────────────────────────────────────────────────────────────────────────
 */

import { fetchEndpoint, type FetchResult, type ServiceContext } from "../service.ts";
import { clockOf } from "./shortline/intraday.ts";
import { consistencyFor, wantsFresh } from "./snapshot_ttl.ts";
import { breadthFrom } from "./shortline/overview.ts";
import {
  scoreMarket,
  positionCapOf,
  INCOMPLETE_DATA_CAP_PCT,
  riskLevelOf,
  type EffectiveWeights,
  type GateItem,
  type MarketGateInput,
  type MarketPhase,
  type RiskLevel,
} from "./market_score.ts";
import { readMacroEvents, type MacroEventReading } from "./macro_events.ts";
// 评分输入的解析全仓只有这一份（共振率 / 板块资金流）。两个入口共用，避免同一收盘算出两个分。
import { boardFlowNetRows, num, parseResonance } from "./scoring_inputs.ts";

// ─── 类型定义 ───────────────────────────────────────────────────────────────────

/** 闸门输入（主升期判定用）。名字沿用旧称，避免 overview 等调用方改动。 */
export type MarketGateData = MarketGateInput;

/** 各来源的取数时间（ISO 或日期），用于给分项打时间戳、识别陈旧数据 */
export interface MarketProvenance {
  breadth?: string | null;
  resonance?: string | null;
  board_flow?: string | null;
  trend?: string | null;
  ladder?: string | null;
  /** 新闻联播文字稿（事件面唯一来源）的取数时间 */
  event?: string | null;
}

/** 市场状态信号（上游工具消费的紧凑格式） */
export interface MarketSignal {
  /** 综合健康分 0-100，**恒等于五维加权**（权重见 weights）；null = 算不出来 */
  composite: number | null;
  /** 市场阶段（门槛制，见 market_score.resolvePhase）；null = 算不出来 */
  phase: MarketPhase | null;
  /** 诊断用：只看涨停家数会得到什么阶段。与 phase 不同时说明是闸门把它压下来的 */
  base_phase: MarketPhase | null;
  /** base_phase ≠ phase 时的一句话解释（区分「跌停潮」与「闸门压制」）；一致时为 null */
  base_note: string | null;
  /**
   * 仓位建议上限（基于当前市场状态）。
   * 🔴 **null = 算不出来，不设上限 —— 不是 0。** 两者天差地别：
   * 0 是「算出来了，一股别买」，null 是「不知道」。把 null 当 0 用，一次取数失败就会全面禁止开仓。
   */
  position_cap_pct: number | null;
  /**
   * 赚钱效应缺的腿（「板块共振」/「板块资金流」）；空数组 = 数据齐。
   * 🔴 它与仓位上限是因果关系：缺腿时分数按中性补位、看着正常，但上限只能到「轻仓试探」。
   *    用结构化字段而不是让调用方去 notes 里搜文案 —— 措辞一改就静默失效的教训见 evaluateMarketGate。
   */
  incomplete_legs?: string[];
  /** 是否适合开新仓（仓位上限 ≥ 40% 且不是极高风险）；null = 算不出来 */
  can_open_position: boolean | null;
  /** 风险等级：由**风险分**决定（不是由 composite 反推）；null = 算不出来 */
  risk_level: RiskLevel | null;
  /** 情绪分数（0-100） */
  emotion_score: number | null;
  /** 龙头分数（0-100） */
  dragon_score: number | null;
  /** 风险分数（0-100，越高越安全） */
  risk_score: number | null;
  /** 赚钱效应分数（0-100） */
  earning_score: number | null;
  /** 事件分数（35-65）；**null = 事件面算不出来（没用中性 50 兜）** */
  event_score: number | null;
  /** 事件面读数（新闻联播 + 宏观词典）；null = 没取到。用来审计「这个分怎么来的」 */
  event_detail: MacroEventReading | null;
  /** 实际生效权重（缺项让渡后五项之和 = 1）。前端据此显示真实公式 */
  weights: EffectiveWeights | null;
  /** 算不出来时的原因；null = 算得出来 */
  unavailable: string | null;
  /** 数据来源说明（只放来源，不放降级提示 —— 提示走 notes） */
  sources: string[];
  /** 取数降级提示（可选数据缺失等）；算得出来时也可能非空 */
  notes: string[];
  /** 闸门失败原因（供前端展示诊断信息） */
  gate_blockers: string[];
  /** 没有数据、因此既不算通过也不算失败的门 */
  gate_unknown: string[];
  /** 三道门的结构化三态（广度 / 量能 / MA20），前端按 key 渲染，不靠文案猜 */
  gate_items: GateItem[];
  /** 阶段被压下来的原因（空 = 没被压） */
  phase_reasons: string[];
  /** 各来源的数据日期（YYYY-MM-DD）；缺数据的为 null */
  data_as_of: Record<string, string | null>;
  /** 数据不是当日的维度名（emotion / dragon / risk / earning / event） */
  stale_dimensions: string[];
  /** 派生时间 */
  derived_at: string;
}

/** 单维明细（前端展示用） */
export interface DimensionView {
  /** null = 这一维算不出来（不是 0 分） */
  score: number | null;
  /** 该维度在综合分里的**实际**权重（缺项让渡后） */
  weight: number | null;
  /** 该维度数据是哪一天的（YYYY-MM-DD）；null = 不知道 / 无数据源 */
  as_of: string | null;
  /** 数据不是当日 */
  stale: boolean;
}

/** 市场状态完整视图（供前端展示） */
export interface MarketStateView {
  date: string;
  clock: string;
  signal: MarketSignal;
  /** 五维明细；算不出来时各项为 null（不是 0） */
  dimensions: {
    emotion: DimensionView & { stage: string | null };
    dragon: DimensionView & { has_dragon: boolean | null; ladder_highest: number | null };
    risk: DimensionView & { limit_down: number | null };
    earning: DimensionView & { up_rate: number | null };
    event: DimensionView;
  };
  /** 操作建议 —— action / position_range 只由仓位上限派生，与 phase 解耦 */
  recommendation: {
    action: string;
    confidence: number;
    position_range: string;
    reason: string;
  };
  /** 闸门诊断 */
  gate: { all_pass: boolean; blockers: string[]; unknown: string[]; items: GateItem[] };
  /** 降级提示 */
  notes: string[];
}

/** 原始涨跌分布数据 */
interface BreadthData {
  limit_up?: number | null;
  limit_down?: number | null;
  up?: number | null;
  down?: number | null;
  flat?: number | null;
}

// ─── 常量 ───────────────────────────────────────────────────────────────────────

const SOURCES = [
  "东财涨跌分布(em_market_breadth)",
  "东财板块共振(em_industry_comparison)",
  "新浪板块资金流(sina_board_flow)",
  "东财指数趋势与两市成交额(em_market_trend)",
  "东财连板天梯(cn_shortline_board_ladder)",
  "央视新闻联播文字稿(cctv_news)",
] as const;

/** 维度 → 驱动它的来源（用于判定「这一维的数据是哪天的」） */
const DIM_SOURCES: Record<string, (keyof MarketProvenance)[]> = {
  emotion: ["breadth"],
  dragon: ["ladder", "breadth"],
  risk: ["breadth"],
  earning: ["breadth", "resonance", "board_flow"],
  event: ["event"],
};

// ─── 辅助函数 ───────────────────────────────────────────────────────────────────

/** 信封里的证据数组。传进来的是 FetchResult 还是 envelope 都能兜住 —— 少一次踩同样的坑。 */
function evidenceOf(env: unknown): Record<string, unknown>[] {
  if (!env || typeof env !== "object") return [];
  const direct = (env as { evidence?: unknown }).evidence;
  if (Array.isArray(direct)) return direct as Record<string, unknown>[];
  const inner = (env as { envelope?: unknown }).envelope;
  if (inner && typeof inner === "object") {
    const ev = (inner as { evidence?: unknown }).evidence;
    if (Array.isArray(ev)) return ev as Record<string, unknown>[];
  }
  return [];
}

/** 取数时间 → 日期（YYYY-MM-DD）；解析不了返回 null */
function dateOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * 从端点响应中提取涨跌分布数据。
 *
 * 🔴 端点返回的是按 note 分档的长表，没有 `limit_up` / `up_count` 这些字段名。
 * 统一用 overview.ts 的 `breadthFrom`（全仓唯一一份解析）。
 * 🔴 传 `FetchResult` 外壳或 `envelope` 都能吃 —— 早先直接把外壳递给 `breadthFrom`，
 *    外壳上没有 `evidence`，于是家数永远为空、独立页永远「算不出来」。
 */
export function extractBreadth(env: unknown): BreadthData {
  const c = breadthFrom({ evidence: evidenceOf(env) });
  if (!c) return {};
  return { limit_up: c.limit_up, limit_down: c.limit_down, up: c.up, down: c.down, flat: c.flat };
}

/**
 * 板块共振 / 板块资金流的评分输入 —— **全仓唯一一份**，见 `scoring_inputs.ts`。
 *
 * 🔴 早先这两个函数各写一份，把 evidence 的 `value` 直接当成共振率（那是板块涨跌幅），
 *    于是独立页的共振腿永远是 0；概况页那边又是另一套（用展示 Top12 算资金流占比 → 恒等于 1）。
 *    同一个收盘能给出 37 分和 39 分。现在两边都走 `parseResonance` / `boardFlowNetRows`。
 */

/**
 * 闸门数据解析 —— **全仓唯一一份**。overview.ts 与 market_state.ts 两个入口共用。
 *
 * 从 `em_market_trend` 取：上证收盘 / 上证 MA20 / 两市成交额（最新一天）/ 20 日均额。
 * 从 `cn_shortline_board_ladder` 取：最高连板高度 / 最高一档的晋级率。
 *
 * @param trendEnvelope em_market_trend 的信封本体（不是 FetchResult）
 * @param ladderEnvelope cn_shortline_board_ladder 的信封本体
 */
export function gateDataFrom(
  trendEnvelope: unknown,
  ladderEnvelope: unknown,
): { gate: MarketGateData | null; notes: string[] } {
  const trendEv = evidenceOf(trendEnvelope);
  const ladderEv = evidenceOf(ladderEnvelope);
  const notes: string[] = [];

  let indexShClose: number | null = null;
  let indexShMa20: number | null = null;
  let amountTotalYi: number | null = null;
  let amountMa20Yi: number | null = null;
  let amountMa20PriorYi: number | null = null;
  let amountDate = "";
  for (const e of trendEv) {
    const v = num(e.value);
    if (v === null) continue;
    if (e.record_key === "index|000001") {
      if (e.field === "index_close") indexShClose = v;
      else if (e.field === "index_ma20") indexShMa20 = v;
    }
    if (e.field === "market_amount_ma20") amountMa20Yi = v / 1e8;
    if (e.field === "market_amount_ma20_prior") amountMa20PriorYi = v / 1e8;
    if (e.field === "market_amount_total") {
      // 取日期最新的一条（证据顺序不保证）
      const d = String(e.period ?? "");
      if (d >= amountDate) { amountDate = d; amountTotalYi = v / 1e8; }
    }
  }
  // 盘中「今天这根还没收完」时，源端另给一组不含今天的均值 —— 拿半天的量跟整天均值比会误导
  if (amountMa20PriorYi !== null) amountMa20Yi = amountMa20PriorYi;

  let ladderHighest: number | null = null;
  let promotionRate: number | null = null;
  const tierRates: { tier: number; rate: number }[] = [];
  for (const e of ladderEv) {
    const v = num(e.value);
    if (v === null) continue;
    if (e.field === "ladder_highest") ladderHighest = v;
    if (e.field === "ladder_tier_promotion_rate") {
      const m = /^(\d+)板$/.exec(String(e.record_key ?? ""));
      tierRates.push({ tier: m ? Number(m[1]) : 0, rate: v });
    }
  }
  // 取**最高一档**的晋级率：它衡量最高标的的接力，才对应「龙头强度」
  if (tierRates.length) {
    tierRates.sort((a, b) => b.tier - a.tier);
    promotionRate = tierRates[0]!.rate;
  }

  if (indexShClose === null && amountTotalYi === null && ladderHighest === null) {
    return { gate: null, notes: ["闸门数据一项都没取到（指数趋势 / 连板天梯），只保留广度门"] };
  }

  if (indexShClose === null || indexShMa20 === null) notes.push("上证收盘或 MA20 缺失，跳过「指数>MA20」门");
  if (amountTotalYi === null || amountMa20Yi === null) notes.push("两市成交额或 20 日均额缺失，跳过量能门");
  if (ladderHighest === null) notes.push("连板天梯缺失，龙头维度退化为涨停家数估分");

  return {
    gate: { amountTotalYi, amountMa20Yi, indexShClose, indexShMa20, ladderHighest, promotionRate },
    notes,
  };
}

// ─── 核心派生函数 ───────────────────────────────────────────────────────────────

/**
 * 涨跌分布能不能拿来打分。
 *
 * 🔴 **一家都没有（涨 + 跌 + 平 = 0）就是没取到数，不是市场冰点。**
 * 拿空数据照样算，会得出「涨停 0 家 → 冰点期 → 极高风险 → 不许开新仓」——
 * 一套严丝合缝的假结论，而真相只是一次取数失败。
 * 宁可说算不出来，也不给一个看起来很有把握的极端结论。
 */
export function breadthUsable(b: BreadthData): boolean {
  return (b.up ?? 0) + (b.down ?? 0) + (b.flat ?? 0) + (b.limit_up ?? 0) + (b.limit_down ?? 0) > 0;
}

/**
 * 数据新鲜度：哪些维度的驱动数据不是**今天**的。
 *
 * 🔴 为什么要这个：赚钱效应连续两天 49 分，看的人无从判断那是「市场真没变」还是
 *    「快照没刷新」。标出来，才知道该去点「重新取数」还是该接受这个读数。
 */
function staleness(
  provenance: MarketProvenance | null,
  today: string,
): { data_as_of: Record<string, string | null>; stale: string[] } {
  const data_as_of: Record<string, string | null> = {
    breadth: dateOf(provenance?.breadth),
    resonance: dateOf(provenance?.resonance),
    board_flow: dateOf(provenance?.board_flow),
    trend: dateOf(provenance?.trend),
    ladder: dateOf(provenance?.ladder),
    event: dateOf(provenance?.event),
  };
  const stale: string[] = [];
  for (const [dim, srcs] of Object.entries(DIM_SOURCES)) {
    if (!srcs.length) continue;
    const dates = srcs.map((s) => data_as_of[s]).filter((d): d is string => !!d);
    // 一个来源日期都没有 → 不是「陈旧」，是「不知道」，交给 notes
    if (!dates.length) continue;
    if (dates.every((d) => d !== today)) stale.push(dim);
  }
  return { data_as_of, stale };
}

/** 各维度的时间戳：取该维度所有来源里**最新**的那个日期 */
function dimensionAsOf(dim: string, dataAsOf: Record<string, string | null>): string | null {
  const srcs = DIM_SOURCES[dim] ?? [];
  const dates = srcs.map((s) => dataAsOf[s]).filter((d): d is string => !!d).sort();
  return dates.length ? dates[dates.length - 1]! : null;
}

/**
 * 从 `cctv_news` 信封里取出「这一期新闻联播的日期 + 全部标题」。
 *
 * 🔴 只取标题,不取正文:标题是政策要点的浓缩,足够做宏观词典扫描;
 *    取正文要逐条打开详情页(约 15 次请求),对「少而精」来说是纯浪费。
 */
export function cctvTitlesFrom(env: unknown): { date: string | null; titles: string[] } {
  const evs = evidenceOf(env);
  const titles: string[] = [];
  let date: string | null = null;
  for (const e of evs) {
    if (e.field !== "cctv_news_title") continue;
    const v = typeof e.value === "string" ? e.value.trim() : "";
    if (!v) continue;
    titles.push(v);
    // record_key 形如 cctv:2026-10-29:3,日期就在里面
    const m = /^cctv:(\d{4}-\d{2}-\d{2}):/.exec(String(e.record_key ?? ""));
    if (m) date = m[1]!;
    else if (!date) date = dateOf(typeof e.as_of === "string" ? e.as_of : null);
  }
  return { date, titles };
}

/**
 * 从原始数据块派生市场状态信号。
 * 涨跌分布一家都没有时返回「算不出来」（各项为 null），**不给低分、不给 0 仓位上限**。
 * @param breadth 涨跌分布（必需）
 * @param resonance 板块共振信号
 * @param boardFlow 资金流数据
 * @param gateData 主升期闸门输入（可选，null = 量能门 / 均线门无数据）
 * @param opts.provenance 各来源的取数时间（用于时间戳与陈旧标记）
 * @param opts.event 事件面读数（新闻联播 + 宏观词典）；缺省/null = 事件面算不出来，权重让渡
 */
export function deriveMarketSignal(
  breadth: BreadthData,
  resonance: { rows?: { resonance_rate: number | null }[]; resonance_share?: number | null },
  boardFlow: { rows?: { net_yi?: number }[] },
  gateData: MarketGateData | null = null,
  opts: { provenance?: MarketProvenance | null; event?: MacroEventReading | null } = {},
): MarketSignal {
  const stamp = new Date().toISOString();
  const today = clockOf(new Date()).day;
  const prov = opts.provenance ?? null;
  const fresh = staleness(prov, today);
  const event = opts.event ?? null;

  if (!breadthUsable(breadth)) {
    return {
      composite: null, phase: null, base_phase: null, base_note: null, position_cap_pct: null, can_open_position: null, risk_level: null,
      emotion_score: null, dragon_score: null, risk_score: null, earning_score: null,
      event_score: event?.score ?? null, event_detail: event, weights: null,
      unavailable: "没取到涨跌分布（涨跌家数一家都没有），算不出市场状态；因此不给仓位上限",
      sources: [...SOURCES], notes: [], gate_blockers: [], gate_unknown: [], gate_items: [], phase_reasons: [],
      data_as_of: fresh.data_as_of, stale_dimensions: [], derived_at: stamp,
    };
  }
  const limitUp = breadth.limit_up ?? 0;
  const limitDown = breadth.limit_down ?? 0;
  const up = breadth.up ?? 0;
  const down = breadth.down ?? 0;
  const flat = breadth.flat ?? 0;
  // 🔴 共振率已按 ÷100 缩放（源端是百分比 0-100，这里是小数 0-1）
  const resonanceRates = (resonance.rows ?? []).map((r) => {
    const v = r.resonance_rate ?? 0;
    return v > 1 ? v / 100 : v;
  });
  const boardRows = boardFlow.rows ?? [];
  const inflowCount = boardRows.filter((r) => (r.net_yi ?? 0) > 0).length;
  // 🔴 一行都没有 = 资金流没取到 → null(该条腿的权重让渡),不能写 0 —— 0 的意思是「有数据但一个板块都没净流入」
  const inflowRate = boardRows.length ? inflowCount / boardRows.length : null;
  // 共振同理:既没聚合占比、也没有展示行 = 没取到
  const hasResonance = resonance.resonance_share != null || (resonance.rows ?? []).length > 0;
  // 完备性要在算仓位上限之前就定下来：它既决定分数怎么补位，也决定这个分数能用到多重的仓
  const missingLegs = [!hasResonance ? "板块共振" : "", inflowRate === null ? "板块资金流" : ""].filter(Boolean);

  // 五维打分 + 门槛制阶段（全仓唯一一份，见 market_score.ts）
  const dims = scoreMarket({
    limit_up: limitUp,
    limit_down: limitDown,
    up,
    down,
    flat,
    resonanceRates,
    resonanceShare: resonance.resonance_share ?? null,
    inflowRate,
    promotionRate: gateData?.promotionRate ?? null,
    ladderHighest: gateData?.ladderHighest ?? null,
    gateData,
    eventScore: event?.score ?? null,
  });

  const total = up + down + flat;
  const downRate = total > 0 ? down / total : 0;

  const riskLevel = riskLevelOf(dims.risk, { limitDown, downRate });
  // 🔴 缺腿日不许给满仓：分数按中性补位是「不冤枉这一天」，不是「这一天数据齐」。
  //    与「闸门未评估」共用 INCOMPLETE_DATA_CAP_PCT，不另设标准。
  const positionCapPct = positionCapOf(dims.composite, dims.gate, { dataIncomplete: missingLegs.length > 0 });
  // 「能不能开新仓」要求上限至少到「轻仓试探」(40%)。20% 那一档的含义是
  // 「已经拿着的仓位最多留这么多」，不是「可以新开」—— 两者混起来就等于放松了纪律。
  const canOpenPosition = positionCapPct >= 40 && riskLevel !== "extreme";

  const notes: string[] = [];
  if (dims.event === null) {
    notes.push("事件面没算出来（新闻联播当期没取到或没有条目），该维度权重已让渡给其余四项");
  } else if (event && event.macro_hits === 0) {
    notes.push(`事件面：${event.note}——有数据源、今日无宏观政策条目，按中性 50 计（不是「没接入」）`);
  } else if (event) {
    notes.push(`事件面：${event.note}`);
  }
  if (fresh.stale.length) {
    notes.push(`以下维度的数据不是 ${today} 的：${fresh.stale.join(" / ")}（读数可能已被冻结，建议重新取数）`);
  }
  // 赚钱效应的腿缺了要明说:分数按中性补位(不按 0)、仓位上限另外压一档，两件事都写清楚。
  // 不写的话分数看着正常、仓位看着也正常，其实少看了东西 —— 典型的「不报错但给错答案」。
  if (missingLegs.length) {
    // 说「最多」不说「压到」：40% 是天花板，取小之后完全可能被闸门/分数压得更低。
    // 实机 2026-11-06 就是 cap=0（三门全灭），写「压到 40%」会与同屏「仓位上限归零」打架。
    notes.push(`赚钱效应的${missingLegs.join("、")}没取到，这部分按中性补位（既不当 0 分，也不会因为缺数据反而变好）；仓位上限因此最多 ${INCOMPLETE_DATA_CAP_PCT}%（与「闸门未评估」同一档，不拿取数故障当利好），实际 ${positionCapPct}%${missingLegs.length === 2 ? "；这一维现在等于只剩广度，可信度低于平时" : ""}`);
  }
  if (dims.gate.unknown.length) notes.push(`闸门未评估：${dims.gate.unknown.join("；")}`);

  return {
    composite: dims.composite,
    phase: dims.stage,
    base_phase: dims.base_stage,
    base_note: dims.base_note,
    position_cap_pct: positionCapPct,
    incomplete_legs: missingLegs,
    can_open_position: canOpenPosition,
    risk_level: riskLevel,
    emotion_score: dims.emotion,
    dragon_score: dims.dragon,
    risk_score: dims.risk,
    earning_score: dims.earning,
    event_score: dims.event,
    event_detail: event,
    weights: dims.weights,
    unavailable: null,
    sources: [...SOURCES],
    notes,
    gate_blockers: dims.gate.blockers,
    gate_unknown: dims.gate.unknown,
    gate_items: dims.gate.items ?? [],
    phase_reasons: dims.phase_reasons,
    data_as_of: fresh.data_as_of,
    stale_dimensions: fresh.stale,
    derived_at: stamp,
  };
}

/**
 * 构建完整的市场状态视图（供前端展示）。
 *
 * 🔴 action / position_range **只由仓位上限派生**，不由 phase 派生。
 *    原先 composite<45 映射成「观望等待」+ `市场${phase}，不宜开新仓`，于是
 *    「修复期」和「0 仓」被写在同一张卡片上 —— 两句话各自都对，放一起自相矛盾。
 *    现在：0% 就是「空仓等待」，reason 只讲数据与闸门，phase 只讲情绪周期。
 */
export function buildMarketStateView(
  signal: MarketSignal,
  breadth: BreadthData,
  _resonance: { rows?: { resonance_rate: number | null }[] },
  gateData: MarketGateData | null = null,
): MarketStateView {
  const limitUp = breadth.limit_up ?? 0;
  const limitDown = breadth.limit_down ?? 0;
  const total = (breadth.up ?? 0) + (breadth.down ?? 0) + (breadth.flat ?? 0);
  const upRate = total > 0 ? (breadth.up ?? 0) / total : 0;
  const hasDragon = limitUp >= 20;
  const asOf = signal.data_as_of;
  const staleSet = new Set(signal.stale_dimensions);
  const w = signal.weights;
  /** 单维的「权重 / 数据日期 / 是否陈旧」三件套 —— 分数由调用处填 */
  const meta = (k: keyof NonNullable<MarketSignal["weights"]>): Omit<DimensionView, "score"> => ({
    weight: w ? Math.round(w[k] * 1000) / 1000 : null,
    as_of: dimensionAsOf(k, asOf),
    stale: staleSet.has(k),
  });

  // 算不出来：一个数字都不给，也不给操作建议（「观望」本身就是一个建议）
  if (signal.unavailable) {
    return {
      date: clockOf(new Date()).day,
      clock: clockOf(new Date()).hms.slice(0, 5),
      signal,
      dimensions: {
        emotion: { score: null, weight: null, as_of: null, stale: false, stage: null },
        dragon: { score: null, weight: null, as_of: null, stale: false, has_dragon: null, ladder_highest: null },
        risk: { score: null, weight: null, as_of: null, stale: false, limit_down: null },
        earning: { score: null, weight: null, as_of: null, stale: false, up_rate: null },
        event: { score: null, weight: null, as_of: null, stale: false },
      },
      recommendation: { action: "算不出来", confidence: 0, position_range: "—", reason: signal.unavailable },
      gate: { all_pass: false, blockers: [], unknown: [], items: [] },
      notes: [],
    };
  }

  const cap = signal.position_cap_pct ?? 0;
  // 动作只跟仓位上限走 —— 这样「0%」永远不会和「修复期」出现在同一句里
  const actionOf = (c: number): { action: string; confidence: number } => {
    if (c >= 100) return { action: "顺势而为", confidence: 0.8 };
    if (c >= 70) return { action: "中等仓位", confidence: 0.7 };
    if (c >= 40) return { action: "轻仓试探", confidence: 0.6 };
    if (c >= 20) return { action: "防守参与", confidence: 0.5 };
    return { action: "空仓等待", confidence: 0.5 };
  };
  const { action, confidence } = actionOf(cap);

  // 事件面的「数据日期」用**新闻联播播出日**，不用取数时间 ——
  // 18:00 跑的时候当晚 19:00 那期还没播，拿到的是前一晚的稿子，用取数时间会假装今天是新的。
  // 🔴 但**允许滞后 1 天**才算陈旧：联播白天本来就只有昨晚那期，按「不是今天就陈旧」标记，
  //    会天天把一个正常状态涂成警告色，反而让真正的旧数据（假期停更 / 取数失败）被淹没。
  const today = clockOf(new Date()).day;
  const yesterday = clockOf(new Date(Date.now() - 86_400_000)).day;
  const eventAsOf = signal.event_detail?.date ?? dimensionAsOf("event", asOf);
  const eventMeta = {
    ...meta("event"),
    as_of: eventAsOf,
    stale: eventAsOf ? eventAsOf < yesterday : false,
  };

  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  const parts: string[] = [];
  parts.push(`上涨家数 ${pct(upRate)}，涨停 ${limitUp} / 跌停 ${limitDown}`);
  parts.push(`综合 ${signal.composite} 分（五维 0–100、分越高越正面：情绪 ${signal.emotion_score}·龙头 ${signal.dragon_score}·抗跌度 ${signal.risk_score}·赚钱效应 ${signal.earning_score}${signal.event_score === null ? "·事件未算出" : `·事件 ${signal.event_score}`}）`);
  if (signal.gate_blockers.length) {
    // 🔴 只写摘要：明细在 gate_blockers 里已经逐条给前端渲染了。
    //    早先把 join("；") 整段塞进 reason，于是页面上三道门的文字出现两遍（一遍是闸门卡，一遍在这句里）。
    parts.push(`闸门 ${signal.gate_blockers.length} 门未过`);
  }
  else if (signal.gate_unknown.length) parts.push(`闸门部分未评估：${signal.gate_unknown.join("；")}`);
  else parts.push("三道闸门全通过");
  if (signal.can_open_position === false && signal.risk_level === "extreme") parts.push("极高风险，仓位上限归零");
  // 结构化字段驱动，不去 notes 里搜关键字：措辞改了这句也不会静默消失。
  // 🔴 只在完备性**真的是那个约束项**时才说「压到 40%」：缺腿时 cap 必然 ≤40，
  //    等于 40 才是它压下来的；cap 更低时闸门/分数已经压得更死，这里再讲一遍
  //    就会和「仓位上限归零」并列成两句互相打架的话。
  if (signal.incomplete_legs?.length && cap === INCOMPLETE_DATA_CAP_PCT) {
    parts.push(`赚钱效应缺${signal.incomplete_legs.join("、")}，仓位上限压到 ${INCOMPLETE_DATA_CAP_PCT}%`);
  }

  return {
    date: clockOf(new Date()).day,
    clock: clockOf(new Date()).hms.slice(0, 5),
    signal,
    dimensions: {
      emotion: { ...meta("emotion"), score: signal.emotion_score, stage: signal.phase },
      dragon: { ...meta("dragon"), score: signal.dragon_score, has_dragon: hasDragon, ladder_highest: gateData?.ladderHighest ?? null },
      risk: { ...meta("risk"), score: signal.risk_score, limit_down: limitDown },
      earning: { ...meta("earning"), score: signal.earning_score, up_rate: upRate },
      event: { ...eventMeta, score: signal.event_score },
    },
    recommendation: { action, confidence, position_range: `${cap}%`, reason: parts.join("；") },
    // 三门都**确定**通过才叫 all_pass；有门没评估时是「N 门无数据」，不是「0 门未过」。
    gate: {
      all_pass: signal.gate_blockers.length === 0 && signal.gate_unknown.length === 0,
      blockers: signal.gate_blockers,
      unknown: signal.gate_unknown,
      items: signal.gate_items,
    },
    notes: [],
  };
}

// ─── API 入口 ───────────────────────────────────────────────────────────────────

interface RawBundle {
  breadth: FetchResult | null;
  resonance: FetchResult | null;
  boardFlow: FetchResult | null;
  trend: FetchResult | null;
  ladder: FetchResult | null;
  /** 事件面唯一数据源：央视新闻联播（只取标题） */
  cctv: FetchResult | null;
  notes: string[];
  provenance: MarketProvenance;
}

/**
 * 各端点独立取、独立降级。任何一项失败都不拖垮其余 ——
 * 涨跌分布决定「算不算得出来」，其余决定「算得准不准」。
 *
 * 🔴 并发纪律：一共 6 个端点，其中 `cctv_news` 已声明 1 小时缓存、
 *    且传 `with_content:false` 只发 1 次请求（不开 15 个详情页），
 *    ladder 给 30s 短超时。
 *
 * 🔴 `em_market_trend` 给 **100s**，不是 30s —— 2026-11-05 实测把它拆开计时后改的：
 *    腾讯那 7 根指数日线各只要 0.5s，而两市成交额那一项，东财 push2his 三个域名
 *    （push2his / push2delay / 91.push2his）当周全断（RemoteDisconnected），只能落 baostock，
 *    而 **baostock 登录单次就要 87s**。该端点 13 次真实耗时的中位数是 38.6s、尾部 88.2s，
 *    9/13 超过 30s。
 *    👉 30s 的后果不是「慢一点」，是**结构性失败**：超时 → trend 信封为 null → `gateDataFrom`
 *       拿不到任何输入 → 量能门与均线门同时变成 unknown（广度门走另一个端点，所以只有它还亮）。
 *       叠加失败记忆的 60s 负缓存，15s 轮询几乎一直吃到它，命中率≈0。
 *    代价：冷启动那一屏最坏要等 100s；仍是单点，baostock 抖一下照样空。治本要另想办法
 *    （见 CHANGELOG 里「20 日均额落盘」那条），这里先把「必然失败」降到「迟早能成」。
 */
async function loadBundle(ctx: ServiceContext, session: string, abortSignal: AbortSignal, force = false): Promise<RawBundle> {
  const notes: string[] = [];
  const one = async (endpoint: string, label: string, opts: { args?: Record<string, unknown>; timeoutMs?: number } = {}): Promise<FetchResult | null> => {
    try {
      const r = await fetchEndpoint(ctx, {
        endpoint, session, signal: abortSignal,
        ...(opts.args ? { args: opts.args } : {}),
        ...(opts.timeoutMs ? { timeout_ms: opts.timeoutMs } : {}),
        // 🔴 这 6 个端点原来**一个时效上限都没有**：`DEFAULT_CONSISTENCY` 是
        //    `{mode:"prefer_cache"}` 不带 max_age，而快照键只由「端点+参数」决定、不含日期 ——
        //    于是「市场状态」这一屏其实是**别人在替它刷**（em_market_breadth 由台账任务刷、
        //    em_market_trend 由盯盘概况刷）。没人刷的那把键就永久冻结。
        consistency: consistencyFor(endpoint, force),
      });
      // 🔴 上游「跑完了但 status=failed」不会抛异常。早先只有 catch 才记 note，
      //    于是新闻联播挂掉时事件面静默变 null，页面上只看到一个空环、什么原因都没有。
      //    这里把失败原因记下来 —— 空，必须是**说得出理由的空**。
      const env = r.envelope as { status?: string; errors?: { error?: string }[] } | undefined;
      if (env?.status === "failed") {
        const why = env.errors?.map((x) => x.error).filter(Boolean).slice(0, 1).join("") || "上游返回 failed";
        notes.push(`${label}取数失败：${why}`);
      }
      return r;
    } catch (e) {
      notes.push(`${label}取数失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const [breadth, resonance, boardFlow, trend, ladder, cctv] = await Promise.all([
    one("em_market_breadth", "涨跌分布"),
    one("em_industry_comparison", "板块共振"),
    one("sina_board_flow", "板块资金流"),
    one("em_market_trend", "指数趋势/成交额", { timeoutMs: 100_000 }),
    one("cn_shortline_board_ladder", "连板天梯", { timeoutMs: 30_000 }),
    // 只要标题：正文要逐条开详情页(≈15 次请求)，对事件分没有增量信息
    one("cctv_news", "新闻联播", { args: { with_content: false }, timeoutMs: 30_000 }),
  ]);
  return {
    breadth, resonance, boardFlow, trend, ladder, cctv, notes,
    provenance: {
      breadth: breadth?.fetched_at ?? null,
      resonance: resonance?.fetched_at ?? null,
      board_flow: boardFlow?.fetched_at ?? null,
      trend: trend?.fetched_at ?? null,
      ladder: ladder?.fetched_at ?? null,
      event: cctv?.fetched_at ?? null,
    },
  };
}

/** 把 bundle 压成 derive 需要的三个数据块 + 闸门 + 事件面读数 */
function shapeBundle(b: RawBundle): {
  breadth: BreadthData;
  resonance: { rows: { resonance_rate: number | null }[]; resonance_share: number | null };
  boardFlow: { rows: { net_yi: number }[] };
  gate: MarketGateData | null;
  event: MacroEventReading | null;
  gateNotes: string[];
} {
  const { gate, notes } = gateDataFrom(b.trend?.envelope, b.ladder?.envelope);
  const cctv = b.cctv ? cctvTitlesFrom(b.cctv) : { date: null, titles: [] };
  // 共振与资金流走共享解析：共振率是「上涨家数/总家数」算出来的，资金流用**全部**板块
  const res = parseResonance(b.resonance?.envelope);
  return {
    breadth: extractBreadth(b.breadth),
    resonance: {
      rows: res.rows.map((r) => ({ resonance_rate: r.resonance_rate })),
      resonance_share: res.resonance_share,
    },
    boardFlow: { rows: boardFlowNetRows(b.boardFlow?.envelope) },
    gate,
    event: readMacroEvents(cctv),
    gateNotes: notes,
  };
}

/**
 * 市场状态信号端点。
 * 返回紧凑的 MarketSignal，供其他工具读取。
 */
export async function marketStateAct(
  ctx: ServiceContext,
  body: Record<string, unknown>,
  abortSignal: AbortSignal,
): Promise<MarketSignal> {
  const bundle = await loadBundle(ctx, "market_state", abortSignal, wantsFresh(body?.refresh));
  const { breadth, resonance, boardFlow, gate, event, gateNotes } = shapeBundle(bundle);

  const result = deriveMarketSignal(breadth, resonance, boardFlow, gate, { provenance: bundle.provenance, event });

  // 降级提示走 notes，不塞进 sources ——「取数失败」不是一种数据来源，混进去会让人以为它是
  result.notes = [...bundle.notes, ...gateNotes, ...result.notes];
  return result;
}

/**
 * 市场状态完整视图端点（供前端展示）。
 */
export async function marketStateViewAct(
  ctx: ServiceContext,
  body: Record<string, unknown>,
  abortSignal: AbortSignal,
): Promise<MarketStateView> {
  // 🔴 前端「市场状态」页打的就是这个视图（`/view/market_state_view`），它的 `?refresh=1`
  //    原来同样被丢掉 —— 页面上的「重新取数」按钮点了等于没点。
  const bundle = await loadBundle(ctx, "market_state_view", abortSignal, wantsFresh(body?.refresh));
  const { breadth, resonance, boardFlow, gate, event, gateNotes } = shapeBundle(bundle);

  const sig = deriveMarketSignal(breadth, resonance, boardFlow, gate, { provenance: bundle.provenance, event });
  const view = buildMarketStateView(sig, breadth, resonance, gate);
  // 🔴 `view.notes` 才是前端「降级提示」渲染的那一份。原来只放取数降级 + 闸门说明，
  //    derive 自己产出的那些（事件面没算出 / 赚钱效应缺腿压仓 / 闸门未评估）只留在
  //    signal.notes 里，页面根本看不见 —— 缺口又被静默了一次，正是这轮要堵的那类问题。
  //    两处共用同一个数组，也避免出现「同一份数据两个说法」。
  const allNotes = [...sig.notes, ...bundle.notes, ...gateNotes];
  view.signal.notes = allNotes;
  view.notes = allNotes;
  return view;
}
