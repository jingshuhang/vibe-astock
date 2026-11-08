/**
 * 盯盘 · 市场实时概况:把已有的几个行情 / 情绪端点拼成一张全景面板。
 * 数据全部来自 registry 现有端点,不新接源:
 *   tx_quotes_batch        腾讯批量行情(A 股主要指数)→ indices
 *   em_market_breadth      东财全市场涨跌分布 + 沪深京家数 / 成交额 → breadth
 *   cn_shortline_live      东财短线盘中情绪(涨停 / 炸板 / 跌停 / 封板率) → shortline
 *   em_industry_comparison 东财行业板块涨跌排名 → sectors
 *   sina_board_flow        新浪板块资金流(东财的备源) → boardFlow
 * 市场健康度 / 决策引擎 / 事件热词由本文件用上述东财块直接派生,不再依赖任何外部引擎。
 * 每个端点独立取、独立标注状态;东财在部分网络环境可能取不到,前端按状态降级显示(本机 5940 通常正常)。
 * 只陈述客观读数,不排序打分、不给买卖倾向。
 */
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { consistencyFor, wantsFresh } from "../snapshot_ttl.ts";
import { clockOf } from "./intraday.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { deriveMarketSignal, buildMarketStateView, gateDataFrom, cctvTitlesFrom, type MarketGateData, type MarketProvenance } from "../market_state.ts";
import type { MarketStateView } from "../market_state.ts";
import { readMacroEvents, type MacroEventReading } from "../macro_events.ts";
// 评分输入的解析全仓只有这一份。这里只负责把它们切成「展示用」的形状，
// 评分一律拿切之前的全量 —— 早先本文件自己写了一份、还截断给评分用，同一个收盘给出两个分。
import { boardFlowNetRows, groupByKey, num, parseResonance, type EvRec } from "../scoring_inputs.ts";

export const OVERVIEW_SOURCE =
  "腾讯实时行情(tx_quotes_batch);东财(em_market_breadth / cn_shortline_live / em_industry_comparison / em_market_trend);新浪板块资金流(sina_board_flow);连板天梯(cn_shortline_board_ladder);事件面取央视《新闻联播》文字稿标题(cctv_news);事件热词来自 cls_telegraph(财联社电报)";

export type BlockStatus = "ok" | "partial" | "failed" | "empty";
export interface OverviewBlock<T> {
  status: BlockStatus;
  data: T | null;
  note?: string;
  /** 这一块是什么时候取到的（ISO）；页面据此判断数据是不是当日的 */
  at?: string | null;
}

export interface IndexRow {
  code: string;
  name: string;
  price: number | null;
  change_pct: number | null;
}
export interface BreadthSummary {
  scope: string;
  limit_up: number;
  limit_down: number;
  up: number;
  down: number;
  flat: number;
  turnover_yi: number | null;
}
export interface SectorRow {
  name: string;
  change_pct: number | null;
  up_count: number | null;
  down_count: number | null;
  rank: number | null;
}
export interface BoardFlowRow {
  name: string;
  net_yi: number | null;
  change_pct: number | null;
  leader: string | null;
  rank: number | null;
}
/** 板块多股共振:同板块内上涨家数占比 ≥ 60% 记为"共振" */
export interface ResonanceRow {
  name: string;
  change_pct: number | null;
  up_count: number | null;
  down_count: number | null;
  total: number | null;
  resonance_rate: number | null;
  rank: number | null;
  signal: "共振" | "强动" | "一般";
}

/** 板块共振块：展示用 Top10 + 全市场聚合读数（聚合在 slice 之前算，见 extractResonance） */
export interface ResonanceSummary {
  rows: ResonanceRow[];
  scope: string;
  /** 全部板块共振率的算术均值（0-100） */
  avg_rate?: number | null;
  /** 共振板块（≥60%）占全部板块的比例（0-1） */
  resonance_share?: number | null;
}

