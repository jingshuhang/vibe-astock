/**
 * 市场五维打分 —— 全仓唯一一份实现。
 *
 * 同一套「情绪 / 龙头 / 风险 / 赚钱效应 / 事件」五维加权,以前在
 * shortline/overview.ts(市场健康度)和 finance/market_state.ts(市场状态信号)里各写了一遍,
 * 是复制粘贴;两份必然漂移,于是同一个市场能在两个页面给出两个结论(score 不同 / 标签不同)。
 * 抽到这里,两个页面共用同一份数学。
 *
 * 分工:
 *  - 本模块只负责「算分 + 定阶段」(纯函数,可单测)。
 *  - 「一家都没有 = 没取到数、算不出来」由各自的 breadthUsable / 缺数据判定负责,不在本模块。
 *  - 「分数映射到什么展示动作」由 buildMarketStateView 决定,本模块只给仓位上限。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 2026-10-30 第二轮重构。起因:实测盘面(广度 16% / 跌停 93 家 / 指数破 20 日线 /
 *    放量下跌)在页面上被标成「主升期 56 分」,分项自己加权算出 43.9 而页面显示 33。
 *    四个根因,逐条改掉:
 *
 *  1. **阶段不能只由涨停家数单阈值决定。** 涨停 39~49 家就跳进「主升期」(score 70),
 *     与同日广度 14% 完全背离。现在:
 *       - 情绪分是「涨停家数」+「涨跌停比」两腿的连续读数(分段线性,没有阈值跳变);
 *       - **阶段改成门槛制**(resolvePhase):主升期及以上必须同时过闸门;
 *       - 补上缺失的「退潮期」——「涨停 49 / 跌停 93 / 广度 16%」被叫成「修复期」
 *         是自相矛盾的(修复期要求广度 ≥ 40% 且 涨 ≥ 跌)。
 *
 *  2. **composite 恒等于五维加权。** 原先闸门不通过时按 scale 整体缩放分数,
 *     于是「分项加权 43.9」与「显示 33」同时成立,用户拿分项自己算怎么都对不上。
 *     现在 composite 只有一个来源(weightedComposite),缩放逻辑删除。
 *
 *  3. **没有数据源的维度不占权重。** 事件面原先恒为常数 50,把 15% 的权重喂给了
 *     一个永远不变的数 —— 综合分被系统性地拉向 50。现在 event 传 null 即「未接入」,
 *     该维度的权重按比例让渡给其余维度,并在 weights 里如实返回。
 *
 *  4. **风险等级由风险分自己决定**,不再由 composite 反推。
 *     原先「极高风险」是从 composite<35 推出来的,于是出现「风险 15 分却叫极高风险」
 *     这种分值-标签互相打架的读法。现在两者各说各的,再加一条盘面硬约束兜底。
 * ────────────────────────────────────────────────────────────────────────────
 */

/** 市场阶段。**六档**,比原先多一个「退潮期」—— 高位放量下跌 / 跌停成片不是「修复期」。 */
export type MarketPhase = "冰点期" | "退潮期" | "修复期" | "主升期" | "高潮期" | "极度高潮期";

export const MARKET_PHASES: readonly MarketPhase[] = ["冰点期", "退潮期", "修复期", "主升期", "高潮期", "极度高潮期"] as const;

export type RiskLevel = "low" | "medium" | "high" | "extreme";

/** 五维原始分。null = 这一维没有数据源(不是 0 分) */
export interface DimensionScores {
  emotion: number | null;
  dragon: number | null;
  risk: number | null;
  earning: number | null;
  /** 事件面。null = 未接入(权重让渡),不是中性 50 */
  event: number | null;
}

/** 实际生效权重(缺项让渡后,五项之和 = 1) */
export type EffectiveWeights = Record<keyof DimensionScores, number>;

export interface MarketDimensions {
  emotion: number;
  dragon: number;
  risk: number;
  earning: number;
  /** 事件分;null = 没有数据源,不参与加权 */
  event: number | null;
  /** 综合健康分 = 五维加权(见 weights),不经过任何缩放 */
  composite: number;
  /** **最终**阶段(过了门槛制的那一个) */
  stage: MarketPhase;
  /** 只看涨停家数得到的「情绪读数阶段」,仅用于诊断 —— 最终 phase 不取它 */
  base_stage: MarketPhase;
  /**
   * base_stage ≠ stage 时给人看的一句话解释;两者一致时为 null。
   * 🔴 必须区分「跌停潮」与「闸门压制」—— 前者不能写成「情绪本可到主升期」。
   */
  base_note: string | null;
  /** 实际生效权重,前端据此显示真实公式 */
  weights: EffectiveWeights;
  /** 闸门评估结果 */
  gate: GateResult;
  /** 阶段是怎么定下来的(降级原因),供 notes / 调试 */
  phase_reasons: string[];
}

