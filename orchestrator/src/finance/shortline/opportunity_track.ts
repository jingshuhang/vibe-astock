/**
 * 机会清单收盘落台账(P0):把「超短线机会发现」的清单变成可对账的历史。
 *
 * 三步闭环:
 *   1. 快照(18:45 任务):当日收盘后的机会清单整组写进台账 `opportunity_track`,
 *      连同归档字段 —— 原始置信度、类别(首板/连板/高标)、情绪环境、封板分档、主线行业、市场相位。
 *   2. 对账(同一任务,次日起):每只补「次日涨跌 % / 次日再板 / 对账日」,用 `cn_shortline_settled`
 *      的逐只明细(和涨停样本同一份数据、同一套口径)。
 *   3. 汇总(视图):按『类别 × 环境』聚合本页实测胜率,前端把它和 patternPrior 的先验表**并排**显示。
 *
 * 🔴 先验数值(PRIOR/BASELINE/修正幅度)只存前端 `patternPrior.ts`,此处一个都不复制 ——
 *    两处各存一份数字迟早对不上。这里的 categoryOf / regimeOf / 封板分档只是**同口径镜像**,
 *    用于给记录归档,让台账的行和前端 rescore 的行落在同一个格子里。
 * 🔴 实测口径复用 samples.ts 的 `stats`:胜率 = 收红占比(平盘不算赢);再板率只在判得了的子集上算;
 *    无样本给 null 不伪装 0。展示必须带 `SAMPLE_CAVEAT`(市场现象统计,不是策略回测)。
 * 🔴 快照幂等:同日重跑整组替换,code 相同的记录复用 id,正文没变时连 updated_at 都不动
 *    (ledger.replaceRecords 的语义);已对账的行保留结算结果,重跑快照抹不掉。
 * 🔴 对账只认收盘定稿:`cn_shortline_settled` 的 `extra.settled !== true` 一律不写。
 */
import type { LedgerRecord } from "../../ledger.ts";
import { localClock, type JobContext, type JobResult } from "../../notify.ts";
import { fetchEndpoint, ledgerList, ledgerReplace, type FetchResult, type ServiceContext } from "../../service.ts";
import { klineBars } from "../abnormal.ts";
import type { MarketPhase } from "../market_score.ts";
import { SCHEDULE_TZ, failedNote } from "../schedule.ts";
import { consistencyFor, retentionFloor } from "./history.ts";
import { shortlineOpportunitiesAct, type ShortlineOpportunityResult } from "./opportunities.ts";
import { marketStateAct } from "../market_state.ts";
import { REGIMES, SAMPLE_CAVEAT, rowsOf, stats, type Regime, type Stats } from "./samples.ts";

export const TRACK_KIND = "opportunity_track";
/** 对账用的交易日序列来自上证A股指数日 K,和 verification 同一条通道 */
const KLINE_MAX_AGE_MS = 5 * 60 * 1000;
/** 展示口径:本页实测是「清单快照的次日表现」,和样本统计的「昨收→今收」同一含义 */
export const TRACK_CAVEAT = SAMPLE_CAVEAT
  + "本页实测 = 当日收盘快照的机会清单在**次日**的涨跌幅(前收→今收,和涨停样本同一份数据源);没有成交模拟,不构成策略期望。";

const CATEGORIES = ["首板", "连板", "高标"] as const;
export type PatternCategory = (typeof CATEGORIES)[number];

// ─── 归档口径(镜像前端 patternPrior.ts;先验数值不在这里) ──────────────────────

/** 今日连板数 → 明天落进 samples 的哪个类别(与前端 categoryOf 同口径) */
export function categoryOf(boards: number): PatternCategory {
  return boards <= 1 ? "首板" : boards === 2 ? "连板" : "高标";
}

/**
 * MarketPhase → samples 情绪三档(与前端 regimeOf 同口径,**假设映射,未回测**):
 * 冰点是谷底 → 弱;退潮/修复是从强往弱的过渡段 → 中;主升/高潮/极度高潮 → 强。
 */
export function regimeOf(phase: MarketPhase | null | undefined): Regime {
  if (!phase) return "环境未覆盖";
  if (phase === "冰点期") return "情绪弱";
  if (phase === "退潮期" || phase === "修复期") return "情绪中";
  return "情绪强";
}