/** 事件热词:财联社电报关键词词频 Top(本地聚合,本机派生)。trend 恒为 null —— 本机只做词频,不判热度方向 */
export interface EventTrend {
  topics: { keyword: string; count: number | null; trend: string | null }[];
}

export interface OverviewView {
  date: string;
  clock: string;
  phase_label: string;
  poll_ms: number;
  /** 指数实时(腾讯) */
  indices: OverviewBlock<{ rows: IndexRow[]; scope: string }>;
  /** 全市场涨跌分布 + 沪深京家数 / 成交额(东财) */
  breadth: OverviewBlock<BreadthSummary>;
  /** 短线盘中情绪:涨停 / 炸板 / 跌停 / 封板率(东财) */
  shortline: OverviewBlock<Record<string, unknown>>;
  /** 行业板块涨跌排名(东财) */
  sectors: OverviewBlock<{ rows: SectorRow[] }>;
  /** 板块多股共振信号 */
  resonance: OverviewBlock<ResonanceSummary>;
  /** 板块资金流(新浪备源)。`rows` 是展示用 Top12，评分走 `all_net_yi`（全量） */
  boardFlow: OverviewBlock<BoardFlowBlock>;
  /** 市场状态信号(复用 market_state 的 deriveMarketSignal + buildMarketStateView,与「市场状态信号」独立页同一套信号与容错) */
  marketState: OverviewBlock<MarketStateView>;
  /** 事件热词(财联社电报词频) */
  marketEventTrend: OverviewBlock<EventTrend>;
  notes: string[];
  source: string;
}

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope"> & Partial<Pick<FetchResult, "fetched_at">>>;

const INDEX_NAMES: Record<string, string> = {
  sh000001: "上证指数",
  sz399001: "深证成指",
  sz399006: "创业板指",
  sh000688: "科创50",
  bj899050: "北证50",
  sh000300: "沪深300",
  sh000905: "中证500",
  sh000016: "上证50",
};
const INDEX_ORDER = Object.keys(INDEX_NAMES);

function extractIndices(env: Record<string, unknown>): { rows: IndexRow[]; scope: string } {
  const g = groupByKey(env);
  const rows: IndexRow[] = [];
  for (const [rk, row] of g) {
    const name = INDEX_NAMES[rk] ?? (row.note?.split("(")[0]?.trim() || rk);
    const price = num(row.fields.get("price")?.value);
    const pct = num(row.fields.get("change_pct")?.value);
    if (price === null && pct === null) continue;
    rows.push({ code: rk, name, price, change_pct: pct });
  }
  rows.sort((a, b) => INDEX_ORDER.indexOf(a.code) - INDEX_ORDER.indexOf(b.code));
  return { rows, scope: "A 股主要指数(腾讯实时)" };
}

/** 涨跌分布的家数（分档累加结果） */
export interface BreadthCounts {
  limit_up: number; limit_down: number; up: number; down: number; flat: number;
  turnover_yi: number | null;
}

/**
 * 涨跌分布解析 —— 全仓唯一一份，overview 与 market_state 共用。
 *
 * 🔴 数据是**按 `note` 分档的长表**：值在 `market_dist_count` 里，靠 note 的
 * 「涨停 / 跌停 / 涨… / 跌… / 平盘」区分档位。**不存在** `limit_up` / `up_count` 这种字段名。
 * 早先 market_state 按字段名去 find，永远找不到 → 家数全是空 →
 * 被当成「涨停 0 家 → 冰点期 → 极高风险 → 不许开新仓」，而真相只是解析方式不对。
 *
 * @returns 一家都没解析出来时返回 **null**（不是全 0）—— 让调用方能区分「真的 0 家」和「没取到」
 */
