/**
 * 个股分析(本地规则引擎) —— 技术面三维评分 + 主力行为阶段 + 估值分位 + 筹码 + 股东与事件。
 *
 * 🔴 取数全部走 Vibe-AStock 自己的端点(不新增数据源):
 *   · `tx_kline`            日 K(前复权)→ 全表行在取数器落盘的 raw/extracted_*.json 里,含 OHLCV
 *   · `tx_quotes_batch`     腾讯批量行情 → 现价 / 涨跌幅 / 换手率 / 开高低 / 昨收 / 名称
 *   · `bs_valuation_history` 估值序列(PE_TTM / PB / PS / PCF,近 5 年)→ 现值取证据,分位取全表行
 *   · `bs_chip_distribution` 筹码分布(获利比例 / 平均成本 / 90% 成本区间 / 集中度)
 *   · `em_holder_num`       股东户数与环比(basic 层,便宜且信息量大)
 *   · 质押 / 解禁 / 大宗 / 增减持 只在 `depth=full` 取(单次 4~10 秒,跟着打开页面跑太慢)
 * 🔴 代码**原样传**:个股 000001 就是平安银行;只有指数才带 sh/sz 前缀(见 registry notes)。
 *   给个股加 `sh` 前缀会取回上证指数,数字完全合理、看不出异常 —— 之前正是这么错的。
 * 🔴 取不到的数据如实写成 gaps,不当成 0、也不假装评分可信。**样本不够就不给阶段结论**,
 *   不是「先给一个结论、上面挂一行小字说数据不全」(那等于把没有装成有)。
 * 🔴 每个域都带自己的**数据日**(as_of)与**口径**(note)。同一个数字换个口径就不是同一个数字:
 *   筹码是模型推算、PE 分位是 baostock 口径,这些必须跟着数一起走。
 * 🔴 缓存上限按域的更新频率给(见 MAX_AGE):行情和日 K 是 5 分钟(盘中最后一根还在动),
 *   估值 / 筹码 / 股东是 2~6 小时。**不传 max_age 就等于永不过期** —— 日 K 曾因此读到四天前的快照。
 */

import { fetchEndpoint, type ServiceContext } from "../service.ts";
import { failedNote, rowsOf } from "./schedule.ts";
import { readRawDoc } from "./candidates.ts";

// ─── 类型 ──────────────────────────────────────────────────

export interface KlineBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  name: string;
  close: number;
  prev_close: number;
  pct_change: number;
  turnover: number;
  high: number;
  low: number;
  open: number;
  market_cap: number | null;
  pe: number | null;
}

export interface TechnicalFactors {
  trend_score: number;
  volume_score: number;
  position_score: number;
  factors: string[];
}

export interface MainCapitalStage {
  /** 数据不足时不给分数(不是给 50 凑数) */
  score: number | null;
  /** 「数据不足」是状态,不是结论:样本不够时一律用它,不拿观望/洗盘顶上 */
  stage: "吸筹" | "洗盘" | "主升" | "出货" | "观望" | "数据不足";
  confidence: string;
  advice: string;
  factors: string[];
}

/** 估值位置:贵不贵只能靠分位回答,现值本身没有参照物 */
export interface ValuationView {
  /** 估值序列最后一天 */
  as_of: string;
  window: { from: string; to: string; n: number };
  pe_ttm: number | null;
  pb: number | null;
  ps_ttm: number | null;
  /** 低于当前值的交易日占比(0~1);样本不足或当前值无效时为 null */
  pe_percentile: number | null;
  pb_percentile: number | null;
  /** 分位怎么算的:样本多少天、剔掉了什么 */
  basis: string;
  /** 口径提醒:与别家 PE 不可比 */
  note: string;
}

