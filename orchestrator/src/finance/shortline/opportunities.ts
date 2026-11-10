/**
 * 超短线机会发现 —— 主动扫描层（决策链第二层）
 *
 * 定位：从全市场涨停股中按模式识别候选机会，给出触发清单。**只列客观模式和触发条件，不给买卖建议**。
 *
 * 数据源（2026-11-10 逐份实机核对过信封形状）：
 *   - em_zt_pool              今日涨停池：evidence 逐只，record_key = 代码，字段 pool_*
 *   - cn_shortline_daily      每日情绪读数：broken_rate / limit_up_count（封板率主源）
 *   - em_limit_up_sentiment   三池计数：涨停 / 炸板 / 跌停（封板率备源）
 *   - cn_shortline_ladder     昨日梯队：extra.result.stocks
 *   - cn_shortline_firstboard 首板名单 + 涨停原因：extra.result.stocks
 *
 * 🔴 这整条链曾经**死掉而不报错**（2026-11-10 实机取证）：
 *    ① `em_zt_pool` 的 date 传了 YYYY-MM-DD，端点只认 YYYYMMDD → 取数 failed；
 *    ② 旧版按一组自造的伪字段名（代码 / 名称 / 首封时间 / 标签 / 行业）解析涨停池，
 *       而 mapper (`mappers.py: em_zt_pools`) 实际给的是 `pool_limit_days / pool_change_pct /
 *       pool_price / pool_amount / pool_float_cap / pool_seal_fund / pool_break_times / pool_turnover`，
 *       `record_key` 才是股票代码，名称 / 行业 / 首封时间写在 note 里 —— 一个字段都对不上，`ztRows` 恒空；
 *    ③ 只判 `Promise.allSettled` 的 status，不判 `envelope.status === "failed"` → notes 恒空；
 *    ④ `em_limit_up_sentiment` 给的是三个计数，旧版却读 `seal_rate / broken_rate / limit_up` → 恒 null；
 *    ⑤ ladder / firstboard 的 `extra.result` 是含 `stocks` 的**对象**，旧版当数组读，字段名也全不对。
 *    → 结果：上游 53 只涨停股，页面却恒显示「今天没有匹配到模式的机会」，把取数故障伪装成合法空结果。
 *    本文件按真实契约重写解析，口径与 `market_review.ts` / `schedule.ts` 对齐。
 *
 * 模式识别（按优先级）：首板爆发 / N字反包 / 弱转强 / 分歧转一致 / 龙头接力。
 * 🔴 `classifyPattern()` 的判据与 confidence 数值**保持原样不动** —— 本轮只修数据链，不借机改判据；
 *    硬编码置信度的废弃方案见 `docs/超短线机会发现思路_研究设计_2026-10-30.md`，属另一轮待拍板事项。
 */

import { fetchEndpoint, type ServiceContext } from "../../service.ts";
import { failedNote, rowsOf } from "../schedule.ts";
import { consistencyFor, wantsFresh } from "../snapshot_ttl.ts";

// ─── 类型定义 ───────────────────────────────────────────────────────────────────

/** 这一份清单能不能当「今天的机会」读：failed = 空清单只是没取到，不是没有 */
export type OpportunityStatus = "ok" | "partial" | "failed";

export interface OpportunityPattern {
  /** 模式类型 */
  type: "首板爆发" | "弱转强" | "分歧转一致" | "N字反包" | "龙头接力";
  /** 模式置信度 0-100 */
  confidence: number;
  /** 触发条件描述 */
  trigger: string;
  /** 风险等级 */
  risk: "低" | "中" | "高";
}

