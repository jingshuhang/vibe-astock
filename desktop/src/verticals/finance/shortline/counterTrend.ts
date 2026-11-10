/**
 * 逆市候选 —— 独立于大盘闸门的第二视图（只加信息，不放宽风控）。
 *
 * 为什么存在（2026-11-10 实机）：验证流在「环境关闭」时把 40 只候选一律判「回避」，
 * 把项目内 24 日样本里真实存在的正期望格子也一起盖掉了 ——
 * `情绪中·高标接力` n=37 / 胜率 67.6% / 均值 +3.74% / 再板率 54.1%，
 * `情绪弱·首板·早封` n=67 / 65.7% / +3.11%。用户要的是「闸门关了也能看到逆市机会」。
 *
 * 🔴 这一栏**不推翻大盘闸门**：验证流顶部仍写「环境关闭，不加」，`counts.回避` 一字不动。
 *    它只把「若只看模式的历史现象统计，哪些格子是正的」并列摆出来，判断权留给人。
 *
 * 🔴 三个硬边界随结果一起返回，界面必须原样带出去：
 *    ① `regimeOf(phase)` 是**未回测的假设映射**；「闸门关闭（量能 / MA20）」与「情绪分档」
 *       不是一个维度，项目内没有按闸门关闭日分组的可信样本（大盘判断台账仅 2 天可配对）。
 *    ② 数字是**市场现象统计**：样本是前一天收盘还封住的票，含一字板买不进、没排除排队买不到；
 *       收益按前收→今收等权、无成交模拟 / 滑点。不是打板收益，不能推真实交易期望。
 *    ③ 不是买卖建议，也不代表系统建议开仓。
 *
 * 判据（按票的板数固定映射，**不按数据好坏挑格子**，避免 cherry-picking）：
 *   boards<=1 → 首板打板；boards===2 → 连板接力；boards>=3 → 高标接力。
 *   与 samples 的 `prev_boards` 口径对齐。
 *   ⚠️ 刻意**不用**首封时间分档：`seal_time` 是首封，samples 的「早封」是最后封板时间，
 *   两者不等价，混用会把「首封早但反复炸板」的票算成早封，系统性高估。
 */
import type { ShortlineOpportunityResult } from "@/lib/shortlineOpportunities";
import type { MarketPhase } from "@/lib/marketState";
import type { SamplesResult, Stats, StrategyResult } from "./viewTypes.ts";
import { regimeOf, type Regime } from "./patternPrior.ts";

/** 严格档：样本够、方向为正、胜率过半。低于任一条件的格子标「待验证」，不进排序 */
export const CT_MIN_SAMPLE = 30;
export const CT_MIN_WIN_RATE = 0.55;

export const CT_STRATEGIES = ["首板打板", "连板接力", "高标接力"] as const;

export const CT_DISCLAIMER =
  "这一栏不采纳大盘闸门，闸门结论仍以验证流为准；数字是市场现象统计，不是打板收益，也不是买卖建议。";

export const CT_REGIME_NOTE =
  "环境档由 phase 映射而来，这条映射未经回测；且「闸门关闭（量能 / 均线）」与「情绪分档」不是同一维度，项目内没有按闸门关闭日分组的可信样本（大盘判断台账仅 2 天可配对）。";

export function strategyFor(boards: number): typeof CT_STRATEGIES[number] {
  if (boards <= 1) return "首板打板";
  if (boards === 2) return "连板接力";
  return "高标接力";
}

export interface CounterTrendRow {
  code: string;
  name: string;
  sector: string;
  boards: number;
  strategy: string;
  regime: Regime;
  /** 该打法 × 环境格子的完整统计：胜率 / 均值 / 中位 / 最差 / 样本数 / 再板率 */
  stats: Stats;
}

export interface CounterTrendRejected {
  strategy: string;
  reason: string;
  stats: Stats | null;
}

export type CounterTrendStatus = "ok" | "no_qualified_cell" | "failed";

export interface CounterTrendResult {
  status: CounterTrendStatus;
  regime: Regime;
  rows: CounterTrendRow[];
  rejected: CounterTrendRejected[];
  sample_days: number | null;
  window: string | null;
  caveat: string;
  gaps: string[];
  disclaimer: string;
  regime_note: string;
}

const KNOWN_PHASES: readonly string[] = ["冰点期", "退潮期", "修复期", "主升期", "高潮期", "极度高潮期"];

/** 未知 / 缺相位不许悄悄落到「情绪强」（regimeOf 的默认分支会），一律降级成「环境未覆盖」 */
export function safeRegime(phase: string | null | undefined): { regime: Regime; gap: string | null } {
  if (!phase || !KNOWN_PHASES.includes(phase)) {
    return { regime: "环境未覆盖", gap: `市场相位没取到或不在已知档位（${phase ?? "空"}），这一栏按「环境未覆盖」读，不猜` };
  }
  return { regime: regimeOf(phase as MarketPhase), gap: null };
}