/** 筹码分布:**模型推算**,不是交易所数据 */
export interface ChipsView {
  as_of: string;
  window: { from: string; to: string; n: number | null };
  profit_ratio: number | null;
  avg_cost: number | null;
  concentration_90: number | null;
  cost_90: [number, number] | null;
  cost_70: [number, number] | null;
  peak_price: number | null;
  /** 窗口末日的前复权收盘价(和上面几个数同一口径的参照价) */
  price_ref: number | null;
  /** 现价相对平均成本(%):正=多数持仓浮盈 */
  above_avg_cost: number | null;
  note: string;
}

/** 股东与事件:谁在买、谁可能要卖 */
export interface HoldersView {
  /** 股东户数的报告期 */
  as_of: string | null;
  shareholder_count: number | null;
  shareholder_count_change_pct: number | null;
  /** 质押比例(%);full 层才有 */
  pledge_ratio: number | null;
  pledge_as_of: string | null;
  /** 未来窗口内待解禁批次;0 与「没取到」是两件事,null 表示没取到 */
  lockup_upcoming: number | null;
  lockup_window: string | null;
  /** 大宗交易笔数 / 最新一笔的折价率 */
  block_trade_count: number | null;
  block_trade_latest: { date: string; premium_pct: number | null } | null;
  /** 最近一条增减持 */
  holder_trade_latest: { date: string; direction: string; change_pct: number | null } | null;
}

export interface StockAnalysisResult {
  symbol: string;
  name: string;
  /** 数据不足时为 null —— 不拿 50 分凑数 */
  composite: number | null;
  main_capital: MainCapitalStage;
  technical: TechnicalFactors;
  /** 日 K(近 60 根),给前端画 / 复核用 */
  kline_data: KlineBar[];
  quote: Quote | null;
  valuation: ValuationView | null;
  chips: ChipsView | null;
  holders: HoldersView | null;
  /** 各域取数时刻里最早的那个:整份结论最早是这个时点的事实 */
  fetched_at: string;
  /** 是否有域读的是快照(不是这次真取的) */
  from_cache: boolean;
  /** 取不到或算不出的项,如实列出 —— 不算成 0,也不假装评分可信 */
  gaps: string[];
  /** 数据够不够支撑评分;false 时界面应弱化读数 */
  sufficient: boolean;
  /** 这次跑到了哪一层:basic = 行情+日K+估值+筹码+户数;full = 再加质押/解禁/大宗/增减持 */
  depth: "basic" | "full";
}

export interface AnalyzeOpts {
  /** 用户点了「刷新」:全部走 fresh,不许读快照 */
  refresh?: boolean;
  depth?: "basic" | "full";
}

// ─── 取数 ──────────────────────────────────────────────────

/**
 * 各域的缓存上限。**必须显式给** —— `prefer_cache` 不带 max_age 时 snapshotUsable()
 * 视为永不过期,日 K 就这么读到过四天前的快照。
 */
const MAX_AGE = {
  /** 盘中最后一根日 K 还在变 */
  kline: 5 * 60_000,
  /** 估值序列按交易日更新 */
  valuation: 2 * 3600_000,
  /** 筹码窗口按交易日更新 */
  chips: 2 * 3600_000,
  /** 股东户数是季度数据 */
  holders: 6 * 3600_000,
  /** 质押 / 解禁 / 大宗 / 增减持按日或按周更新 */
  events: 6 * 3600_000,
} as const;

/** 分位至少要这么多个交易日样本才给,少了就是拿几天的事当「历史」 */
const MIN_PERCENTILE_POINTS = 60;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

type Env = Record<string, unknown>;
interface Ev { id?: unknown; field?: unknown; value?: unknown; unit?: unknown; period?: unknown; as_of?: unknown; record_key?: unknown; note?: unknown; raw_ref?: unknown }
const evsOf = (env: Env): Ev[] => (Array.isArray(env.evidence) ? (env.evidence as Ev[]) : []);

/** 不带 record_key 的标量证据 */
function scalar(env: Env, field: string): Ev | undefined {
  return evsOf(env).find((e) => e.field === field && !e.record_key);
}
const scalarNum = (env: Env, field: string): number | null => num(scalar(env, field)?.value);