export function breadthFrom(env: Record<string, unknown>): BreadthCounts | null {
  const g = groupByKey(env);
  let limit_up = 0;
  let limit_down = 0;
  let up = 0;
  let down = 0;
  let flat = 0;
  let turnover_yi: number | null = null;
  for (const [, row] of g) {
    const note = row.note ?? "";
    const count = num(row.fields.get("market_dist_count")?.value) ?? 0;
    const turn = num(row.fields.get("market_turnover_amount")?.value);
    // 涨停 / 跌停按精确标签匹配:拿「涨超 9%(未涨停)」里的「涨停」二字当涨停会误判(东财与新浪备源都输出精确标签 涨停 / 跌停)
    if (note === "涨停") limit_up += count;
    else if (note === "跌停") limit_down += count;
    else if (note.startsWith("涨")) up += count;
    else if (note.startsWith("跌")) down += count;
    else if (note.includes("平盘")) flat += count;
    if (turn !== null) turnover_yi = (turnover_yi ?? 0) + turn / 1e8; // 元 → 亿
  }
  return limit_up + limit_down + up + down + flat > 0 ? { limit_up, limit_down, up, down, flat, turnover_yi } : null;
}

/**
 * 🔴 一家都没解析出来时返回 **null**，不再用 `?? 0` 填满六个计数。
 *    旧写法里 `extract()` 拿到的是一个「长得像有数据」的对象，块状态因此是 `ok`，
 *    前端 `BreadthBody` 用 `String(d.limit_up)` 就把「没取到」画成「涨停 0 家 / 上涨 0 家」。
 *    这是典型的「不报错、只给错答案」：同一屏的短线情绪还是实时读数，看着像全市场冰点。
 *    返回 null 后 `extract()` 会把它标成 `empty`，`deriveOverviewMarketState` 也拿不到
 *    假的 0，`breadthUsable({})` 直接判「算不出来」，不给分数、不设仓位上限。
 */
function extractBreadth(env: Record<string, unknown>): BreadthSummary | null {
  const c = breadthFrom(env);
  if (!c) return null;
  return {
    scope: "全市场涨跌分布(东财)",
    limit_up: c.limit_up, limit_down: c.limit_down,
    up: c.up, down: c.down, flat: c.flat,
    turnover_yi: c.turnover_yi,
  };
}

function extractShortline(env: Record<string, unknown>): Record<string, unknown> | null {
  const extra = (env.extra as { result?: { live?: Record<string, unknown> } } | undefined)?.result;
  return extra?.live ?? null;
}

function extractSectors(env: Record<string, unknown>): { rows: SectorRow[] } {
  const g = groupByKey(env);
  const rows: SectorRow[] = [];
  for (const [rk, row] of g) {
    const note = row.note ?? "";
    const name = note.split("排名")[0]?.trim() || rk;
    const pct = num(row.fields.get("industry_board_change_pct")?.value);
    if (pct === null) continue;
    const rankM = /排名\s*(\d+)/.exec(note);
    rows.push({
      name,
      change_pct: pct,
      up_count: num(row.fields.get("industry_board_up_count")?.value),
      down_count: num(row.fields.get("industry_board_down_count")?.value),
      rank: rankM ? Number(rankM[1]) : null,
    });
  }
  rows.sort((a, b) => (b.change_pct ?? -Infinity) - (a.change_pct ?? -Infinity));
  return { rows: rows.slice(0, 12) };
}

/** 板块资金流：`rows` 只给展示（Top12），`all_net_yi` 是**全部**板块、专供评分 */
export interface BoardFlowBlock {
  rows: BoardFlowRow[];
  /**
   * 🔴 评分专用：全部板块的净流入（亿）。
   *    `rows` 是「挑出来最高的 12 个」，它们必然全为正 —— 拿它算净流入占比恒等于 100%。
   */
  all_net_yi: number[];
}

