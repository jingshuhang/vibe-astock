/**
 * 超短线机会发现 · **模式先验**（纯查表，不过模型）。
 *
 * 为什么要有这个文件：
 *   `opportunities.ts` 原本把置信度写死（65/50/70/75/68/60），与环境无关 —— 同一个「首板爆发」
 *   主升期是机会、退潮期是接盘，却给一样的分。这个文件把置信度换成**从本地实证统计按
 *   「环境 × 模式」查表**得到的历史胜率，再叠加封板时间 / 板块共振两个修正因子。
 *
 * 🔴 数据从哪来（provenance）：
 *   下面 `PRIOR` 表的每个数字都来自 `/view/shortline_samples?date=2026-10-30&days=90`
 *   —— 本地 18 个交易日（2026-09-30 ~ 10-30）的市场现象统计。
 *   口径：样本 = 前一天收盘还封住的票（事后名单），含一字板买不进的、没排除排队买不到的；
 *   收益 = 前收→今收等权，无滑点。**是市场现象统计，不是策略回测，更不是打板收益。**
 *   真去打板结果只会更差 —— 界面和给 AI 的文字都必须带着这层口径。
 *
 * 🔴 环境对齐（防前视）：
 *   samples 的 regime 用**入场日**（前一交易日）的情绪。机会发现在 D 日看盘、判断 D+1 是否接力，
 *   所以用 **D 日情绪**查表预测 D+1 表现 —— 正好对应 samples 的「入场日」口径。
 *   D 日情绪这里取市场状态页的 `phase`（不另算一套）。⚠️ 但 samples 的 regime 是「情绪分三等分」
 *   连续量切出来的，phase 是另一套离散标签，两者不是同一口径 —— `regimeOf()` 的映射是**假设，未回测**。
 *
 * 🔴 置信度语义变了：
 *   confidence = 历史胜率 × 100 + 修正因子。所以 70 不再是「拍的高分」，而是
 *   「这类票在当前环境历史上有约 70% 概率次日收红」。胜率天然集中在 40~75，
 *   意味着「支持」是少数、多数落在「观察」—— 这是对的：超短线本来就是薄利，环境压过一切。
 *
 * ⚠️ 三个修正因子的幅度（封板分档、板块共振）来自样本均值/胜率差，**未回测**；
 *    regime 映射、封板分档的 regime 无关性都是简化，先跑影子模式对照再定稿。
 */
import type { MarketPhase } from "@/lib/marketState";
import type { StockOpportunity } from "@/lib/shortlineOpportunities";

// ─── 环境：phase → samples regime（⚠️ 假设映射，未回测） ──────────────────────
export type Regime = "情绪强" | "情绪中" | "情绪弱" | "环境未覆盖";

/**
 * 市场状态页的离散 phase → samples 的情绪三档。
 * 依据：samples 用「涨停家数×(1+板高)×(1-炸板率)」三等分；phase 是同一情绪轴上的离散标签。
 * 退潮/修复是「从强往弱走」的过渡段 → 落在中档（也正是样本里最差的一档）；冰点是谷底 → 弱档。
 * ⚠️ 这条映射是设计假设，未经历史回测；换窗口后要复核。
 */
export function regimeOf(phase: MarketPhase | null | undefined): Regime {
  if (!phase) return "环境未覆盖";
  if (phase === "冰点期") return "情绪弱";
  if (phase === "退潮期" || phase === "修复期") return "情绪中";
  return "情绪强"; // 主升期 / 高潮期 / 极度高潮期
}

// ─── 先验表：环境 × 模式类 → 历史表现 ─────────────────────────────────────────
/** 一个 cell = 该打法在该环境下，次日（前收→今收）的历史统计 */
export interface PriorCell {
  /** 次日收红的比例（方向胜率），×100 即置信度 */
  win: number;
  /** 次日平均收益 % */
  avg: number;
  /** 次日收益中位 % */
  median: number;
  /** 次日最差一只 % */
  worst: number;
  /** 样本数 */
  n: number;
}

/**
 * 今日的连板数决定它**明天**会落进 samples 的哪个类别（关键映射：
 * 今日首板 → 明天就是「昨日首板」；今日 2 板 → 明天「昨日 2 板」…）。
 */