export interface StockOpportunity {
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
  /** 所属行业（东财行业，不是题材；解析不出来留空，不编） */
  sector: string;
  /** 当前连板数 */
  boards: number;
  /** 首封时间（HH:MM 格式） */
  seal_time: string | null;
  /** 涨停原因标签（来自首板名单；没取到就是空数组） */
  tags: string[];
  /** 匹配的模式 */
  pattern: OpportunityPattern | null;
  /** 触发价格（涨停价） */
  limit_price: number | null;
  /** 今日涨幅 */
  change_pct: number | null;
  /** 流通市值（亿元） */
  float_cap_yi: number | null;
  /** 成交额（亿元） */
  turnover_yi: number | null;
  /** 封单额（亿元） */
  seal_amount_yi: number | null;
  /** 开板次数 */
  open_count: number;
  /** 备注 */
  note: string;
}

export interface ShortlineOpportunityResult {
  date: string;
  clock: string;
  /** 本轮清单的数据状态：failed 时 opportunities 为空不代表没有机会 */
  status: OpportunityStatus;
  phase: string;
  /** 今日涨停总数 */
  limit_up_count: number;
  /** 炸板率 */
  broken_rate: number | null;
  /** 封板率 */
  seal_rate: number | null;
  /** 识别到的机会清单 */
  opportunities: StockOpportunity[];
  /** 按板块聚类 */
  by_sector: Record<string, StockOpportunity[]>;
  /** 当日涨停家数最多的两个行业(全部涨停股聚类,不是只看匹配到的;行业≠题材) —— 超短线机会发现的「板块共振」判定用 */
  main_sectors: string[];
  /** 本轮缺口 / 降级原因。notes 是它的兼容别名（台账快照读 notes） */
  gaps: string[];
  /** 降级提示（与 gaps 同源，保留给老调用方） */
  notes: string[];
  /** 数据来源 */
  source: string;
}

// ─── 端点响应类型（内部） ─────────────────────────────────────────────────────────

export interface ZtPoolRow {
  code: string;
  name: string;
  sector: string;
  boards?: number;
  limit_up_time?: string;
  limit_price?: number;
  change_pct?: number;
  /** 成交额（元） —— 不是换手率；旧版把 turnover 当成交额，字段选错了 */
  turnover?: number;
  float_market_cap?: number;
  seal_order?: number;
  open_count?: number;
  tags?: string[];
}

interface LadderStock {
  code: string;
  name: string;
  boards: number;
  sector: string;
  limit_up_time?: string;
  open_count?: number;
  tags?: string[];
}

interface FirstBoardRow {
  code: string;
  name: string;
  sector: string;
  limit_up_time?: string;
  seal_order?: number;
  tags?: string[];
  open_count?: number;
  /** 源站编辑归因的涨停原因，非公司确认；没取到是空串 */
  reason?: string;
}

interface Ev { field?: string; value?: unknown; period?: string; note?: string; record_key?: string }
interface Row { key: string; note: string; f: Record<string, Ev> }
interface Env {
  status?: string; evidence?: Ev[]; extra?: Record<string, unknown>;
  missing?: unknown[]; reason?: string; degraded?: string;
}

/** 五路信封 + 各自被 Promise.allSettled 拒掉的原因（拒掉也得写进缺口，不能静默） */
export interface OpportunityEnvelopes {
  ztPool: unknown;
  daily: unknown;
  sentiment: unknown;
  ladder: unknown;
  firstboard: unknown;
  rejected?: Partial<Record<OpportunitySourceKey, string>>;
}
export type OpportunitySourceKey = "ztPool" | "daily" | "sentiment" | "ladder" | "firstboard";

const SOURCE_LABEL: Record<OpportunitySourceKey, string> = {
  ztPool: "涨停池(em_zt_pool)", daily: "每日情绪(cn_shortline_daily)",
  sentiment: "三池计数(em_limit_up_sentiment)", ladder: "昨日梯队(cn_shortline_ladder)",
  firstboard: "首板名单(cn_shortline_firstboard)",
};
const SOURCE_KEYS: OpportunitySourceKey[] = ["ztPool", "daily", "sentiment", "ladder", "firstboard"];

