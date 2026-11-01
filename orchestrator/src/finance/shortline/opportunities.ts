/**
 * 超短线机会发现 —— 主动扫描层（决策链第二层）
 *
 * 定位：从全市场涨停股中按模式识别候选机会，给出触发清单。
 *
 * 数据源：
 *   - em_zt_pool          今日涨停池（东财）
 *   - em_limit_up_sentiment  涨停情绪（东财）
 *   - cn_shortline_ladder    昨日连板梯队（东财计算型）
 *   - cn_shortline_firstboard 首板名单（东财计算型）
 *   - cn_shortline_board_ladder 连板天梯（东财计算型）
 *
 * 模式识别（按优先级）：
 *   1. 首板爆发：首次涨停 + 板块内 ≥3 只 + 封板时间早（<10:30）
 *   2. 弱转强：昨日炸板/分歧 → 今日反包涨停
 *   3. 分歧转一致：昨日分歧（开板 ≥2 次）→ 今日快速封板
 *   4. N字反包：连续两天涨停（前日涨停后分歧，今日再板）
 *   5. 龙头接力：高位龙头（≥3板）晋级，低位补涨
 *
 * 只列客观模式和触发条件，不给买卖建议。
 */

import { fetchEndpoint, type ServiceContext } from "../../service.ts";

// ─── 类型定义 ───────────────────────────────────────────────────────────────────

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
  /** 所属板块 */
  sector: string;
  /** 当前连板数 */
  boards: number;
  /** 涨停时间（HH:MM 格式） */
  seal_time: string | null;
  /** 今日涨停原因标签 */
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
  /** 降级提示 */
  notes: string[];
  /** 数据来源 */
  source: string;
}

// ─── 端点响应类型 ───────────────────────────────────────────────────────────────

interface ZtPoolRow {
  code: string;
  name: string;
  boards?: number;
  limit_up_time?: string;
  limit_price?: number;
  change_pct?: number;
  turnover?: number;
  float_market_cap?: number;
  seal_order?: number;
  open_count?: number;
  tags?: string[];
  sector?: string;
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

// ─── 模式识别 ───────────────────────────────────────────────────────────────────

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