export type PatternCategory = "首板" | "连板" | "高标";

export function categoryOf(boards: number): PatternCategory {
  return boards <= 1 ? "首板" : boards === 2 ? "连板" : "高标";
}

const CELL = (win: number, avg: number, median: number, worst: number, n: number): PriorCell =>
  ({ win, avg, median, worst, n });

/** PRIOR[类][regime] —— 全部取自 samples by_regime（provenance 见文件头） */
export const PRIOR: Record<PatternCategory, Record<Regime, PriorCell>> = {
  首板: {
    // 打法「首板打板」
    情绪强: CELL(0.548, 1.19, 0.57, -13.97, 281),
    情绪中: CELL(0.364, -0.62, -2.27, -14.36, 228),
    情绪弱: CELL(0.624, 2.28, 2.04, -14.13, 178),
    环境未覆盖: CELL(0.468, 0.6, -1.02, -10.0, 47),
  },
  连板: {
    // 打法「连板接力」
    情绪强: CELL(0.629, 3.18, 3.57, -10.02, 70),
    情绪中: CELL(0.464, 0.44, -1.86, -10.04, 56),
    情绪弱: CELL(0.479, 0.08, -1.19, -10.13, 71),
    环境未覆盖: CELL(0.6, 4.25, 9.96, -9.98, 10),
  },
  高标: {
    // 打法「高标接力」
    情绪强: CELL(0.731, 4.74, 8.83, -9.99, 26),
    情绪中: CELL(0.667, 3.25, 9.97, -10.02, 24),
    情绪弱: CELL(0.542, 0.72, 0.73, -10.13, 24),
    环境未覆盖: CELL(0.667, 3.33, 9.98, -9.98, 3),
  },
};

/** samples 里「全体涨停」基准线，用来在 evidence 里说明这个 cell 比大盘好还是差 */
export const BASELINE: Record<Regime, PriorCell> = {
  情绪强: CELL(0.564, 1.59, 1.17, -13.97, 351),
  情绪中: CELL(0.384, -0.41, -2.19, -14.36, 284),
  情绪弱: CELL(0.582, 1.65, 1.62, -14.13, 249),
  环境未覆盖: CELL(0.491, 1.24, -0.67, -10.0, 57),
};

// ─── 修正因子① 封板时间分档（首板专属） ──────────────────────────────────────
/**
 * 首板按最后封板时间分档（来自 samples 的 seal_curve，**只统计首板** ——
 * 连板股的封板时间含义不同，混进来会污染结论）。
 * 修正幅度 = 该档胜率 − 首板整体胜率（0.504），×100 取整 —— 数据推的，不是拍的。
 * ⚠️ seal_curve 是全环境池化（没有按 regime 再切），所以这个修正是 regime 无关的简化。
 */
export interface SealBucket {
  bucket: string;
  /** 相对首板整体的胜率修正（百分点，已 ×100） */
  adj: number;
  /** 该档的平均收益，用于 evidence */
  avg: number;
}
const SEAL_UNKNOWN: SealBucket = { bucket: "封板时间缺失", adj: 0, avg: 0 };

/** HH:MM → 分钟数；解析失败 null */
function sealMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

/**
 * 首板封板时间分档。分档上界与 samples 的 SEAL_BUCKETS 一致（开盘秒板 ≤09:35 …）。
 * 只有首板调用；连板/高标返回 null（不修）。
 */
export function sealBucket(seal_time: string | null | undefined, category: PatternCategory): SealBucket | null {
  if (category !== "首板") return null;
  const min = sealMinutes(seal_time);
  if (min === null) return SEAL_UNKNOWN;
  if (min <= 9 * 60 + 35) return { bucket: "开盘秒板", adj: 6, avg: 2.15 }; // 胜率 .568 − .504 = +6.4
  if (min <= 10 * 60) return { bucket: "9:35-10:00", adj: 6, avg: 1.51 }; // 胜率 .562 − .504 = +5.8
  if (min <= 11 * 60) return { bucket: "10:00-11:00", adj: -9, avg: -0.28 }; // 胜率 .417 − .504 = −8.7 ← 陷阱档
  if (min <= 14 * 60) return { bucket: "11:00-14:00", adj: 0, avg: 0.97 }; // 胜率 .500 − .504 = −0.4
  return { bucket: "14:00后", adj: 2, avg: 0.66 }; // 胜率 .521 − .504 = +1.7
}