interface Fetched { env: Env; outDir: string; fetchedAt: string; cached: boolean }

/** 一次分析的横切记录:缺口、有没有读到快照、各域取数时刻 —— 三样都要跟着结果返回给用户 */
interface Probe { gaps: string[]; cached: boolean[]; at: string[] }
const newProbe = (): Probe => ({ gaps: [], cached: [], at: [] });

/** 取一个端点:失败写进 probe.gaps 并返回 null(不算成「市场没有」) */
async function fetchOne(
  ctx: ServiceContext, endpoint: string, symbol: string, args: Record<string, unknown> | undefined,
  refresh: boolean, maxAgeMs: number, p: Probe, label: string,
): Promise<Fetched | null> {
  try {
    const r = await fetchEndpoint(ctx, {
      endpoint, symbol, args,
      consistency: refresh ? { mode: "fresh" } : { mode: "prefer_cache", max_age_ms: maxAgeMs },
    });
    const env = (r.envelope ?? {}) as Env;
    if (env.status === "failed") {
      p.gaps.push(`${label}没取到(${failedNote(env) || "原因不明"})`);
      return null;
    }
    if (env.status === "partial") p.gaps.push(`${label}不完整${typeof env.degraded === "string" && env.degraded ? `(${String(env.degraded).slice(0, 60)})` : ""}`);
    if (r.fetched_at) p.at.push(r.fetched_at);
    if (r.cached === true) p.cached.push(true);
    return { env, outDir: r.out_dir, fetchedAt: r.fetched_at, cached: r.cached === true };
  } catch (e) {
    p.gaps.push(`${label}取数失败:${e instanceof Error ? e.message.slice(0, 60) : "未知原因"}`);
    return null;
  }
}

/** 取数器落盘的全表行(信封里只有最后一条的字段,序列要读 raw/extracted_) */
function rawRows(ctx: ServiceContext, f: Fetched): Record<string, unknown>[] {
  const ref = evsOf(f.env).map((e) => str(e.raw_ref)).find((x) => x.startsWith("raw/extracted_"));
  if (!ref) return [];
  const doc = readRawDoc(ctx, f.outDir, ref) as { rows?: unknown } | null;
  return Array.isArray(doc?.rows) ? (doc!.rows as Record<string, unknown>[]) : [];
}

/** 长表里最新的一行(按这一行各字段里最晚的 period 排) */
function latestRow(env: Env): { f: Record<string, Ev>; note: string } | null {
  const rowPeriod = (r: { f: Record<string, Ev> }) =>
    Object.values(r.f).map((e) => str(e.period)).filter(Boolean).sort().pop() ?? "";
  const rows = rowsOf(env).filter((r) => rowPeriod(r));
  rows.sort((a, b) => rowPeriod(b).localeCompare(rowPeriod(a)));
  const top = rows[0];
  return top ? { f: top.f, note: top.note } : null;
}
const rowNum = (row: { f: Record<string, Ev> } | null, field: string): number | null => (row ? num(row.f[field]?.value) : null);
const rowPeriod = (row: { f: Record<string, Ev> } | null, field: string): string => (row ? str(row.f[field]?.period) : "");

/**
 * 分位:低于当前值的样本占比(0~1)。
 * 🔴 只放**有效**样本:`peTTM > 0` 才进(亏损时 PE 为负,混进来会让分位完全失真)。
 */
function percentile(series: number[], v: number | null): number | null {
  const valid = series.filter((x) => Number.isFinite(x) && x > 0);
  if (v === null || !Number.isFinite(v) || v <= 0 || valid.length < MIN_PERCENTILE_POINTS) return null;
  return valid.filter((x) => x < v).length / valid.length;
}