/** 主升期硬闸门参数(由调用方从 em_market_trend / cn_shortline_board_ladder 解出) */
export interface MarketGateInput {
  /** 今日两市成交额(元) */
  amountTotalYi: number | null;
  /** 近 20 个交易日均额(元),无数据时 null */
  amountMa20Yi: number | null;
  /** 上证指数最新收盘价(点),无数据时 null */
  indexShClose: number | null;
  /** 上证指数近 20 日均线(点),无数据时 null */
  indexShMa20: number | null;
  /** 连板最高高度(板),无数据时 null */
  ladderHighest: number | null;
  /** 最近一级晋级率(小数,0..1),无数据时 null */
  promotionRate: number | null;
}

/** 一道闸门的三态（前端按 key 渲染，不靠文案猜） */
export interface GateItem {
  key: "breadth" | "volume" | "ma20";
  /** 门槛的固定说法，与 detail 分开，便于以后改门槛数值而不动文案 */
  label: string;
  state: "pass" | "fail" | "unknown";
  /** 这一门的实际读数或缺失原因 */
  detail: string;
}

/** 闸门评估结果(用于诊断和 notes) */
export interface GateResult {
  /**
   * 三门都**确定**通过 —— 才是 true。
   *
   * 🔴 这里踩过一次大坑:原定义是「有数据的门都通过」,于是 `blockers.length === 0` 就为 true。
   *    后果:东财趋势端点超时(量能 / 均线两门没数据)时,只要广度够 55%,**照样判「高潮期」
   *    并给出「可开新仓 40%」** —— 恰好在最该保守的时候变成最激进,正是「取不到数据 = 通过」
   *    这个老毛病的翻版。现在:有门没评估 ⇒ allPass = false,阶段不许升到主升期及以上。
   *    区分看 `unknown`:未知不等于失败(不该全面禁买),但**绝不等于通过**。
   */
  allPass: boolean;
  /** 失败原因列表(空 = 没有门失败) */
  blockers: string[];
  /** 有数据、且通过的门 */
  passed: string[];
  /** 没数据、因此**既不算通过也不算失败**的门 —— 不能把「不知道」当成「通过」 */
  unknown: string[];
  /**
   * 三道门的结构化三态（顺序固定：广度 / 量能 / MA20），前端直接按 key 渲染。
   * `evaluateMarketGate` 一定会填；只有测试里手工拼的部分 GateResult 可以省。
   */
  items?: GateItem[];
}

/** 五维权重(与早期引擎对齐:情绪最重,其次赚钱效应) */
export const MARKET_WEIGHTS = {
  emotion: 0.30,
  dragon: 0.15,
  risk: 0.15,
  earning: 0.25,
  event: 0.15,
} as const;

/**
 * 事件面的权重上限。
 *
 * 🔴 名义 15%,实给 8%。原因:事件面用的是**文本代理指标**(新闻联播标题 + 宏观词典),
 *    词典认不出否定与条件,官方表述又天然偏正面 —— 它的可信度撑不起 15%。
 *    差额按原比例让渡给其余四项,所以「有数据」不等于「和别的一样本事」。
 *    这样即使整套事件判断都错了,对综合分的影响也只有 ±2 分(35~65 区间 × 8%)。
 */
export const EVENT_WEIGHT_CAP = 0.08;

const DIM_KEYS = ["emotion", "dragon", "risk", "earning", "event"] as const;

/** 主升期门槛下限(涨停家数)。低于它的日子根本不谈主升。 */
export const PHASE_MIN_LIMIT_UP = { main: 25, climax: 50, extreme: 70 } as const;
/** 广度门槛:主升期以上必须「多数股票在涨」。 */
export const PHASE_MIN_UP_RATE = 0.55;
/** 修复期门槛:要有广度、要有活口、且涨多于跌 —— 三条缺一条就不配叫修复 */
export const REPAIR_MIN_UP_RATE = 0.40;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ─── 情绪:涨停家数 + 涨跌停比 ────────────────────────────────────────────────────

/**
 * 涨停家数 → 0-100。分段线性插值,**不是台阶**。
 *
 * 🔴 台阶的问题:39 家与 40 家只差 1 家,分数却跳 25 分(45→70),于是「阶段」在
 *    家数阈值附近反复横跳,用户看到的是「昨天修复期、今天主升期,而盘面没变」。
 *    锚点按 A 股实况定:日常 40~80 家属正常,120 家以上才是普涨强势,200+ 才叫极端。
 */