// ─── 修正因子② 板块共振（首板专属） ─────────────────────────────────────────
/**
 * 首板·涨停数前二行业的历史表现明显优于泛首板（样本 +2.00% vs +0.85%，胜率 .569 vs .504）。
 * 修正幅度 = .569 − .504 = +6.5 ≈ +7。⚠️ 同样只对首板；连板/高标样本里没有对应分档。
 */
export const SECTOR_RESONANCE_ADJ = 7;

// ─── 主函数：给一只机会算先验置信度 + 证据 ───────────────────────────────────
export interface RescoreResult {
  /** 0~100 置信度 = 历史胜率×100 + 修正 */
  confidence: number;
  /** 落进 samples 的哪个类别（今日连板数 → 明天的类别） */
  category: PatternCategory;
  regime: Regime;
  /** 证据一句话：类别·环境的历史表现 + 修正来源，能对着页面复核 */
  evidence: string;
  /** 负收益侧提示：非正收益占比 + 最差一只，别只看胜率 */
  risk_note: string;
  /** 该环境×类别的历史平均收益 %（验证流用它判「亏钱效应」→ 回避） */
  avg: number;
  /** 封板分档名（首板才有） */
  seal_bucket: string | null;
  /** 是否落在当日涨停数前二行业 */
  in_main_sector: boolean;
  /** 基准对比：比「全体涨停」好还是差（百分点） */
  edge_pp: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

/**
 * 给一只机会算先验置信度。纯函数，同输入必同输出。
 * ctx 只喂它需要的环境读数（phase + 当日前二行业），不碰别的。
 */
export function rescoreOpportunity(
  opp: StockOpportunity,
  ctx: { phase: MarketPhase | null | undefined; mainSectors: readonly string[] },
): RescoreResult {
  const regime = regimeOf(ctx.phase);
  const category = categoryOf(opp.boards);
  const cell = PRIOR[category][regime];
  const base = cell.win * 100;

  // 修正① 封板时间（仅首板）
  const seal = sealBucket(opp.seal_time, category);
  const sealAdj = seal?.adj ?? 0;

  // 修正② 板块共振（仅首板，且 sector 落在前二行业）
  const inMain = category === "首板" && !!opp.sector && ctx.mainSectors.includes(opp.sector);
  const sectorAdj = inMain ? SECTOR_RESONANCE_ADJ : 0;

  const confidence = Math.round(clamp(base + sealAdj + sectorAdj, 0, 100));

  // ── evidence：类别·环境的历史表现 + 修正来源 ──
  const parts: string[] = [];
  parts.push(`${category}·${regime} 历史胜率 ${pct1(cell.win)}、均值 ${signed(cell.avg)}%（n=${cell.n}）`);
  if (seal) parts.push(`封板 ${seal.bucket}${sealAdj === 0 ? "（中性）" : ` ${sealAdj > 0 ? "+" : ""}${sealAdj}`}`);
  if (inMain) parts.push(`板块共振（前二行业）+${SECTOR_RESONANCE_ADJ}`);
  const edge = (cell.win - BASELINE[regime].win) * 100;
  parts.push(`比大盘${edge >= 0 ? "高" : "低"} ${Math.abs(edge).toFixed(1)}pp`);
  const evidence = parts.join("；");

  // ── risk_note：负收益侧，别只看胜率 ──
  const nonWin = (1 - cell.win) * 100;
  const risk = `非正收益约 ${nonWin.toFixed(0)}%，最差一只 ${signed(cell.worst)}%`;
  const risk_note = cell.median < 0
    ? `${risk}；中位 ${signed(cell.median)}% 为负 —— 这类在${regime}整体是亏钱效应`
    : `${risk}；中位 ${signed(cell.median)}%`;

  return {
    confidence, category, regime, evidence, risk_note, avg: cell.avg,
    seal_bucket: seal?.bucket ?? null,
    in_main_sector: inMain,
    edge_pp: Math.round(edge * 10) / 10,
  };
}