/** 信封 → K 线全表行(OHLCV) */
async function klineOf(ctx: ServiceContext, symbol: string, refresh: boolean, p: Probe): Promise<KlineBar[]> {
  const f = await fetchOne(ctx, "tx_kline", symbol, { period: "day", count: 120 }, refresh, MAX_AGE.kline, p, "日 K");
  if (!f) return [];
  const rows = rawRows(ctx, f);
  if (!rows.length) {
    p.gaps.push("日 K 没有取到全表行(取数器没落盘 extracted 文件)");
    return [];
  }
  const bars: KlineBar[] = [];
  for (const row of rows) {
    const date = str(row.date).slice(0, 10);
    const open = num(row.open), high = num(row.high), low = num(row.low);
    const close = num(row.close), volume = num(row.volume);
    if (!date || close === null || close <= 0) continue;
    bars.push({ date, open: open ?? close, close, high: high ?? close, low: low ?? close, volume: volume ?? 0 });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  if (!bars.length) p.gaps.push("日 K 行里没有可用的收盘价");
  return bars;
}

/** 信封 → 当前行情。腾讯批量行情按 record_key 分组,字段名见 mappers_cn 的 _TX_SPECS */
async function quoteOf(ctx: ServiceContext, symbol: string, refresh: boolean, p: Probe): Promise<Quote | null> {
  const f = await fetchOne(ctx, "tx_quotes_batch", symbol, { codes: [symbol] }, refresh, MAX_AGE.kline, p, "行情");
  if (!f) return null;
  const row = rowsOf(f.env).find((x) => x.key === symbol || x.key.toLowerCase().endsWith(symbol));
  if (!row) {
    p.gaps.push("腾讯批量行情里没有这只代码");
    return null;
  }
  const q = row.f;
  const name = typeof q.security_name?.value === "string" && q.security_name.value ? q.security_name.value : "";
  const close = num(q.price?.value);
  if (close === null || close <= 0) {
    p.gaps.push("行情没给到现价");
    return null;
  }
  return {
    symbol,
    name: name || symbol,
    close,
    prev_close: num(q.last_close?.value) ?? close,
    pct_change: num(q.change_pct?.value) ?? 0,
    turnover: num(q.turnover_rate?.value) ?? 0,
    high: num(q.high?.value) ?? close,
    low: num(q.low?.value) ?? close,
    open: num(q.open?.value) ?? close,
    market_cap: num(q.market_cap?.value),
    pe: num(q.pe_ttm?.value),
  };
}

/** 估值位置:现值来自证据,分位来自全表行 */
async function valuationOf(ctx: ServiceContext, symbol: string, refresh: boolean, p: Probe): Promise<ValuationView | null> {
  const f = await fetchOne(ctx, "bs_valuation_history", symbol, undefined, refresh, MAX_AGE.valuation, p, "估值历史");
  if (!f) return null;
  const pe = scalarNum(f.env, "pe_ttm_latest");
  const pb = scalarNum(f.env, "pb_mrq_latest");
  const ps = scalarNum(f.env, "ps_ttm_latest");
  if (pe === null && pb === null) {
    p.gaps.push("估值历史里既没有 PE 也没有 PB");
    return null;
  }
  const rows = rawRows(ctx, f).filter((r) => str(r.tradestatus) !== "0");
  if (!rows.length) p.gaps.push("估值序列没读到全表行,分位算不了(现值仍然可用)");
  const pes = rows.map((r) => num(r.peTTM)).filter((x): x is number => x !== null);
  const pbs = rows.map((r) => num(r.pbMRQ)).filter((x): x is number => x !== null);
  const dates = rows.map((r) => str(r.date)).filter(Boolean).sort();
  return {
    as_of: str(scalar(f.env, "pe_ttm_latest")?.as_of) || str(scalar(f.env, "pe_ttm_latest")?.period) || (dates.at(-1) ?? ""),
    window: { from: dates[0] ?? "", to: dates.at(-1) ?? "", n: rows.length },
    pe_ttm: pe,
    pb,
    ps_ttm: ps,
    pe_percentile: percentile(pes, pe),
    pb_percentile: percentile(pbs, pb),
    basis: `过去 ${rows.length} 个交易日(已剔除停牌日);只算 PE>0 的样本(亏损期 PE 为负,混进来会失真)`,
    note: "PE/PB 取自 baostock 的 peTTM / pbMRQ,与东财、同花顺的算法不同,换口径不能和别处的读数比",
  };
}

/** 筹码分布(模型推算:三角分布 + 换手衰减) */
async function chipsOf(ctx: ServiceContext, symbol: string, refresh: boolean, p: Probe): Promise<ChipsView | null> {
  const f = await fetchOne(ctx, "bs_chip_distribution", symbol, undefined, refresh, MAX_AGE.chips, p, "筹码分布");
  if (!f) return null;
  const profit = scalarNum(f.env, "chip_profit_ratio");
  const avgCost = scalarNum(f.env, "chip_avg_cost");
  const priceRef = scalarNum(f.env, "chip_price_ref");
  if (profit === null && avgCost === null) {
    p.gaps.push("筹码分布里既没有获利比例也没有平均成本");
    return null;
  }
  const lo90 = scalarNum(f.env, "chip_cost_90_low"), hi90 = scalarNum(f.env, "chip_cost_90_high");
  const lo70 = scalarNum(f.env, "chip_cost_70_low"), hi70 = scalarNum(f.env, "chip_cost_70_high");
  const period = str(scalar(f.env, "chip_profit_ratio")?.period);
  const [from = "", to = ""] = period.split("..");
  const nText = /窗口\s*(\d+)\s*个交易日/.exec(str(scalar(f.env, "chip_profit_ratio")?.note));
  return {
    as_of: to || period,
    window: { from, to, n: nText ? Number(nText[1]) : null },
    profit_ratio: profit,
    avg_cost: avgCost,
    concentration_90: scalarNum(f.env, "chip_concentration_90"),
    cost_90: lo90 !== null && hi90 !== null ? [lo90, hi90] : null,
    cost_70: lo70 !== null && hi70 !== null ? [lo70, hi70] : null,
    peak_price: scalarNum(f.env, "chip_peak_price"),
    price_ref: priceRef,
    // 保留 1 位小数:这是给人看的百分比,浮点尾数(10.000000000000009)不该上屏
    above_avg_cost: priceRef !== null && avgCost !== null && avgCost > 0
      ? Math.round((priceRef / avgCost - 1) * 1000) / 10 : null,
    note: str(scalar(f.env, "chip_profit_ratio")?.note) || "三角分布 + 换手衰减模型推算,不是交易所数据",
  };
}

/**
 * 股东与事件。`em_holder_num` 便宜,一直在;质押 / 解禁 / 大宗 / 增减持只在 full 层取
 * (各自 4~10 秒,跟着页面打开就跑去太慢)。
 */
async function holdersOf(
  ctx: ServiceContext, symbol: string, refresh: boolean, depth: "basic" | "full", p: Probe,
): Promise<HoldersView | null> {
  const out: HoldersView = {
    as_of: null, shareholder_count: null, shareholder_count_change_pct: null,
    pledge_ratio: null, pledge_as_of: null,
    lockup_upcoming: null, lockup_window: null,
    block_trade_count: null, block_trade_latest: null,
    holder_trade_latest: null,
  };
  const numf = await fetchOne(ctx, "em_holder_num", symbol, undefined, refresh, MAX_AGE.holders, p, "股东户数");
  if (numf) {
    const row = latestRow(numf.env);
    out.shareholder_count = rowNum(row, "shareholder_count");
    out.shareholder_count_change_pct = rowNum(row, "shareholder_count_change_pct");
    out.as_of = rowPeriod(row, "shareholder_count") || null;
  }
  if (depth === "basic") return out.shareholder_count !== null ? out : null;

  const [pledge, lockup, block, trades] = await Promise.all([
    fetchOne(ctx, "equity_pledge", symbol, undefined, refresh, MAX_AGE.events, p, "股权质押"),
    fetchOne(ctx, "em_lockup_expiry", symbol, undefined, refresh, MAX_AGE.events, p, "限售解禁"),
    fetchOne(ctx, "em_block_trade", symbol, undefined, refresh, MAX_AGE.events, p, "大宗交易"),
    fetchOne(ctx, "holder_trades", symbol, undefined, refresh, MAX_AGE.events, p, "股东增减持"),
  ]);

  if (pledge) {
    const row = latestRow(pledge.env);
    out.pledge_ratio = rowNum(row, "pledge_ratio");
    out.pledge_as_of = rowPeriod(row, "pledge_ratio") || null;
  }
  if (lockup) {
    // 0 批 和「没取到」是两件事:前者是确切结论,后者是 null
    out.lockup_upcoming = scalarNum(lockup.env, "lockup_upcoming_count");
    out.lockup_window = str(scalar(lockup.env, "lockup_upcoming_count")?.period) || null;
  }
  if (block) {
    out.block_trade_count = scalarNum(block.env, "block_trade_count");
    const row = latestRow(block.env);
    if (row) {
      out.block_trade_latest = {
        date: rowPeriod(row, "block_trade_price"),
        // 🔴 只放折价率(无量纲),金额和成交量**不显示**:这两个字段的 unit 标成 万股/万元,
        //    但数值是 股/元(用 price×volume 核对过,差 1e4)。标注错了就不该上屏,待修 mapper。
        premium_pct: rowNum(row, "block_trade_premium_pct"),
      };
    }
  }
  if (trades) {
    const row = latestRow(trades.env);
    if (row) {
      // note 形如「股东名;增持;二级市场;起~止」,方向和区间都在里面
      const parts = row.note.split(";");
      const dir = parts[1]?.trim() ?? "";
      out.holder_trade_latest = {
        date: rowPeriod(row, "holder_change_pct_total"),
        direction: /增持|减持/.test(dir) ? dir : "增减持",
        change_pct: rowNum(row, "holder_change_pct_total"),
      };
    }
  }
  return out;
}

// ─── 规则引擎 ──────────────────────────────────────────────

function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const s = closes.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}