function extractBoardFlow(env: Record<string, unknown>): BoardFlowBlock {
  const g = groupByKey(env);
  const rows: BoardFlowRow[] = [];
  for (const [rk, row] of g) {
    const note = row.note ?? "";
    const nameM = /^([^\s]+)\s*排名\s*\d+/.exec(note) ?? /^([^;]+)/.exec(note);
    const name = nameM ? nameM[1].trim() : rk;
    const net = num(row.fields.get("board_net_sina")?.value); // 元
    const pct = num(row.fields.get("board_change_pct_sina")?.value);
    const leadM = /领涨\s*([^\s;]+)/.exec(note);
    const rankM = /排名\s*(\d+)/.exec(note);
    rows.push({
      name,
      net_yi: net !== null ? net / 1e8 : null, // 元 → 亿
      change_pct: pct,
      leader: leadM ? leadM[1] : null,
      rank: rankM ? Number(rankM[1]) : null,
    });
  }
  // 全量在排序 / 截断之前取好（走共享解析，按 field 过滤，不会把「流入」「涨跌幅」混进来）
  const all_net_yi = boardFlowNetRows(env).map((r) => r.net_yi);
  rows.sort((a, b) => (b.net_yi ?? -Infinity) - (a.net_yi ?? -Infinity));
  return { rows: rows.slice(0, 12), all_net_yi };
}

/**
 * 板块多股共振：展示只留 Top10，聚合读数（`avg_rate` / `resonance_share`）用**全部**板块算。
 *
 * 解析本身走 `scoring_inputs.parseResonance`（全仓唯一一份）—— 这里只做两件事：
 * 切成展示形状、把 `signal` 收窄成前端要的联合类型。
 */
function extractResonance(env: Record<string, unknown>): {
  rows: ResonanceRow[];
  scope: string;
  avg_rate: number | null;
  resonance_share: number | null;
} {
  const parsed = parseResonance(env);
  return {
    rows: parsed.rows.slice(0, 10),
    scope: "板块多股共振(东财,共振率≥60%)",
    avg_rate: parsed.avg_rate,
    resonance_share: parsed.resonance_share,
  };
}

type Kind = "indices" | "breadth" | "shortline" | "sectors" | "resonance" | "boardFlow";