export function qualifyCell(c: Stats | null | undefined): string | null {
  if (!c) return "样本里没有这个格子";
  if (c.sample < CT_MIN_SAMPLE) return `样本 ${c.sample} < ${CT_MIN_SAMPLE}，待验证`;
  if (c.avg == null || c.win_rate == null) return "均值或胜率没统计出来，待验证";
  if (c.avg <= 0) return `历史均值 ${c.avg.toFixed(2)}% 不为正`;
  if (c.win_rate < CT_MIN_WIN_RATE) return `胜率 ${(c.win_rate * 100).toFixed(1)}% < ${(CT_MIN_WIN_RATE * 100).toFixed(0)}%`;
  return null;
}

function blank(status: CounterTrendStatus, regime: Regime, gaps: string[]): CounterTrendResult {
  return {
    status, regime, rows: [], rejected: [], sample_days: null, window: null,
    caveat: "", gaps, disclaimer: CT_DISCLAIMER, regime_note: CT_REGIME_NOTE,
  };
}

export function buildCounterTrend(input: {
  opps: ShortlineOpportunityResult | null;
  samples: SamplesResult | null;
  phase: string | null | undefined;
  samplesWhy?: string | null;
}): CounterTrendResult {
  const { opps, samples, phase } = input;
  const { regime, gap: regimeGap } = safeRegime(phase);

  if (!samples || !samples.available) {
    return blank("failed", regime, [
      input.samplesWhy ?? "涨停样本这一轮没取到，逆市候选留白，不用旧表或常数顶上",
      "没取到不等于「今天没有逆市机会」",
    ]);
  }
  if (!opps || !opps.opportunities.length) {
    return blank("failed", regime, ["机会清单是空的，逆市候选没有可映射的标的"]);
  }

  const byName = new Map<string, StrategyResult>(samples.strategies.map((s) => [s.name, s]));
  const rows: CounterTrendRow[] = [];
  const rejected: CounterTrendRejected[] = [];
  const gaps: string[] = [];
  if (regimeGap) gaps.push(regimeGap);

  for (const name of CT_STRATEGIES) {
    const st = byName.get(name);
    const cell = st?.by_regime?.[regime] ?? null;
    if (!cell) {
      rejected.push({ strategy: name, reason: "样本里没有这个格子", stats: null });
      continue;
    }
    const why = qualifyCell(cell);
    if (why) {
      rejected.push({ strategy: name, reason: why, stats: cell });
      continue;
    }
    for (const o of opps.opportunities) {
      if (strategyFor(o.boards) !== name) continue;
      rows.push({
        code: o.code, name: o.name, sector: o.sector, boards: o.boards,
        strategy: name, regime, stats: cell,
      });
    }
  }

  // 按格子均值降序；同格子内高标在前，最后按代码稳定排序（不引入第二个主观分）
  rows.sort((a, b) => (b.stats.avg ?? 0) - (a.stats.avg ?? 0)
    || b.boards - a.boards || a.code.localeCompare(b.code));

  if (rejected.length) {
    gaps.push(`${rejected.length} 个格子没过证据门槛：${rejected.map((r) => `${r.strategy}（${r.reason}）`).join("；")}`);
  }
  for (const g of samples.gaps ?? []) gaps.push(`样本缺口：${g}`);

  return {
    status: rows.length ? "ok" : "no_qualified_cell",
    regime,
    rows,
    rejected,
    sample_days: samples.days_used ?? null,
    window: samples.date_from && samples.date_to ? `${samples.date_from} ~ ${samples.date_to}` : null,
    caveat: samples.sample_caveat,
    gaps,
    disclaimer: CT_DISCLAIMER,
    regime_note: CT_REGIME_NOTE,
  };
}

/** 给 AI 的上下文摘要：必须和页面同源，且把免责一起带过去 */
export function counterTrendSummary(c: CounterTrendResult | null): string {
  if (!c) return "逆市候选:还在取数";
  if (c.status === "failed") return `逆市候选:没取到(${c.gaps[0] ?? "样本缺失"})，不是今天没有逆市机会`;
  if (c.status === "no_qualified_cell") return `逆市候选:本轮没有格子通过证据门槛(${c.rejected.map((r) => r.reason).join("；")})`;
  const top = c.rows.slice(0, 5).map((r) =>
    `${r.code} ${r.name}(${r.strategy}·${r.regime} n=${r.stats.sample} 胜率${Math.round((r.stats.win_rate ?? 0) * 100)}% 均值${r.stats.avg?.toFixed(2)}% 最差${r.stats.worst?.toFixed(2)}%)`);
  return `逆市候选(${c.window ?? "窗口未知"} ${c.sample_days ?? "?"}日,环境=${c.regime}):${c.rows.length} 只 | ${top.join("；")} | ${c.disclaimer}`;
}