/** 趋势:均线排列 + 价格相对均线 + 短期均线斜率 */
function trendScore(bars: KlineBar[]): { score: number; factors: string[] } {
  const closes = bars.map((b) => b.close);
  const latest = closes[closes.length - 1]!;
  const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20), ma60 = sma(closes, 60);
  let score = 50;
  const factors: string[] = [];
  if (ma5 !== null && ma10 !== null && ma20 !== null && ma60 !== null) {
    if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) { score += 20; factors.push("均线多头排列(5>10>20>60)"); }
    else if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) { score -= 20; factors.push("均线空头排列(5<10<20<60)"); }
    if (latest > ma5 && latest > ma10 && latest > ma20) { score += 10; factors.push("股价在 5/10/20 日均线之上"); }
    else if (latest < ma5 && latest < ma10 && latest < ma20) { score -= 10; factors.push("股价在 5/10/20 日均线之下"); }
  } else {
    factors.push(`均线不足 60 根(${closes.length} 根),排列未参与评分`);
  }
  if (closes.length >= 10) {
    const ago = sma(closes.slice(0, -5), 5);
    if (ma5 !== null && ago !== null) {
      if (ma5 > ago) { score += 5; factors.push("5 日均线向上"); }
      else if (ma5 < ago) { score -= 5; factors.push("5 日均线向下"); }
    }
  }
  return { score: Math.max(0, Math.min(100, score)), factors };
}