async function extract(
  fetch: Fetch,
  ctx: ServiceContext,
  signal: AbortSignal,
  endpoint: string,
  kind: Kind,
): Promise<OverviewBlock<unknown>> {
  try {
    const r = await fetch(ctx, { endpoint, args: {}, signal });
    const env = r.envelope as Record<string, unknown>;
    const status = (env.status as string) ?? "";
    if (status === "failed") return { status: "failed", data: null, note: "上游失败" };
    const ev = Array.isArray(env.evidence) ? (env.evidence as EvRec[]) : [];
    let data: unknown = null;
    switch (kind) {
      case "indices":
        data = extractIndices(env);
        break;
      case "breadth":
        data = extractBreadth(env);
        break;
      case "shortline":
        data = extractShortline(env);
        break;
      case "sectors":
        data = extractSectors(env);
        break;
      case "resonance":
        data = extractResonance(env);
        break;
      case "boardFlow":
        data = extractBoardFlow(env);
        break;
    }
    if (!data) {
      const errs = Array.isArray(env.errors) ? (env.errors as unknown[]) : [];
      const note = kind === "breadth"
        ? "涨跌分布一家都没解析出来（不是 0 家），不拿占位 0 当真值"
        : errs.length ? String(errs[0]) : "无数据";
      return { status: "empty", data: null, note, at: r.fetched_at ?? null };
    }
    // partial 也要说一句：缺的分档会被算成 0，不说就会把「少了几档」读成「那几档一家没有」。
    const note = status === "partial" && kind === "breadth"
      ? "这一块只有部分数据：没取到的分档显示为 0，别当成「一家都没有」"
      : undefined;
    return { status: status === "partial" ? "partial" : "ok", data, note, at: r.fetched_at ?? null };
  } catch (e) {
    return { status: "failed", data: null, note: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 市场状态信号(盯盘页内嵌版):复用 market_state.ts 的 deriveMarketSignal + buildMarketStateView,
 * 直接拿本面板已经取到的 breadth / resonance / boardFlow 块派生,不再单独发请求。
 * 这样盯盘页和「市场状态信号」独立页是同一套信号、同一套容错(涨跌分布没取到就说算不出来,不给分数、不设仓位上限),
 * 且东财主源断连时由新浪备源接住(见 em_market_breadth 的 sina 备源)。
 *
 * @param gateData 可选的主升期闸门输入（来自 em_market_trend + cn_shortline_board_ladder）
 * @param event 可选的事件面读数（新闻联播 + 宏观词典）；不给就说「算不出来」、让渡权重
 */
export function deriveOverviewMarketState(
  breadth: OverviewBlock<BreadthSummary>,
  resonance: OverviewBlock<ResonanceSummary>,
  boardFlow: OverviewBlock<BoardFlowBlock>,
  gateData?: MarketGateData | null,
  provenance?: MarketProvenance | null,
  event?: MacroEventReading | null,
): OverviewBlock<MarketStateView> {
  const b = breadth.data;
  const bd = b
    ? { limit_up: b.limit_up ?? 0, limit_down: b.limit_down ?? 0, up: b.up, down: b.down, flat: b.flat }
    : {};
  // 🔴 共振率源端是 0-100 的百分比，`deriveMarketSignal` 会统一除成 0-1，这里不再除一次
  const res = {
    rows: (resonance.data?.rows ?? []).map((r) => ({ resonance_rate: r.resonance_rate })),
    // 聚合读数（全市场口径）优先；没有才退回展示行均值
    resonance_share: resonance.data?.resonance_share ?? null,
  };
  // 🔴 评分必须用 `all_net_yi`（全部板块），**不能**用 `rows`（展示 Top12 恒为正）
  const bf = { rows: (boardFlow.data?.all_net_yi ?? []).map((net_yi) => ({ net_yi })) };
  const signal = deriveMarketSignal(bd, res, bf, gateData ?? null, { provenance: provenance ?? null, event: event ?? null });
  const view = buildMarketStateView(signal, bd, res, gateData ?? null);
  // 🔴 部分数据不许报 `ok`。breadth 缺档会被补齐成 0 后照常进 scoreMarket，
  //    resonance / boardFlow 缺腿则让「赚钱效应」按中性补位 —— 这些是「算出来了但少看了东西」，
  //    不是「数据齐」。旧判据只看 `signal.unavailable`（仅全空时非空），于是 partial 一路被吞成 ok，
  //    连 extract() 刚补的那句「别当成一家都没有」也丢在这里。现在状态与 note 都跟着块状态走。
  const gaps = [
    breadth.status === "partial" ? (breadth.note ?? "涨跌分布只取到部分分档") : "",
    resonance.status !== "ok" ? (resonance.note ?? "板块共振数据不完整") : "",
    boardFlow.status !== "ok" ? (boardFlow.note ?? "板块资金流数据不完整") : "",
  ].filter(Boolean);
  const status: BlockStatus = !b
    ? breadth.status === "failed" ? "failed" : "empty"
    : signal.unavailable ? "empty"
      : gaps.length ? "partial" : "ok";
  const note = signal.unavailable ?? (gaps.length ? gaps.join("；") : undefined);
  return { status, data: view, note };
}

/** 简单中文 n-gram 词频:从给定文本里抽取 2-4 字中文片段,过滤停用字与纯数字/标点 */
const HOT_STOP = new Set(["今日", "公司", "市场", "股价", "公告", "报告", "数据", "表示", "预计", "目前", "相关", "方面", "进行", "已经", "表示", "亿元", "万股", "股份", "有限", "集团", "中国", "美国", "全球"]);
function keywordFreq(texts: string[]): { keyword: string; count: number }[] {
  const freq = new Map<string, number>();
  for (const t of texts) {
    const cleaned = t.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "");
    const seen = new Set<string>();
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= cleaned.length; i++) {
        const gram = cleaned.slice(i, i + n);
        if (/^\d+$/.test(gram)) continue; // 纯数字跳过
        if (HOT_STOP.has(gram)) continue;
        if (n >= 3 && HOT_STOP.has(gram.slice(0, 2))) continue;
        seen.add(gram);
      }
    }
    for (const g of seen) freq.set(g, (freq.get(g) ?? 0) + 1);
  }
  return [...freq.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

/** 事件热词:从 cls_telegraph(财联社电报)取快讯,做关键词词频 Top(本机数据源,本机派生) */
async function fetchEventTrend(
  fetchFn: Fetch,
  ctx: ServiceContext,
  signal: AbortSignal,
): Promise<OverviewBlock<EventTrend>> {
  try {
    const r = await fetchFn(ctx, { endpoint: "cls_telegraph", args: {}, signal });
    const env = r.envelope as Record<string, unknown>;
    const status = (env.status as string) ?? "";
    if (status === "failed") return { status: "failed", data: null, note: "财联社电报取数失败" };
    const ev = Array.isArray(env.evidence) ? (env.evidence as Array<Record<string, unknown>>) : [];
    const texts: string[] = [];
    for (const e of ev) {
      const t = (e.content as string) ?? (e.title as string) ?? (e.text as string) ?? "";
      if (typeof t === "string" && t) texts.push(t);
    }
    if (!texts.length) return { status: "empty", data: null, note: "这一轮没有抽出事件热词" };
    const topics = keywordFreq(texts);
    if (!topics.length) return { status: "empty", data: null, note: "这一轮没有抽出事件热词" };
    return { status: status === "partial" ? "partial" : "ok", data: { topics: topics.map((t) => ({ keyword: t.keyword, count: t.count, trend: null })) } };
  } catch (e) {
    return { status: "failed", data: null, note: e instanceof Error ? e.message : String(e) };
  }
}

function phaseLabel(hm: string): string {
  if (hm < "09:15") return "开盘前";
  if (hm < "09:30") return "集合竞价";
  if (hm < "11:30") return "上午连续竞价";
  if (hm < "13:00") return "午间休市";
  if (hm < "14:57") return "下午连续竞价";
  if (hm < "15:00") return "收盘集合竞价";
  return "已收盘";
}

export async function shortlineOverviewAct(
  ctx: ServiceContext,
  body: Record<string, unknown>,
  signal: AbortSignal,
  deps: { fetch?: Fetch } = {},
): Promise<OverviewView> {
  // 🔴 这个视图原来也把 `body` 写作 `_body`、从不读 —— 页面「刷新」点了等于没点。
  const force = wantsFresh(body?.refresh);
  // 统一在这里套一层：**所有**取数（含 6 个类型化块 + 3 个闸门端点）都拿到时效上限，
  // 不用逐个调用点改 —— 逐个改最容易漏掉最新加的那一个。
  const upstream: Fetch = deps.fetch ?? fetchEndpoint;
  const fetch: Fetch = (c, req) =>
    upstream(c, { ...req, consistency: consistencyFor(String(req.endpoint ?? ""), force) } as Parameters<Fetch>[1]);
  const now = new Date();
  const { day, hms } = clockOf(now);
  const notes: string[] = [];
  // 并行取数:原有 6 个类型化块（每个调用加类型断言，保证元组类型正确）
  const indices = await extract(fetch, ctx, signal, "tx_quotes_batch", "indices") as OverviewBlock<{ rows: IndexRow[]; scope: string }>;
  const breadth = await extract(fetch, ctx, signal, "em_market_breadth", "breadth") as OverviewBlock<BreadthSummary>;
  const shortline = await extract(fetch, ctx, signal, "cn_shortline_live", "shortline") as OverviewBlock<Record<string, unknown>>;
  const sectors = await extract(fetch, ctx, signal, "em_industry_comparison", "sectors") as OverviewBlock<{ rows: SectorRow[] }>;
  const resonance = await extract(fetch, ctx, signal, "em_industry_comparison", "resonance") as OverviewBlock<ResonanceSummary>;
  const boardFlow = await extract(fetch, ctx, signal, "sina_board_flow", "boardFlow") as OverviewBlock<BoardFlowBlock>;
  // 闸门数据:指数均线与量能 + 连板梯队 + 新闻联播标题（独立 Promise.all，避免污染元组类型）
  // 🔴 cctv_news 只取标题（with_content=false），端点声明了 cache_max_age_sec=3600，
  //    一天真取几次；盯盘页 15s 轮询走的是快照，不额外占并发。
  const [trendEnv, ladderEnv, cctvEnv] = await Promise.all([
    extractRaw(fetch, ctx, signal, "em_market_trend"),
    extractRaw(fetch, ctx, signal, "cn_shortline_board_ladder"),
    // 盯盘页 15 秒一轮，新闻联播给 15 秒就够：端点声明了 1 小时缓存，冷启也只有一次真取。
    // 超时就算「事件面没算出来」（权重让渡），不能拖住整张卡片的渲染。
    extractRaw(fetch, ctx, signal, "cctv_news", { with_content: false }, 15_000),
  ]);
  const missing = [breadth, shortline, sectors].filter((b) => b.status === "failed" || b.status === "empty");
  if (missing.length) notes.push(`以下端点这一轮没取到(东财在部分网络环境取不到,本机通常正常):${missing.length} 项`);

  // 从趋势块提取闸门数据（上证 MA20、成交额均值、今日成交额）
  // 🔴 extractRaw 把信封放在 block.data 里（不是 block.envelope）—— 早先读错位置，
  //    于是量能门与均线门永远「没数据」，闸门只剩广度门在跑。
  const gateData = gateDataFrom(trendEnv.data, ladderEnv.data);
  if (gateData.notes.length) notes.push(...gateData.notes);
  const provenance: MarketProvenance = {
    breadth: breadth.at ?? null,
    resonance: resonance.at ?? null,
    board_flow: boardFlow.at ?? null,
    trend: trendEnv.at ?? null,
    ladder: ladderEnv.at ?? null,
    event: cctvEnv.at ?? null,
  };

  // 事件面:新闻联播标题 + 宏观词典（拿不到标题就是 null，权重让渡，不当 50 算）
  const event = cctvEnv.data ? readMacroEvents(cctvTitlesFrom(cctvEnv.data)) : null;

  // 市场状态信号:复用 market_state 派生,带闸门输入 + 事件读数
  const marketState = deriveOverviewMarketState(breadth, resonance, boardFlow, gateData.gate, provenance, event);
  // 事件热词:财联社电报词频聚合(本机数据源,本机派生)
  const marketEventTrend = await fetchEventTrend(fetch, ctx, signal);
  if (marketEventTrend.status === "failed") notes.push(`事件热词取数失败: ${marketEventTrend.note}`);
  return {
    date: day,
    clock: hms,
    phase_label: phaseLabel(hms.slice(0, 5)),
    poll_ms: 15_000,
    indices,
    breadth,
    shortline,
    sectors,
    resonance,
    boardFlow,
    marketState,
    marketEventTrend,
    notes,
    source: OVERVIEW_SOURCE,
  };
}

/** 从原始信封取数（不过滤 kind，直接返回 envelope） */
async function extractRaw(
  fetch: Fetch,
  ctx: ServiceContext,
  signal: AbortSignal,
  endpoint: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<OverviewBlock<unknown>> {
  try {
    const r = await fetch(ctx, { endpoint, args, signal, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) });
    const env = r.envelope as Record<string, unknown>;
    const status = (env.status as string) ?? "";
    if (status === "failed") return { status: "failed" as const, data: null, note: "上游失败" };
    const st: BlockStatus = status === "partial" ? "partial" : "ok";
    return { status: st, data: env, at: r.fetched_at ?? null };
  } catch {
    return { status: "failed" as const, data: null, note: "取数异常" };
  }
}