  // 首板爆发：首次涨停 + 板块内 ≥3 只涨停 + 封板时间早（<10:30）
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

// ─── 主函数 ─────────────────────────────────────────────────────────────────────

export async function shortlineOpportunitiesAct(
  ctx: ServiceContext,
  _body: Record<string, unknown>,
  abortSignal: AbortSignal,
): Promise<ShortlineOpportunityResult> {
  const { clockOf } = await import("./intraday.ts");
  const now = new Date();
  const day = clockOf(now).day;

  const notes: string[] = [];

  // 并行取数
  const [ztEnv, sentimentEnv, ladderEnv, firstBoardEnv] = await Promise.allSettled([
    fetchEndpoint(ctx, { endpoint: "em_zt_pool", args: { date: day }, session: "opportunities", signal: abortSignal }),
    fetchEndpoint(ctx, { endpoint: "em_limit_up_sentiment", args: {}, session: "opportunities", signal: abortSignal }),
    fetchEndpoint(ctx, { endpoint: "cn_shortline_ladder", args: { date: day }, session: "opportunities", signal: abortSignal }),
    fetchEndpoint(ctx, { endpoint: "cn_shortline_firstboard", args: { date: day }, session: "opportunities", signal: abortSignal }),
  ]);

  // 解析数据
  let ztRows: ZtPoolRow[] = [];
  if (ztEnv.status === "fulfilled") {
    const env = ztEnv.value.envelope;
    if (Array.isArray(env.evidence)) {
      const ztMap = (env.evidence as any[])
        .filter((e: any) => e.record_key && e.field === "code")
        .reduce<Map<string, ZtPoolRow>>((m, e: any) => {
          const rk = e.record_key;
          if (!m.has(rk)) m.set(rk, { code: rk, name: "" });
          const row = m.get(rk)!;
          if (e.field === "name") row.name = e.value;
          if (e.field === "limit_up_time") row.limit_up_time = e.value;
          if (e.field === "limit_price") row.limit_price = e.value;
          if (e.field === "change_pct") row.change_pct = e.value;
          if (e.field === "turnover") row.turnover = e.value;
          if (e.field === "float_market_cap") row.float_market_cap = e.value;
          if (e.field === "seal_order") row.seal_order = e.value;
          if (e.field === "open_count") row.open_count = e.value;
          if (e.field === "tags") row.tags = typeof e.value === "string" ? [e.value] : e.value;
          if (e.field === "sector") row.sector = e.value;
          return m;
        }, new Map<string, ZtPoolRow>());
      ztRows = Array.from(ztMap.values());
    }
  } else {
    notes.push(`em_zt_pool 取数失败: ${ztEnv.status === "rejected" ? ztEnv.reason?.message ?? String(ztEnv.reason) : "未知"}`);
  }

  let sentiment: { seal_rate?: number; broken_rate?: number; limit_up?: number } = {};
  if (sentimentEnv.status === "fulfilled") {
    const env = sentimentEnv.value.envelope;
    if (env.evidence && Array.isArray(env.evidence)) {
      for (const e of env.evidence as any[]) {
        if (e.field === "seal_rate") sentiment.seal_rate = e.value;
        if (e.field === "broken_rate") sentiment.broken_rate = e.value;
        if (e.field === "limit_up") sentiment.limit_up = e.value;
      }
    }
  } else {
    notes.push(`em_limit_up_sentiment 取数失败: ${sentimentEnv.status === "rejected" ? String(sentimentEnv.reason) : "未知"}`);
  }

  let ladderMap = new Map<string, LadderStock>();
  if (ladderEnv.status === "fulfilled") {
    const env = ladderEnv.value.envelope;
    const extra = (env as any).extra;
    if (extra?.result && Array.isArray(extra.result)) {
      for (const s of extra.result as any[]) {
        ladderMap.set(s.code, {
          code: s.code,
          name: s.name,
          boards: s.boards ?? 0,
          sector: s.sector ?? "",
          limit_up_time: s.limit_up_time,
          open_count: s.open_count,
          tags: s.tags,
        });
      }
    }
  } else {
    notes.push(`cn_shortline_ladder 取数失败: ${ladderEnv.status === "rejected" ? String(ladderEnv.reason) : "未知"}`);
  }

  let firstBoardMap = new Map<string, FirstBoardRow>();
  if (firstBoardEnv.status === "fulfilled") {
    const env = firstBoardEnv.value.envelope;
    const extra = (env as any).extra;
    if (extra?.result && Array.isArray(extra.result)) {
      for (const s of extra.result as any[]) {
        firstBoardMap.set(s.code, {
          code: s.code,
          name: s.name,
          sector: s.sector ?? "",
          limit_up_time: s.limit_up_time,
          seal_order: s.seal_order,
          tags: s.tags,
          open_count: s.open_count,
        });
      }
    }
  } else {
    notes.push(`cn_shortline_firstboard 取数失败: ${firstBoardEnv.status === "rejected" ? String(firstBoardEnv.reason) : "未知"}`);
  }

  // 识别机会
  const opportunities: StockOpportunity[] = [];

  for (const row of ztRows) {
    const pattern = classifyPattern(row, ladderMap, firstBoardMap, ztRows.length);
    if (!pattern) continue;

    opportunities.push({
      code: row.code,
      name: row.name ?? row.code,
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
  // 用途:超短线机会发现的「板块共振」判定(首板·前二行业历史表现明显优于泛首板)
  const sectorCount = new Map<string, number>();
  for (const r of ztRows) if (r.sector) sectorCount.set(r.sector, (sectorCount.get(r.sector) ?? 0) + 1);
  const mainSectors = [...sectorCount]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 2)
    .map(([s]) => s);

  // 排序：按 confidence 降序
  opportunities.sort((a, b) => (b.pattern?.confidence ?? 0) - (a.pattern?.confidence ?? 0));

  // 市场相位
  const sealRate = sentiment.seal_rate ?? null;
  const brokenRate = sentiment.broken_rate ?? null;
  let phase = "震荡";
  if (sealRate != null) {
    if (sealRate >= 0.8) phase = "强势";
    else if (sealRate >= 0.6) phase = "温和";
    else phase = "分歧";
  }

  return {
    date: day,
    clock: clockOf(now).hms,
    phase,
    limit_up_count: ztRows.length,
    broken_rate: brokenRate,
    seal_rate: sealRate,
    opportunities,
    by_sector: bySector,
    main_sectors: mainSectors,
    notes,
    source: "em_zt_pool + em_limit_up_sentiment + cn_shortline_ladder + cn_shortline_firstboard",
  };
}