/** 量能:量比(最新 / 近 20 日均量)+ 量价配合 */
function volumeScore(bars: KlineBar[]): { score: number; factors: string[] } {
  if (bars.length < 21) return { score: 50, factors: ["量能样本不足 21 根,未参与评分"] };
  const vols = bars.map((b) => b.volume);
  const avg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const last = vols[vols.length - 1]!;
  const ratio = avg > 0 ? last / avg : 1;
  let score = 50;
  const factors: string[] = [];
  if (ratio > 1.5) { score += 15; factors.push(`放量至 20 日均量 ${ratio.toFixed(1)} 倍`); }
  else if (ratio < 0.7) { score -= 15; factors.push(`缩量至 20 日均量 ${ratio.toFixed(1)} 倍`); }
  else factors.push("成交量处于近期正常水平");
  const prev = bars[bars.length - 2]!.close;
  const chg = prev > 0 ? (bars[bars.length - 1]!.close - prev) / prev : 0;
  if (ratio > 1.2 && chg > 0) { score += 10; factors.push("放量上涨,量价配合"); }
  else if (ratio > 1.2 && chg < 0) { score -= 10; factors.push("放量下跌,警惕派发"); }
  else if (ratio < 0.7 && chg > 0) { score += 5; factors.push("缩量上涨,抛压不重"); }
  return { score: Math.max(0, Math.min(100, score)), factors };
}