const LIMIT_UP_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0, 10],
  [20, 28],
  [40, 45],
  [60, 58],
  [80, 68],
  [120, 82],
  [160, 90],
  [220, 96],
];

export function limitUpScore(limitUp: number): number {
  const x = Math.max(0, Number.isFinite(limitUp) ? limitUp : 0);
  const last = LIMIT_UP_ANCHORS[LIMIT_UP_ANCHORS.length - 1]!;
  if (x >= last[0]) return last[1];
  for (let i = 1; i < LIMIT_UP_ANCHORS.length; i++) {
    const [x1, y1] = LIMIT_UP_ANCHORS[i]!;
    const [x0, y0] = LIMIT_UP_ANCHORS[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

/**
 * 涨跌停比 → 0-100(情绪极性)。涨停 49 / 跌停 93 时是 34.5 —— 单看「涨停 49 家」看不出
 * 这层意思,而它恰恰是「涨停不少、但跌停更多」这种分化盘的关键读数。
 * @returns 涨停与跌停都是 0 时返回 null(没有极性可读,不是 50)
 */
export function polarityScore(limitUp: number, limitDown: number): number | null {
  const tot = Math.max(0, limitUp) + Math.max(0, limitDown);
  if (tot <= 0) return null;
  return (Math.max(0, limitUp) / tot) * 100;
}

/** 只看涨停家数的「情绪读数阶段」。它是 base_stage,不是最终 phase。 */
export function baseStageOf(limitUp: number): MarketPhase {
  if (limitUp >= 100) return "极度高潮期";
  if (limitUp >= 60) return "高潮期";
  if (limitUp >= 30) return "主升期";
  if (limitUp >= 15) return "修复期";
  return "冰点期";
}

/**
 * 情绪读数 = 0.75 × 涨停家数分 + 0.25 × 涨跌停比。
 * 两腿缺一腿时退化为单腿(涨跌停比没有数据时不让它变成 0 分,那会把情绪凭空砍掉 1/4)。
 */
export function emotionReading(limitUp: number, limitDown: number): { score: number; base_stage: MarketPhase } {
  const base = limitUpScore(limitUp);
  const pol = polarityScore(limitUp, limitDown);
  const score = pol === null ? base : 0.75 * base + 0.25 * pol;
  return { score: round1(clamp(score, 0, 100)), base_stage: baseStageOf(limitUp) };
}

// ─── 闸门 ───────────────────────────────────────────────────────────────────────

/**
 * 主升期硬闸门评估。
 *
 * 🔴 闸门**不改分数**,只决定阶段能不能叫主升期及以上。分数维持原值(便于回测对比)。
 * 🔴 **没数据的门记进 unknown,既不算通过也不算失败** —— 把「取不到量能数据」当成
 *    「量能过关」是这套东西最早犯的错(闸门在生产路径上从来没生效过)。
 *
 * @param limitUp 涨停家数(仅用于诊断文案,不参与判门)
 * @param upRate 上涨家数占比(0..1)
 * @param g 闸门输入(可为 null,表示没有这些数据)
 */
export function evaluateMarketGate(
  limitUp: number,
  upRate: number,
  g: MarketGateInput | null,
): GateResult {
  const blockers: string[] = [];
  const passed: string[] = [];
  const unknown: string[] = [];
  /**
   * 结构化的三态。
   * 🔴 加这个是因为前端原先靠**文案关键字**（"广度"/"量能"/"MA20"）去 blockers/unknown 里配对 ——
   *    哪天改个措辞（比如「MA20」写成「20 日均线」），三道门就会静默全显示「通过」。
   *    「本该红的地方变绿」是最危险的方向，所以状态必须由后端给 key，前端不许猜。
   */
  const items: GateItem[] = [];

  // 门 1: 广度 ≥ 55%(这条永远有数据 —— 涨跌家数就在手里)
  if (upRate < PHASE_MIN_UP_RATE) {
    const d = `广度 ${Math.round(upRate * 100)}% < ${Math.round(PHASE_MIN_UP_RATE * 100)}%`;
    blockers.push(d);
    items.push({ key: "breadth", label: "广度 ≥ 55%", state: "fail", detail: d });
  } else {
    passed.push("广度");
    items.push({ key: "breadth", label: "广度 ≥ 55%", state: "pass", detail: `广度 ${Math.round(upRate * 100)}%` });
  }

  // 门 2: 量能环比 ≥ +10%(与 20 日均额相比)
  const hasAmount = !!g && g.amountTotalYi != null && g.amountMa20Yi != null && g.amountMa20Yi > 0;
  if (!hasAmount) {
    const d = "量能(没有 20 日均额或今日成交额)";
    unknown.push(d);
    items.push({ key: "volume", label: "量能 ≥ 20 日均额 +10%", state: "unknown", detail: "没有 20 日均额或今日成交额" });
  } else {
    const ratio = g!.amountTotalYi! / g!.amountMa20Yi!;
    if (ratio < 1.10) {
      const d = `量能 ${((ratio - 1) * 100).toFixed(1)}% vs 20日均额,需 ≥+10%`;
      blockers.push(d);
      items.push({ key: "volume", label: "量能 ≥ 20 日均额 +10%", state: "fail", detail: d });
    } else {
      passed.push("量能");
      items.push({ key: "volume", label: "量能 ≥ 20 日均额 +10%", state: "pass", detail: `量能 ${((ratio - 1) * 100).toFixed(1)}%` });
    }
  }

  // 门 3: 指数 > MA20(上证)
  const hasMa = !!g && g.indexShClose != null && g.indexShMa20 != null && g.indexShMa20 > 0;
  if (!hasMa) {
    unknown.push("指数>MA20(没有上证收盘或 20 日均线)");
    items.push({ key: "ma20", label: "上证 > MA20", state: "unknown", detail: "没有上证收盘或 20 日均线" });
  } else if (g!.indexShClose! <= g!.indexShMa20!) {
    const d = `上证 ${g!.indexShClose} ≤ MA20 ${g!.indexShMa20}`;
    blockers.push(d);
    items.push({ key: "ma20", label: "上证 > MA20", state: "fail", detail: d });
  } else {
    passed.push("指数>MA20");
    items.push({ key: "ma20", label: "上证 > MA20", state: "pass", detail: `上证 ${g!.indexShClose} > MA20 ${g!.indexShMa20}` });
  }

  return { allPass: blockers.length === 0 && unknown.length === 0, blockers, passed, unknown, items };
}

// ─── 阶段:门槛制 ────────────────────────────────────────────────────────────────

/**
 * 阶段判定 —— **门槛制**,不是「分数落在哪一档」。
 *
 * 从高到低逐级检查,取第一个满足的:
 *   极度高潮期:涨停 ≥ 70 且 广度 ≥ 55% 且 闸门全过
 *   高潮期    :涨停 ≥ 50 且 广度 ≥ 55% 且 闸门全过
 *   主升期    :涨停 ≥ 25 且 闸门全过
 *   修复期    :广度 ≥ 40% 且 涨停 ≥ 15 且 涨停 ≥ 跌停   ← 三条都是「修复」的特征,缺一条就不叫修复
 *   退潮期    :涨停 ≥ 15 且(跌停 ≥ 涨停 或 广度 < 30%)  ← 还有活口,但赚钱效应已被打掉
 *   冰点期    :其余
 *
 * 🔴 关键:主升期及以上**必须过闸门**。过不了就最高只能是修复期(或退潮 / 冰点),
 *    不能因为「情绪分 70 分」就把阶段拉上去 —— 那正是「广度 14% 也叫主升期」的来源。
 */
export function resolvePhase(input: {
  limitUp: number;
  limitDown: number;
  upRate: number;
  gate: GateResult;
}): { phase: MarketPhase; base_stage: MarketPhase; base_note: string | null; reasons: string[] } {
  const { limitUp, limitDown, upRate, gate } = input;
  const base_stage = baseStageOf(limitUp);
  const reasons: string[] = [];
  const broadOk = upRate >= PHASE_MIN_UP_RATE;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const hot = () => gate.allPass && broadOk;

  let phase: MarketPhase;
  if (limitUp >= PHASE_MIN_LIMIT_UP.extreme && hot()) {
    phase = "极度高潮期";
  } else if (limitUp >= PHASE_MIN_LIMIT_UP.climax && hot()) {
    phase = "高潮期";
  } else if (limitUp >= PHASE_MIN_LIMIT_UP.main && gate.allPass) {
    phase = "主升期";
  } else {
    // 走到这里说明「主升期及以上」被否掉了 —— 记清楚是被谁否掉的
    if (limitUp >= PHASE_MIN_LIMIT_UP.main) {
      if (gate.blockers.length) {
        reasons.push(`涨停 ${limitUp} 家够主升期,但闸门未过:${gate.blockers.join(";")}`);
      } else if (gate.unknown.length) {
        // 🔴 缺数据和「未过」要分开说：一个该去点「重新取数」，一个该认下盘面
        reasons.push(`涨停 ${limitUp} 家够主升期,但闸门没评估完（缺 ${gate.unknown.join(";")}）—— 没数据不算通过`);
      }
    }
    if (upRate >= REPAIR_MIN_UP_RATE && limitUp >= 15 && limitUp >= limitDown) {
      phase = "修复期";
    } else if (limitUp >= 15 && (limitDown >= limitUp || upRate < 0.30)) {
      if (upRate < REPAIR_MIN_UP_RATE) reasons.push(`广度 ${pct(upRate)} 不足修复期的 ${pct(REPAIR_MIN_UP_RATE)}`);
      if (limitDown >= limitUp) reasons.push(`跌停 ${limitDown} 家 ≥ 涨停 ${limitUp} 家`);
      phase = "退潮期";
    } else {
      if (limitUp < 15) reasons.push(`涨停 ${limitUp} 家 < 15,没有可做的活跃度`);
      phase = "冰点期";
    }
  }

  return { phase, base_stage, base_note: baseNoteOf({ base_stage, phase, limitUp, limitDown, upRate }), reasons };
}

/**
 * 「基准口径」与最终阶段不一致时，怎么向人解释。
 *
 * 🔴 三种情形必须分开说，否则会给出相反的暗示：
 *   ① **跌停潮**（跌停 ≥ 50 家且多于涨停）—— 涨停家数还够，但跌停同时成片。
 *      这时候说「情绪本可到主升期，被闸门压下来」是**错的**：情绪本身就很弱，
 *      是「只看涨停家数」这个粗口径失真，不是闸门把它压下去的。
 *      10/30 实例：涨停 47 / 跌停 82 / 广度 15%，旧文案说「本可到主升期」，看着像在给盘面贴金。
 *   ② **闸门压制**（base 比 phase 高，广度/量能/均线没过）—— 「被准入闸门压到 X」才准确。
 *   ③ **闸门抬升**（base 比 phase **低**）—— 两套阈值本来就不一样：
 *      纯涨停口径要 30 家才算主升，带闸门的口径 25 家 + 三门全过就放行。
 *      10/30 之后发现涨停 27 家会输出「情绪读数本可到「修复期」，被准入闸门压到「主升期」」——
 *      闸门是往上"压"的，读起来像 bug。这种情况要说「按家数只算修复期，三闸门全过所以升上去」。
 */
const PHASE_ORDER: readonly MarketPhase[] = ["冰点期", "退潮期", "修复期", "主升期", "高潮期", "极度高潮期"];
const phaseRank = (p: MarketPhase) => PHASE_ORDER.indexOf(p);

function baseNoteOf(i: {
  base_stage: MarketPhase;
  phase: MarketPhase;
  limitUp: number;
  limitDown: number;
  upRate: number;
}): string | null {
  if (i.base_stage === i.phase) return null;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  // ③ 闸门把阶段**抬**上去了：这不是「被压」，不能说被压
  if (phaseRank(i.phase) > phaseRank(i.base_stage)) {
    return `按涨停 ${i.limitUp} 家只算「${i.base_stage}」（纯家数口径要 30 家才算主升）；`
      + `但广度 ${pct(i.upRate)}、三道闸门全过，所以升到「${i.phase}」`;
  }
  if (i.limitDown >= 50 && i.limitDown > i.limitUp) {
    return `只看涨停 ${i.limitUp} 家会读到「${i.base_stage}」；但同日跌停 ${i.limitDown} 家、上涨家数只有 ${pct(i.upRate)}，`
      + `实际是「${i.phase}」—— 这是跌停潮，不是被闸门压下来的`;
  }
  return `情绪读数本可到「${i.base_stage}」，被准入闸门压到「${i.phase}」`;
}

// ─── 加权 ───────────────────────────────────────────────────────────────────────

/**
 * 实际生效权重:null 的维度让权,其余按原始比例归一化。
 * 这样 composite **永远**等于「各分项 × 这里返回的权重」之和 —— 用户自己乘一遍必须对得上。
 *
 * 🔴 事件面走**封顶**分支:它是文本代理指标,只拿 EVENT_WEIGHT_CAP(8%),
 *    而不是名义的 15%;剩下的 92% 按 0.30/0.15/0.15/0.25 的原比例分给其余四项。
 */
export function effectiveWeights(d: DimensionScores): EffectiveWeights {
  const out: EffectiveWeights = { emotion: 0, dragon: 0, risk: 0, earning: 0, event: 0 };
  const present = DIM_KEYS.filter((k) => d[k] != null);
  if (sum0(present) === 0) return out;

  if (d.event != null) {
    const others = present.filter((k) => k !== "event") as Exclude<(typeof DIM_KEYS)[number], "event">[];
    out.event = EVENT_WEIGHT_CAP;
    const base = others.reduce((a, k) => a + MARKET_WEIGHTS[k], 0);
    if (base > 0) {
      for (const k of others) out[k] = (MARKET_WEIGHTS[k] / base) * (1 - EVENT_WEIGHT_CAP);
    } else {
      // 只剩事件面一维:权重全给它,免得 Σ ≠ 1
      out.event = 1;
    }
    return out;
  }

  const sum = sum0(present);
  for (const k of present) out[k] = MARKET_WEIGHTS[k] / sum;
  return out;
}

function sum0(keys: readonly (keyof DimensionScores)[]): number {
  return keys.reduce((a, k) => a + MARKET_WEIGHTS[k], 0);
}

/** 综合分 = Σ(分项 × 生效权重)。唯一入口,不接受任何缩放。 */
export function weightedComposite(d: DimensionScores): number {
  const w = effectiveWeights(d);
  let s = 0;
  for (const k of DIM_KEYS) {
    const v = d[k];
    if (v != null) s += v * w[k];
  }
  return Math.round(s);
}

// ─── 风险等级 ───────────────────────────────────────────────────────────────────

/**
 * 风险等级 —— 由**风险分自己**决定,不再由 composite 反推。
 *
 * 风险分是「越高越安全」,所以 75+ 低风险、55+ 中风险、35+ 高风险、以下极高风险。
 * 再加一条盘面硬约束:跌停 ≥ 50 家或跌家占比 ≥ 60% 时,最少也要算「高风险」;
 * 跌停 ≥ 80 家且跌家占比 ≥ 70% 直接「极高」—— 风险分有 15 分的地板,不能让它替崩盘盘面开脱。
 */
export function riskLevelOf(
  riskScore: number | null,
  opts: { limitDown: number; downRate: number },
): RiskLevel | null {
  if (riskScore === null) return null;
  let level: RiskLevel = riskScore >= 75 ? "low" : riskScore >= 55 ? "medium" : riskScore >= 35 ? "high" : "extreme";
  if (opts.limitDown >= 50 || opts.downRate >= 0.60) {
    if (level === "low" || level === "medium") level = "high";
    if (opts.limitDown >= 80 && opts.downRate >= 0.70) level = "extreme";
  }
  return level;
}

// ─── 仓位上限 ───────────────────────────────────────────────────────────────────

/**
 * 仓位上限 = 分数梯档 ∩ 闸门梯档 ∩ 数据完备性,取小。
 *
 * 🔴 为什么要叠闸门:分数是「盘面现在多强」,闸门是「这个强势有没有被量能和均线确认」。
 *    广度 16% 的一天可以因为跌停家数没进风险公式而拿到 40 分的仓位上限 —— 那就是
 *    「分项算完了,但结论不能用」。闸门失败越多,上限压得越死:
 *    1 门失败 ≤ 40%,2 门 ≤ 20%,3 门全灭 = 0(三条都不配合,不给加仓)。
 * 🔴 完备性只约束「这个结论能用到多重的仓」,不改分数、不改权重、不改阶段。
 */
/**
 * 数据不全时的仓位天花板，与「闸门未评估」共用同一档。
 * 🔴 刻意不另设数值：系统早就认了「不知道 ≠ 通过、最多轻仓试探」这条纪律，
 *    这里只是把同一条纪律覆盖到赚钱效应缺腿，不引入第二套标准。
 */
export const INCOMPLETE_DATA_CAP_PCT = 40;

export function positionCapOf(
  composite: number,
  gate: Pick<GateResult, "blockers"> & { unknown?: string[] },
  opts: { dataIncomplete?: boolean } = {},
): number {
  const ladder = composite >= 75 ? 100 : composite >= 60 ? 70 : composite >= 45 ? 40 : composite >= 30 ? 20 : 0;
  const n = gate.blockers.length;
  const gateCap = n === 0 ? 100 : n === 1 ? 40 : n === 2 ? 20 : 0;
  /**
   * 🔴 有门没评估时不许给满仓，最多「轻仓试探」(40%)。
   *    「不知道量能与均线过不过」和「它俩都过了」不是一回事：前者给满仓等于拿取数故障当利好。
   *    但也不按失败算 —— 数据源抖一下就把仓位打到 0，同样是不讲道理。
   */
  const unknownCap = (gate.unknown?.length ?? 0) === 0 ? 100 : INCOMPLETE_DATA_CAP_PCT;
  /**
   * 🔴 赚钱效应缺腿时（板块共振 / 板块资金流没取到），分数按中性补位看着正常，
   *    但那不等于「数据齐的好日子」：实测双腿全缺 composite 78 → 旧逻辑给 100% 上限，
   *    等于绕过了上面那条 unknownCap 防线。补同一档天花板，别拿取数故障当利好。
   */
  const completenessCap = opts.dataIncomplete ? INCOMPLETE_DATA_CAP_PCT : 100;
  return Math.min(ladder, gateCap, unknownCap, completenessCap);
}

// ─── 五维打分 ───────────────────────────────────────────────────────────────────

/**
 * 五维打分 + 定阶段(纯函数)。
 * 调用方负责把端点数据规整成这里要的最简输入:
 *  - 家数已是数字(缺失视作 0),且先自行判过「一家都没有 = 没取到数」
 *  - resonanceRates 已是小数数组(0..1);**空数组 = 没有展示行**,配合 resonanceShare 是否为 null 判断这条腿算不算有数据
 *  - inflowRate 是 0..1 的净流入板块占比;**null = 资金流没取到**
 *  - 赚钱效应的三条腿缺哪条就**按中性补位**(不比中性好、也不比已看到的部分好),不许当 0 分
 *  - promotionRate 是 0..1 的连板晋级率(来自 cn_shortline_board_ladder.ladder_tier_promotion_rate)
 *  - ladderHighest 是最近一级连板高度(板数,来自 ladder_highest)
 *  - gateData 缺省 = 只有广度门有数据(量能门 / 均线门记 unknown)
 *  - eventScore 缺省 / null = 事件面未接入(该维度权重让渡)
 */
export function scoreMarket(input: {
  limit_up: number;
  limit_down: number;
  up: number;
  down: number;
  flat: number;
  /** 板块共振率(已是小数 0..1,null 已由调用方处理) —— 无 aggregate 时的兜底 */
  resonanceRates: number[];
  /**
   * 全市场板块共振的**聚合**读数(0..1)，优先于 resonanceRates 的均值。
   * 🔴 为什么要单独给:调用方展示用的是「共振率最高的 10 个板块」，那 10 个的均值
   *    结构性地接近 1（挑的就是最高的），拿它当赚钱效应的输入会让该维度永远偏高。
   */
  resonanceShare?: number | null;
  /** 净流入板块占比 0..1;null = 资金流没取到(该条腿的权重让渡,不按 0 分算) */
  inflowRate: number | null;
  /** 最近一级连板晋级率 0..1(来自 cn_shortline_board_ladder),无则 null */
  promotionRate: number | null;
  /** 连板最高高度(板),无则 null */
  ladderHighest: number | null;
  /** 闸门输入;缺省/null = 量能门与均线门无数据 */
  gateData?: MarketGateInput | null;
  /** 事件面分;缺省/null = 未接入 */
  eventScore?: number | null;
}): MarketDimensions {
  const {
    limit_up: limitUp,
    limit_down: limitDown,
    up,
    down,
    flat,
    resonanceRates,
    promotionRate,
    ladderHighest,
  } = input;
  const total = up + down + flat;
  const upRate = total > 0 ? up / total : 0;
  const downRate = total > 0 ? down / total : 0;

  // 情绪:涨停家数 + 涨跌停比(连续,无阈值跳变)
  const { score: emotionScore, base_stage } = emotionReading(limitUp, limitDown);

  // 风险:跌停家数 + 跌家占比(高=危险 → 这里 riskScore 高=风险低)
  // 🔴 下限 15:不允许单一维度崩盘时 risk=0 把 15% 的权重整个吃掉,却仍给主升期标签
  const riskScore = clamp(100 - (limitDown * 2 + downRate * 100), 15, 100);

  // 赚钱效应:涨家占比 + 板块共振 + 板块资金净流入率(三条腿,不再只看广度)
  //   🔴 只看广度会有系统性偏差:指数被权重股拉着跌、小票普涨的日子,广度虚高但赚不到钱
  //   🔴 共振那一条腿优先用全市场聚合(resonanceShare),没有才退回展示行的均值 ——
  //      展示行是「共振最高的 10 个板块」,均值天然接近 1,拿它当输入等于给这一维送分
  const avgRes = resonanceRates.length ? resonanceRates.reduce((a, c) => a + c, 0) / resonanceRates.length : 0;
  const resLeg = input.resonanceShare != null ? clamp(input.resonanceShare, 0, 1) : avgRes;
  /**
   * 🔴 缺一条腿时按「中性补位」,不许当 0 分,也不许当成有利。
   *
   * 旧的写法是「共振没取到 → resLeg = 0、资金流没取到 → inflowRate = 0」,
   * 于是数据源抽风那天,赚钱效应凭空少 25 / 20 分(综合分最多压低约 11 分),
   * 表现成「今天很差」—— 其实只是「今天没看见」。缺数据与真的差必须分开。
   *
   * 但**单纯把权重全让给剩下的腿**也不行,实测过:三条腿只剩广度时,
   * 广度 87% 的假想日算出 87 分,比数据齐全的好日子(共振 60% / 净流入 50% → 73)还高 ——
   * 那就成了「取数故障当利好」,和本文件闸门那条「不知道不等于过了」是同一个错误。
   *
   * 所以缺的那条腿按 `min(中性先验, 已看到部分的加权均值)` 补:
   *  - 不比中性更好(不把故障日算成好日子);
   *  - 也不比已经看到的部分更好(盘面明显很差时,缺的腿不许把分数拉回来);
   *  - 补出来的分永远 ≥ 旧写法的「按 0 算」,所以不会比现在更苛刻。
   *
   * 判据(哪些算「有数据」):
   *  - 共振:给了聚合占比,或者有展示行。`resonanceShare` 显式给 0 是**真的 0**。
   *  - 资金流:`inflowRate === null` 才是没数据;0 是「有数据但一个板块都没净流入」。
   *  - 广度:永远有(调用方已先判过「一家都没有 = 没取到数」,那种情况整个维度算不出来)。
   */
  const RES_NEUTRAL = 0.2;
  const FLOW_NEUTRAL = 0.5;
  const hasRes = input.resonanceShare != null || resonanceRates.length > 0;
  const hasInflow = input.inflowRate != null;
  const inflowLeg = input.inflowRate ?? 0;
  const legs = [
    { w: 55, v: upRate, neutral: upRate, known: true },
    // 共振率口径 = 共振率 ≥60% 的板块占比,实测长期在 0.08~0.30(10/29 0.20、10/30 0.10),取 0.2
    { w: 25, v: resLeg, neutral: RES_NEUTRAL, known: hasRes },
    // 净流入板块占比,实测 10/30 为 26/48 = 54%,取 0.5
    { w: 20, v: inflowLeg, neutral: FLOW_NEUTRAL, known: hasInflow },
  ];
  const seen = legs.filter((l) => l.known);
  const seenW = seen.reduce((a, l) => a + l.w, 0);
  const seenAvg = seenW > 0 ? seen.reduce((a, l) => a + l.w * l.v, 0) / seenW : 0;
  const earningScore = clamp(
    legs.reduce((a, l) => a + l.w * (l.known ? l.v : Math.min(l.neutral, seenAvg)), 0),
    0,
    100,
  );

  // 龙头 / 板块强度:连板高度 + 晋级率(涨停家数只反映广度,不反映龙头质量)
  let dragonScore: number;
  const hasLadder = ladderHighest != null && ladderHighest >= 3;
  if (hasLadder) {
    const base = Math.min(ladderHighest * 10, 60);
    const promo = (promotionRate ?? 0) * 30;
    dragonScore = clamp(base + promo, 0, 100);
    // 🔴 退潮特征下给上限:广度 < 35% 且 跌停 ≥ 涨停 时,5 板独苗是「资金抱团一只票」,
    //    不是板块效应。不给上限的话,分化盘会靠单只妖股把龙头维度顶到 65~100。
    if (upRate < 0.35 && limitDown >= limitUp) dragonScore = Math.min(dragonScore, 55);
  } else if (limitUp >= 30) {
    dragonScore = clamp(limitUp * 1.2, 0, 100);
  } else {
    dragonScore = clamp(limitUp * 1.5, 0, 100);
  }

  // 事件面:没有数据源就是 null(权重让渡),不再拿常数 50 顶 15% 的权重
  const eventScore = input.eventScore ?? null;

  const gate = evaluateMarketGate(limitUp, upRate, input.gateData ?? null);
  const { phase, reasons, base_note } = resolvePhase({ limitUp, limitDown, upRate, gate });

  const scores: DimensionScores = {
    emotion: Math.round(emotionScore),
    dragon: Math.round(dragonScore),
    risk: Math.round(riskScore),
    earning: Math.round(earningScore),
    event: eventScore === null ? null : Math.round(eventScore),
  };

  return {
    emotion: scores.emotion!,
    dragon: scores.dragon!,
    risk: scores.risk!,
    earning: scores.earning!,
    event: scores.event,
    composite: weightedComposite(scores),
    stage: phase,
    base_stage,
    base_note,
    weights: effectiveWeights(scores),
    gate,
    phase_reasons: reasons,
  };
}