/** HH:MM → 分钟数;解析失败 null */
function sealMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

/** 首板封板时间分档名(上界与前端 sealBucket / samples SEAL_BUCKETS 一致);非首板或缺失给 "" */
export function sealBucketName(seal_time: string | null | undefined, category: PatternCategory): string {
  if (category !== "首板") return "";
  const min = sealMinutes(seal_time);
  if (min === null) return "封板时间缺失";
  if (min <= 9 * 60 + 35) return "开盘秒板";
  if (min <= 10 * 60) return "9:35-10:00";
  if (min <= 11 * 60) return "10:00-11:00";
  if (min <= 14 * 60) return "11:00-14:00";
  return "14:00后";
}

// ─── 可注入的依赖(测试用;默认走真实现) ────────────────────────────────────────

export interface TrackDeps {
  /** 当日机会清单(默认 shortlineOpportunitiesAct) */
  opportunities?: (ctx: ServiceContext, signal: AbortSignal) => Promise<ShortlineOpportunityResult>;
  /** 市场相位(默认 marketStateAct;取不到时归「环境未覆盖」) */
  marketSignal?: (ctx: ServiceContext, signal: AbortSignal) => Promise<{ phase: MarketPhase | null }>;
  /** 取数端点(默认 fetchEndpoint) */
  fetchSettled?: (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope" | "out_dir">>;
}

// ─── 1. 快照 ───────────────────────────────────────────────────────────────────

export interface SnapshotOutcome { date: string; count: number; written: boolean; note: string }

/**
 * 把 `day` 的机会清单整组写进台账。清单一只都不给时不落盘(可能是取数失败,
 * 用空组替换会把当天早些时候的快照抹掉)——保留已有记录并说明原因。
 */
export async function snapshotDay(
  ctx: ServiceContext, day: string, signal: AbortSignal, deps: TrackDeps = {},
): Promise<SnapshotOutcome> {
  const list = await (deps.opportunities ?? ((c, s) => shortlineOpportunitiesAct(c, {}, s)))(ctx, signal);
  const date = list.date || day;
  if (!list.opportunities.length) {
    return {
      date, count: 0, written: false,
      note: list.limit_up_count > 0
        ? `${date} 清单是空的(涨停 ${list.limit_up_count} 只但没有匹配到模式),保留已有快照`
        : `${date} 机会清单没取到(${list.notes.join(";") || "没数据"}),保留已有快照`,
    };
  }

  // 市场相位只用于归档(算不出就「环境未覆盖」),取不到不该让快照失败
  let phase: MarketPhase | null = null;
  try {
    phase = (await (deps.marketSignal ?? ((c, s) => marketStateAct(c, {}, s)))(ctx, signal)).phase;
  } catch { phase = null; }
  const regime = regimeOf(phase);
  const main = new Set(list.main_sectors ?? []);

  const existing = (ledgerList(ctx, TRACK_KIND)[TRACK_KIND] ?? []).filter((r) => r.date === date);
  const byCode = new Map(existing.map((r) => [String(r.code), r]));
  const records = list.opportunities.map((o): Record<string, unknown> => {
    const category = categoryOf(o.boards);
    const prev = byCode.get(o.code);
    const body: Record<string, unknown> = {
      date, code: o.code, name: o.name, boards: o.boards, sector: o.sector ?? "",
      seal_time: o.seal_time ?? "", pattern_type: o.pattern?.type ?? "",
      // 原始置信度(opportunities 自带的模式分),不是前端 rescore 后的值
      pattern_confidence: Math.round(o.pattern?.confidence ?? 0),
      category, regime, seal_bucket: sealBucketName(o.seal_time, category),
      in_main_sector: category === "首板" && !!o.sector && main.has(o.sector),
      market_phase: phase ?? "",
      settled: false,
    };
    // 已对账的行保留结算结果:同日重跑快照不能把对账结果抹掉
    if (prev?.settled === true) {
      body.settled = true;
      if (prev.next_ret !== undefined) body.next_ret = prev.next_ret;
      if (prev.next_limit_up !== undefined) body.next_limit_up = prev.next_limit_up;
      if (prev.settled_date !== undefined) body.settled_date = prev.settled_date;
    }
    return prev ? { id: prev.id, ...body } : body;
  });
  ledgerReplace(ctx, { kind: TRACK_KIND, match: (r) => r.date === date, records });
  return { date, count: records.length, written: true, note: `${date} 快照 ${records.length} 只(${regime}${phase ? ` / ${phase}` : ""})` };
}

// ─── 2. 对账 ───────────────────────────────────────────────────────────────────

export interface SettleOutcome { settled: number; dates: string[]; gaps: string[] }

/**
 * 未对账的每个快照日:用上证A股指数日 K 列出它的次一交易日,那天收盘定稿后逐只补结算。
 * 一只都不在次日名单里(可能停牌)的保持未对账并说明,不猜结果。
 */
export async function settlePending(
  ctx: ServiceContext, now: Date, signal: AbortSignal, deps: TrackDeps = {},
): Promise<SettleOutcome> {
  const all = ledgerList(ctx, TRACK_KIND)[TRACK_KIND] ?? [];
  const gaps: string[] = [];
  const pendingDates = [...new Set(all.filter((r) => r.settled !== true).map((r) => String(r.date)))].sort();
  if (!pendingDates.length) return { settled: 0, dates: [], gaps };
  const today = localClock(now, SCHEDULE_TZ).day;
  const oldest = retentionFloor(now);
  const fetcher = deps.fetchSettled ?? fetchEndpoint;

  let bars: string[] = [];
  try {
    const k = await fetcher(ctx, { endpoint: "tx_kline", symbol: "sh000002", args: { count: 100 }, consistency: { mode: "prefer_cache", max_age_ms: KLINE_MAX_AGE_MS }, signal });
    bars = klineBars(ctx, k.envelope, k.out_dir).map((b) => b.date);
  } catch (e) {
    if (signal.aborted) throw e;
    return { settled: 0, dates: [], gaps: ["上证A股指数日 K 没取到,列不出交易日,先不对账"] };
  }

  let settled = 0;
  const dates: string[] = [];
  for (const d of pendingDates) {
    const next = bars.find((x) => x > d);
    if (!next) {
      // 日 K 里还没有 d 之后的日子:要么还没到,要么日 K 只到昨天 —— 只对「d 早于今天」的说明
      if (d < today) gaps.push(`${d} 的次一交易日列不出来(日 K 只到 ${bars.at(-1) ?? "空"}),先不对账`);
      continue;
    }
    if (next > today) continue; // 对账日还没来
    try {
      const r = await fetcher(ctx, { endpoint: "cn_shortline_settled", args: { date: next }, consistency: consistencyFor(next, oldest, false), signal });
      const env = r.envelope as { status?: string; extra?: { settled?: unknown } };
      if (env?.status === "failed") { gaps.push(`${d} 的次日明细没取到(${failedNote(r.envelope) || "没取到"}),先不对账`); continue; }
      if (env?.extra?.settled !== true) { gaps.push(`${next} 还没收盘定稿,${d} 先不对账`); continue; }
      const byCode = new Map(rowsOf(r.envelope).map((x) => [x.code, x]));
      const group = all.filter((x) => x.date === d);
      let n = 0;
      const records = group.map((rec): Record<string, unknown> => {
        const hit = byCode.get(String(rec.code));
        if (rec.settled === true || !hit) return rec; // 没变的原样交回(updated_at 不动)
        n++;
        const body: Record<string, unknown> = { ...rec };
        delete body.kind; delete body.created_at; delete body.updated_at; delete body.id;
        body.settled = true;
        body.next_ret = hit.ret;
        body.settled_date = next;
        if (hit.limit_up !== null) body.next_limit_up = hit.limit_up; // 判不了就不写,不进再板率分母
        else delete body.next_limit_up;
        return { id: rec.id, ...body };
      });
      const missingCodes = group.filter((x) => x.settled !== true && !byCode.has(String(x.code))).map((x) => String(x.code));
      if (missingCodes.length) {
        gaps.push(`${d} 有 ${missingCodes.length} 只不在 ${next} 的涨停池明细里(可能停牌),保持未对账:${missingCodes.slice(0, 5).join("、")}${missingCodes.length > 5 ? " 等" : ""}`);
      }
      if (n) { ledgerReplace(ctx, { kind: TRACK_KIND, match: (x) => x.date === d, records }); settled += n; dates.push(d); }
    } catch (e) {
      if (signal.aborted) throw e;
      gaps.push(`${d} 对账失败(${e instanceof Error ? e.message.slice(0, 60) : "没取到"})`);
    }
  }
  return { settled, dates, gaps };
}

// ─── 3. 汇总(类别 × 环境) ─────────────────────────────────────────────────────

export interface TrackCell extends Stats { category: PatternCategory; regime: Regime }

/**
 * 已对账的记录按『类别 × 环境』聚合。12 个格子全给(样本 0 的各项为 null)——
 * 前端拿它和 PRIOR 的 12 个格子一一对齐并排,缺格子就得在前端补空行。
 * 统计口径 = samples.stats:胜率平盘不算赢,再板率判不了不进分母。
 */
export function trackSummary(records: LedgerRecord[]): TrackCell[] {
  const settled = records.filter((r) => r.settled === true && typeof r.next_ret === "number");
  const cells: TrackCell[] = [];
  for (const category of CATEGORIES) {
    for (const regime of REGIMES) {
      const rows = settled
        .filter((r) => r.category === category && r.regime === regime)
        .map((r) => ({
          code: String(r.code), name: String(r.name ?? ""), ret: Number(r.next_ret),
          prev_boards: Number(r.boards ?? 0), seal_time: String(r.seal_time ?? ""), sector: String(r.sector ?? ""),
          limit_up: typeof r.next_limit_up === "boolean" ? r.next_limit_up : null,
        }));
      cells.push({ category, regime, ...stats(rows) });
    }
  }
  return cells;
}

// ─── 视图 ─────────────────────────────────────────────────────────────────────

export interface PendingRow { date: string; code: string; name: string; category: PatternCategory; regime: Regime }

export interface OpportunityTrackResult {
  /** 台账里还没有任何快照时 false(不是故障,是还没跑过第一次收盘快照) */
  available: boolean;
  date: string | null;
  /** 有快照的交易日数 */
  snapshot_days: number;
  total: number;
  settled_count: number;
  pending_count: number;
  /** 12 个格子(类别 × 环境)的本页实测;前端与 patternPrior 先验并排 */
  cells: TrackCell[];
  /** 还没对账的行(最多 20 条,按日期升序) */
  pending_rows: PendingRow[];
  sample_caveat: string;
  generated_at: string;
}

/** 只读视图:快照与对账由 18:45 的定时任务写,这里不写盘 */
export async function opportunityTrackView(
  ctx: ServiceContext, _query: Record<string, string>, _signal: AbortSignal, now = new Date(),
): Promise<OpportunityTrackResult> {
  const records = ledgerList(ctx, TRACK_KIND)[TRACK_KIND] ?? [];
  const days = [...new Set(records.map((r) => String(r.date)))].sort();
  const settledCount = records.filter((r) => r.settled === true).length;
  const pending: PendingRow[] = records
    .filter((r) => r.settled !== true)
    .sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0))
    .slice(0, 20)
    .map((r) => ({ date: String(r.date), code: String(r.code), name: String(r.name ?? ""), category: (r.category ?? "首板") as PatternCategory, regime: (r.regime ?? "环境未覆盖") as Regime }));
  return {
    available: records.length > 0,
    date: days.at(-1) ?? null,
    snapshot_days: days.length,
    total: records.length,
    settled_count: settledCount,
    pending_count: records.length - settledCount,
    cells: trackSummary(records),
    pending_rows: pending,
    sample_caveat: TRACK_CAVEAT,
    generated_at: now.toISOString(),
  };
}

// ─── 定时任务(18:45:先快照今天,再对账所有到期的) ──────────────────────────────

export async function opportunityTrackJob(j: JobContext, deps: TrackDeps = {}): Promise<JobResult> {
  const snap = await snapshotDay(j.ctx, j.day, j.signal, deps);
  const st = await settlePending(j.ctx, j.now, j.signal, deps);
  const parts = [snap.note, st.settled ? `对账 ${st.settled} 只(${st.dates.join("、")})` : "没有可对账的"];
  if (st.gaps.length) parts.push(st.gaps.join(";"));
  return { messages: [], note: `机会清单台账:${parts.join(";")}` };
}