/** 位置:近 60 日相对高低 + 近 20 日涨幅 */
function positionScore(bars: KlineBar[]): { score: number; factors: string[] } {
  if (bars.length < 61) return { score: 50, factors: [`位置样本不足 61 根(现有 ${bars.length} 根),未参与评分`] };
  const closes = bars.map((b) => b.close);
  const latest = closes[closes.length - 1]!;
  const win = closes.slice(-60);
  const hi = Math.max(...win), lo = Math.min(...win);
  let score = 50;
  const factors: string[] = [];
  if (hi > lo) {
    const pos = (latest - lo) / (hi - lo);
    if (pos > 0.8) { score -= 15; factors.push(`处于近 60 日区间的 ${(pos * 100).toFixed(0)}%(偏高)`); }
    else if (pos < 0.2) { score += 15; factors.push(`处于近 60 日区间的 ${(pos * 100).toFixed(0)}%(偏低)`); }
    else factors.push(`处于近 60 日区间的 ${(pos * 100).toFixed(0)}%`);
  }
  const ago20 = closes[closes.length - 21]!;
  const ret20 = ago20 > 0 ? ((latest / ago20 - 1) * 100) : 0;
  if (ret20 > 30) { score -= 10; factors.push(`近 20 日涨 ${ret20.toFixed(1)}%,留意回调`); }
  else if (ret20 < -20) { score += 10; factors.push(`近 20 日跌 ${Math.abs(ret20).toFixed(1)}%,跌幅已大`); }
  return { score: Math.max(0, Math.min(100, score)), factors };
}

// ─── 主力阶段 ──────────────────────────────────────────────

/**
 * 主力阶段判定。
 * 🔴 早期版本这一层是 LLM 多智能体(技术 / 情报 / 风险 / 决策)驱动的;本实现是**规则兜底**,
 *    只在量价与位置都明确时给出阶段,否则一律「观望」+ 低置信度 —— 不冒充模型的判断。
 *    接入 LLM 时把这里换成带 prompt 的调用即可,输出结构不变。
 * 🔴 样本不够时返回「数据不足」:样本不足仍给「洗盘」这类结论,等于把没有装成有。
 */
function mainCapital(
  t: number, v: number, p: number,
  ctx: { ratio: number; pct: number; ret20: number; turnover: number },
): MainCapitalStage {
  const avg = (t + v + p) / 3;
  const factors: string[] = [];
  if (ctx.ratio > 1.2) factors.push("近一日放量");
  else if (ctx.ratio < 0.8) factors.push("近一日缩量");
  if (ctx.turnover > 0) factors.push(`换手率 ${ctx.turnover.toFixed(2)}%`);

  if (t > 65 && ctx.ratio > 1.2 && ctx.ret20 > 8) {
    return { score: avg, stage: "主升", confidence: "中", advice: "趋势与量能配合,持有为主,跌破 5 日线再评估", factors: [...factors, "均线偏多", "放量上行"] };
  }
  if (p < 40 && ctx.ratio < 0.8 && Math.abs(ctx.pct) < 2) {
    return { score: avg, stage: "吸筹", confidence: "低", advice: "低位缩量横盘,只是像吸筹,不等同于启动", factors: [...factors, "位置偏低", "缩量整理"] };
  }
  if (ctx.ratio > 1.5 && ctx.pct < -2) {
    return { score: avg, stage: "出货", confidence: "中", advice: "放量下跌,先减仓观察", factors: [...factors, "放量下跌"] };
  }
  if (ctx.ratio < 0.9 && Math.abs(ctx.pct) < 2.5) {
    return { score: avg, stage: "洗盘", confidence: "中", advice: "缩量整理,方向未明,持股观望", factors: [...factors, "缩量整理"] };
  }
  return { score: avg, stage: "观望", confidence: "低", advice: "信号不明确,不据此操作", factors: [...factors, "量价与位置均无明确信号"] };
}