// ─── 真实信封契约的解析 ───────────────────────────────────────────────────────────

/** mapper 的 note_of 固定格式：`{code} {name} {industry} {zt_stat} 首封 {HH:MM:SS}` */
const POOL_NOTE = /^(\d{6})\s+(\S+)\s+(\S+)/;
const POOL_SEAL = /首封\s+(\d{2}:\d{2})(?::\d{2})?/;
const ZT_STAT = /^\d+天\d+板$/;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const vOf = (r: Row, field: string): number | null => num(r.f[field]?.value);
const scalarOf = (env: unknown, field: string): number | null => {
  const e = envOf(env);
  if (!e || !Array.isArray(e.evidence)) return null;
  return num(e.evidence.find((x) => x.field === field && !x.record_key)?.value);
};
const envOf = (v: unknown): Env | null => (v && typeof v === "object" ? v as Env : null);

/**
 * 信封能不能拿来用。三态：
 *  - failed / 没有 evidence / 占位 0 → false（**失败不是「今天 0 只」**）
 *  - partial → true，但调用方要把「未收盘定稿 / 缺字段」写进 gaps
 *  - ok → true
 */
export function envelopeUsable(env: unknown): boolean {
  const e = envOf(env);
  if (!e || e.status === "failed" || !Array.isArray(e.evidence) || e.evidence.length === 0) return false;
  const extra = e.extra ?? {};
  return extra.placeholder_zero !== true;
}