/** 样本不够时的阶段:**不判断**,并说清缺的是什么 */
function insufficientStage(why: string): MainCapitalStage {
  return {
    score: null, stage: "数据不足", confidence: "低",
    advice: "日 K 样本或行情没取全,这一栏不给判断;先把日 K 取全再看",
    factors: [why],
  };
}

// ─── 主入口 ────────────────────────────────────────────────

export async function analyzeStock(ctx: ServiceContext, symbol: string, opts: AnalyzeOpts = {}): Promise<StockAnalysisResult> {
  const code = /^\d{6}$/.test(symbol) ? symbol : symbol.replace(/^(?:sh|sz|bj)?/i, "");
  const refresh = opts.refresh === true;
  const depth: "basic" | "full" = opts.depth === "full" ? "full" : "basic";
  const p = newProbe();

  const [bars, quote, valuation, chips, holders] = await Promise.all([
    klineOf(ctx, code, refresh, p),
    quoteOf(ctx, code, refresh, p),
    valuationOf(ctx, code, refresh, p),
    chipsOf(ctx, code, refresh, p),
    holdersOf(ctx, code, refresh, depth, p),
  ]);

  const gaps = p.gaps;
  const sufficient = bars.length >= 61 && !!quote;
  if (!sufficient) gaps.push("数据不足以给出可信评分,以下读数请谨慎看待");

  const trend = trendScore(bars);
  const volume = volumeScore(bars);
  const position = positionScore(bars);

  const vols = bars.map((b) => b.volume);
  const avg = vols.length > 21 ? vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : 0;
  const ratio = avg > 0 ? (vols[vols.length - 1] ?? 0) / avg : 1;
  const closes = bars.map((b) => b.close);
  const ret20 = bars.length >= 21 && closes[closes.length - 21]! > 0
    ? ((closes[closes.length - 1]! / closes[closes.length - 21]!) - 1) * 100 : 0;

  // 样本不够就不给阶段:结论不能比数据走得远
  const mc = sufficient
    ? mainCapital(trend.score, volume.score, position.score, {
      ratio, pct: quote?.pct_change ?? 0, ret20, turnover: quote?.turnover ?? 0,
    })
    : insufficientStage(`日 K 只有 ${bars.length} 根(要 ≥61)、行情${quote ? "有" : "没取到"}`);

  const technicalScore = Math.round(trend.score * 0.4 + volume.score * 0.35 + position.score * 0.25);
  const composite = sufficient ? Math.round(technicalScore * 0.6 + (mc.score ?? 50) * 0.4) : null;

  return {
    symbol: code,
    name: quote?.name ?? code,
    composite,
    main_capital: mc,
    technical: {
      trend_score: trend.score,
      volume_score: volume.score,
      position_score: position.score,
      factors: [...trend.factors, ...volume.factors, ...position.factors, ...gaps].slice(0, 6),
    },
    kline_data: bars.slice(-60),
    quote,
    valuation,
    chips,
    holders,
    fetched_at: p.at.filter(Boolean).sort()[0] ?? new Date().toISOString(),
    from_cache: p.cached.length > 0,
    gaps,
    sufficient,
    depth,
  };
}