/** HHMMSS（ladder / firstboard）→ HH:MM（本页判据用的格式） */
function hhmm(v: unknown): string | undefined {
  const s = str(v);
  const m = /^(\d{2}):?(\d{2})/.exec(s);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

/**
 * 构造五路取数的 args。🔴 `em_zt_pool` 只认 YYYYMMDD，
 * 其余计算型端点走 `S.iso()`，YYYY-MM-DD / YYYYMMDD 都接受（实机两种都验过）。
 */
export function opportunityDayArgs(day: string): Record<OpportunitySourceKey, Record<string, unknown>> {
  return {
    ztPool: { date: day.replaceAll("-", "") },
    daily: { date: day },
    sentiment: {},
    ladder: { date: day },
    firstboard: { date: day },
  };
}

/** 涨停池 evidence → 逐只行。字段以 `mappers.py: em_zt_pools` 为准 */
export function parseZtPool(env: unknown): { rows: ZtPoolRow[]; gaps: string[] } {
  if (!envelopeUsable(env)) return { rows: [], gaps: [] };
  const parsed: ZtPoolRow[] = [];
  let noBoards = 0, noBreaks = 0;
  for (const r of rowsOf(env) as Row[]) {
    if (!/^\d{6}$/.test(r.key)) continue;
    const m = POOL_NOTE.exec(r.note.trim());
    const boards = vOf(r, "pool_limit_days");
    const breaks = vOf(r, "pool_break_times");
    if (boards === null) noBoards++;
    if (breaks === null) noBreaks++;
    const industry = m?.[3] ?? "";
    parsed.push({
      code: r.key,
      // note 里 industry 可能为空，此时第 3 段会是「N天M板」或「首封」，不能当行业名
      name: m?.[2] && m[2] !== "首封" ? m[2] : "",
      sector: ZT_STAT.test(industry) || industry === "首封" ? "" : industry,
      boards: boards ?? undefined,
      limit_up_time: POOL_SEAL.exec(r.note)?.[1],
      limit_price: vOf(r, "pool_price") ?? undefined,
      change_pct: vOf(r, "pool_change_pct") ?? undefined,
      turnover: vOf(r, "pool_amount") ?? undefined,
      float_market_cap: vOf(r, "pool_float_cap") ?? undefined,
      seal_order: vOf(r, "pool_seal_fund") ?? undefined,
      open_count: breaks ?? 0,
      tags: [],
    });
  }
  const gaps: string[] = [];
  if (noBoards) gaps.push(`${noBoards} 只票的连板数(pool_limit_days)没取到：这些票不算首板 / 龙头，本轮模式识别会漏`);
  if (noBreaks) gaps.push(`${noBreaks} 只票的开板次数(pool_break_times)没取到：按 0 次处理，弱转强 / 分歧转一致判据会偏`);
  if (envOf(env)?.status === "partial") gaps.push("涨停池信封是 partial（可能有分档没取全），清单只按已拿到的行算");
  return { rows: parsed, gaps };
}

/** 昨日梯队：`extra.result` 是对象，逐只在 `result.stocks` */
export function parseLadder(env: unknown): Map<string, LadderStock> {
  const out = new Map<string, LadderStock>();
  if (!envelopeUsable(env)) return out;
  const result = (envOf(env)?.extra ?? {}).result as { stocks?: unknown[] } | undefined;
  const stocks = Array.isArray(result?.stocks) ? result!.stocks : [];
  for (const s of stocks as Record<string, unknown>[]) {
    const code = str(s?.code);
    if (!/^\d{6}$/.test(code)) continue;
    out.set(code, {
      code, name: str(s.name) || code, boards: num(s.boards) ?? 0, sector: str(s.sector),
      limit_up_time: hhmm(s.first_seal), open_count: num(s.broken_times) ?? undefined, tags: [],
    });
  }
  return out;
}

/** 首板名单：`extra.result.stocks`，涨停原因在 `reason`（源站编辑归因，非公司确认） */
export function parseFirstboard(env: unknown): Map<string, FirstBoardRow> {
  const out = new Map<string, FirstBoardRow>();
  if (!envelopeUsable(env)) return out;
  const result = (envOf(env)?.extra ?? {}).result as { stocks?: unknown[] } | undefined;
  const stocks = Array.isArray(result?.stocks) ? result!.stocks : [];
  for (const s of stocks as Record<string, unknown>[]) {
    const code = str(s?.code);
    if (!/^\d{6}$/.test(code)) continue;
    out.set(code, {
      code, name: str(s.name) || code, sector: str(s.sector),
      limit_up_time: hhmm(s.first_seal), open_count: num(s.broken_times) ?? undefined,
      reason: str(s.reason), tags: str(s.reason) ? [str(s.reason)] : [],
    });
  }
  return out;
}

/**
 * 封板率 / 炸板率：主源 `cn_shortline_daily` 的 broken_rate（口径 = 炸板 ÷(涨停+炸板)），
 * 备源 `em_limit_up_sentiment` 的三池计数。两路都没有就返回 null + 缺口，**不写 0、不猜**。
 * 2026-11-10 实机：主源给 0.278，备源当天 status=failed —— 只修字段名仍会恒 null。
 */
export function parseRates(dailyEnv: unknown, sentimentEnv: unknown, rejected?: Partial<Record<OpportunitySourceKey, string>>):
  { seal_rate: number | null; broken_rate: number | null; limit_up: number | null; gaps: string[] } {
  const broken = scalarOf(dailyEnv, "broken_rate");
  if (broken !== null && broken >= 0 && broken <= 1) {
    const gaps: string[] = [];
    if (envOf(dailyEnv)?.status === "partial") gaps.push("每日情绪读数还没收盘定稿(partial)，封板率是盘中值");
    return { seal_rate: 1 - broken, broken_rate: broken, limit_up: scalarOf(dailyEnv, "limit_up_count"), gaps };
  }
  const zt = scalarOf(sentimentEnv, "limit_up_count");
  const zb = scalarOf(sentimentEnv, "break_board_count");
  if (zt !== null && zb !== null && zt + zb > 0) {
    const seal = zt / (zt + zb);
    return {
      seal_rate: seal, broken_rate: 1 - seal, limit_up: zt,
      gaps: ["封板率用了三池计数备源(涨停 ÷(涨停+炸板))，每日情绪读数这一路没给 broken_rate"],
    };
  }
  const why = rejected?.daily || rejected?.sentiment
    ? [rejected.daily, rejected.sentiment].filter(Boolean).join("；")
    : failedNote(dailyEnv) || failedNote(sentimentEnv) || "两路都没给可用读数";
  return { seal_rate: null, broken_rate: null, limit_up: null, gaps: [`封板率 / 炸板率两路都没取到(${why.slice(0, 120)})：留白，不写 0`] };
}

// ─── 工具函数 ───────────────────────────────────────────────────────────────────

function parseTime(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function sealTimeMinutes(t: string | null): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// ─── 模式识别（判据与置信度数值保持原样，本轮不动） ────────────────────────────────

/**
 * 判断一只票属于哪种模式
 */
function classifyPattern(
  stock: ZtPoolRow,
  ladderMap: Map<string, LadderStock>,
  firstBoardMap: Map<string, FirstBoardRow>,
  totalLimitUp: number,
): OpportunityPattern | null {
  const { code, name, boards, open_count, limit_up_time, sector, tags } = stock;

  // 首板爆发：首次涨停 + 板块内 ≥3 只 + 封板时间早（<10:30）
  if (boards !== undefined && (boards === 1 || boards === 0)) {
    const sealMin = sealTimeMinutes(limit_up_time ?? null);
    const earlySeal = sealMin !== null && sealMin <= 630;
    const tagStr = (tags ?? []).join(" ");
    const isTheme = tagStr.length > 0;

    // 简单启发：首板 + 早封 + 有题材标签
    if (earlySeal && isTheme) {
      return {
        type: "首板爆发",
        confidence: 65,
        trigger: `首板 + ${tagStr}题材 + 早盘封板(${limit_up_time})`,
        risk: "中",
      };
    }
    if (earlySeal && !isTheme) {
      return {
        type: "首板爆发",
        confidence: 50,
        trigger: `首板 + 早盘封板(${limit_up_time})，题材待确认`,
        risk: "中",
      };
    }
  }

  // N字反包：昨日曾涨停（ladder中有），今天再板
  const prevLadder = ladderMap.get(code);
  if (prevLadder && prevLadder.boards >= 1) {
    const todayOpenCount = open_count ?? 0;
    if (todayOpenCount <= 1) {
      return {
        type: "N字反包",
        confidence: 70,
        trigger: `昨日${prevLadder.boards}板，今日再板，开板${todayOpenCount}次`,
        risk: "中",
      };
    }
  }

  // 弱转强：昨日炸板/分歧 → 今日反包涨停
  if (prevLadder && prevLadder.open_count && prevLadder.open_count >= 2) {
    if ((open_count ?? 0) === 0) {
      return {
        type: "弱转强",
        confidence: 75,
        trigger: `昨日分歧(开板${prevLadder.open_count}次)→今日一字封板`,
        risk: "中",
      };
    }
  }

  // 分歧转一致：昨日开板 ≥2 次 → 今日快速封板
  if (prevLadder && prevLadder.open_count && prevLadder.open_count >= 2) {
    const sealMin = sealTimeMinutes(limit_up_time ?? null);
    if (sealMin !== null && sealMin <= 660) {
      return {
        type: "分歧转一致",
        confidence: 68,
        trigger: `昨日开板${prevLadder.open_count}次，今日早盘${limit_up_time}封板`,
        risk: "中",
      };
    }
  }

  // 龙头接力：高位龙头（≥3板）晋级
  if (boards !== undefined && boards >= 3) {
    return {
      type: "龙头接力",
      confidence: 60,
      trigger: `${boards}板高位龙头，注意分歧风险`,
      risk: "高",
    };
  }

  return null;
}

// ─── 组装（纯函数，可真跑测试） ───────────────────────────────────────────────────

/**
 * 五路信封 → 页面结果。**取数失败与「真的没匹配到」必须分开**：
 * `status: "failed"` 时 `opportunities: []` 只代表没取到，页面不许写「今天没有机会」。
 */
export function assembleOpportunities(envs: OpportunityEnvelopes, day: string, clock: string): ShortlineOpportunityResult {
  const gaps: string[] = [];
  const rejected = envs.rejected ?? {};
  for (const k of SOURCE_KEYS) {
    if (rejected[k]) gaps.push(`${SOURCE_LABEL[k]} 取数失败: ${rejected[k]!.slice(0, 120)}`);
  }

  const pool = parseZtPool(envs.ztPool);
  const ztRows: ZtPoolRow[] = pool.rows;
  // 🔴 交易日不可能 0 只涨停：信封有证据却解析不出一行、或一行都读不到连板数，
  //    就是字段对不上 / 名单被截断，一律按「没取到」处理。
  //    旧版正是在这里把故障伪装成「今天没有匹配到模式的机会」。
  const ztUsable = envelopeUsable(envs.ztPool) && ztRows.length > 0
    && ztRows.some((r) => r.boards !== undefined);
  gaps.push(...pool.gaps);
  if (!ztUsable) {
    const why = rejected.ztPool || failedNote(envs.ztPool)
      || (envOf(envs.ztPool)?.status === "failed" ? "端点返回 failed(可能是日期格式不对或超出东财保留期)" : "")
      || (envs.ztPool ? "信封里没有可解析的逐只明细(字段可能变了)" : "没有信封(可能不是交易日)");
    gaps.unshift(`涨停池这一路没取到(${why.slice(0, 120)})：下面的空清单是「没取到」，不是「今天没有机会」`);
  }

  const rates = parseRates(envs.daily, envs.sentiment, rejected);
  gaps.push(...rates.gaps);

  const ladderMap = parseLadder(envs.ladder);
  if (!envelopeUsable(envs.ladder) || ladderMap.size === 0) {
    gaps.push("昨日梯队没取到：N字反包 / 弱转强 / 分歧转一致这三类模式本轮判不了");
  }
  const firstBoardMap = parseFirstboard(envs.firstboard);
  // 🔴 信封 status=ok 但 extra.result 形状不对（比如直接是数组）也解析不出名单，
  //    不能只凭 status 就说「名单取到了」。
  if (!envelopeUsable(envs.firstboard) || firstBoardMap.size === 0) {
    gaps.push("首板名单没取到：涨停原因(题材)维度本轮不参与");
  } else {
    const result = (envOf(envs.firstboard)?.extra ?? {}).result as { reason_available?: unknown; reason_covered?: unknown } | undefined;
    if (!result?.reason_available || num(result.reason_covered) === 0) {
      gaps.push("首板名单取到了但涨停原因没取到：题材维度本轮不参与，首板爆发只按封板时间判定");
    }
  }

  // 首板名单是结构化来源，用它补 note 里可能没解析出来的名称 / 行业 / 首封时间 / 题材
  for (const row of ztRows) {
    const fb = firstBoardMap.get(row.code);
    if (!fb) continue;
    if (!row.name && fb.name) row.name = fb.name;
    if (!row.sector && fb.sector) row.sector = fb.sector;
    if (!row.limit_up_time && fb.limit_up_time) row.limit_up_time = fb.limit_up_time;
    if (!row.tags?.length && fb.tags?.length) row.tags = fb.tags;
  }

  // 识别机会
  const opportunities: StockOpportunity[] = [];
  for (const row of ztRows) {
    const pattern = classifyPattern(row, ladderMap, firstBoardMap, ztRows.length);
    if (!pattern) continue;
    opportunities.push({
      code: row.code,
      name: row.name || row.code,
      sector: row.sector ?? "",
      boards: row.boards ?? 0,
      seal_time: parseTime(row.limit_up_time),
      tags: row.tags ?? [],
      pattern,
      limit_price: row.limit_price ?? null,
      change_pct: row.change_pct ?? null,
      float_cap_yi: row.float_market_cap != null ? row.float_market_cap / 1e8 : null,
      turnover_yi: row.turnover != null ? row.turnover / 1e8 : null,
      seal_amount_yi: row.seal_order != null ? row.seal_order / 1e8 : null,
      open_count: row.open_count ?? 0,
      note: pattern.trigger,
    });
  }

  // 按板块聚类
  const bySector: Record<string, StockOpportunity[]> = {};
  for (const o of opportunities) {
    const k = o.sector || "其他";
    if (!bySector[k]) bySector[k] = [];
    bySector[k].push(o);
  }

  // 当日涨停数前二行业(全部涨停股聚类,并列按行业名 —— 跟 samples.ts 的 dayContext 同一套口径)
  const sectorCount = new Map<string, number>();
  for (const r of ztRows) if (r.sector) sectorCount.set(r.sector, (sectorCount.get(r.sector) ?? 0) + 1);
  const mainSectors = [...sectorCount]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 2)
    .map(([s]) => s);

  // 排序：按 confidence 降序
  opportunities.sort((a, b) => (b.pattern?.confidence ?? 0) - (a.pattern?.confidence ?? 0));

  // 市场相位
  const sealRate = rates.seal_rate;
  let phase = "震荡";
  if (sealRate != null) {
    if (sealRate >= 0.8) phase = "强势";
    else if (sealRate >= 0.6) phase = "温和";
    else phase = "分歧";
  }

  const status: OpportunityStatus = !ztUsable ? "failed" : gaps.length ? "partial" : "ok";
  return {
    date: day, clock, status, phase,
    limit_up_count: ztRows.length,
    broken_rate: rates.broken_rate,
    seal_rate: sealRate,
    opportunities, by_sector: bySector, main_sectors: mainSectors,
    gaps, notes: gaps,
    source: "em_zt_pool + cn_shortline_daily / em_limit_up_sentiment + cn_shortline_ladder + cn_shortline_firstboard",
  };
}

// ─── 主函数（只负责取数，组装全在纯函数里） ────────────────────────────────────────

export async function shortlineOpportunitiesAct(
  ctx: ServiceContext,
  body: Record<string, unknown>,
  abortSignal: AbortSignal,
): Promise<ShortlineOpportunityResult> {
  const { clockOf } = await import("./intraday.ts");
  const now = new Date();
  const day = clockOf(now).day;
  const clock = clockOf(now).hms;

  // 🔴 参数原来叫 `_body`、「刷新」点了等于没点。盘中这几个端点一直在变，键却不变 —— 不给时效会冻在当天第一次取数。
  const force = wantsFresh(body?.refresh);
  const q = (endpoint: string, args: Record<string, unknown>) =>
    fetchEndpoint(ctx, { endpoint, args, session: "opportunities", signal: abortSignal, consistency: consistencyFor(endpoint, force) });

  const a = opportunityDayArgs(day);
  const settled = await Promise.allSettled([
    q("em_zt_pool", a.ztPool),
    q("cn_shortline_daily", a.daily),
    q("em_limit_up_sentiment", a.sentiment),
    q("cn_shortline_ladder", a.ladder),
    q("cn_shortline_firstboard", a.firstboard),
  ]);

  const envs: OpportunityEnvelopes = {
    ztPool: null, daily: null, sentiment: null, ladder: null, firstboard: null, rejected: {},
  };
  settled.forEach((r, i) => {
    const k = SOURCE_KEYS[i]!;
    if (r.status === "fulfilled") envs[k] = r.value.envelope;
    else envs.rejected![k] = r.reason instanceof Error ? r.reason.message : String(r.reason);
  });
  return assembleOpportunities(envs, day, clock);
}
