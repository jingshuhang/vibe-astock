/**
 * 个股分析（本地规则引擎）—— 主力行为阶段 + 技术面三维评分
 *
 * 🔴 取数全部走 Vibe-AStock 自己的端点(不新增数据源):
 *   · `tx_kline`        日 K(前复权)→ 全表行在取数器落盘的 raw/extracted_*.json 里,含 OHLCV
 *   · `tx_quotes_batch` 腾讯批量行情 → 现价 / 涨跌幅 / 换手率 / 开高低 / 昨收 / 名称
 * 🔴 代码**原样传**:个股 000001 就是平安银行;只有指数才带 sh/sz 前缀(见 registry notes)。
 *   给个股加 `sh` 前缀会取回上证指数,数字完全合理、看不出异常 —— 之前正是这么错的。
 * 🔴 取不到的数据如实写成 gaps,不当成 0、也不假装评分可信。
 */
import { fetchEndpoint, type ServiceContext } from "../service.ts";
import { readRawDoc } from "./candidates.ts";
import { rowsOf } from "./schedule.ts";

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
  score: number;
  stage: "吸筹" | "洗盘" | "主升" | "出货" | "观望";
  confidence: string;
  advice: string;
  factors: string[];
}

export interface StockAnalysisResult {
  symbol: string;
  name: string;
  composite: number;
  main_capital: MainCapitalStage;
  technical: TechnicalFactors;
  /** 日 K(近 60 根),给前端画 / 复核用 */
  kline_data: KlineBar[];
  quote: Quote | null;
  /** 取不到或算不出的项,如实列出 —— 不算成 0,也不假装评分可信 */
  gaps: string[];
  /** 数据够不够支撑评分;false 时界面应弱化读数 */
  sufficient: boolean;
}

// ─── 取数 ──────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 信封 → K 线全表行(OHLCV)。信封里只有最后一根的字段,全表要读 raw/extracted_ */
async function klineOf(ctx: ServiceContext, symbol: string, gaps: string[]): Promise<KlineBar[]> {
  let r: Awaited<ReturnType<typeof fetchEndpoint>>;
  try {
    r = await fetchEndpoint(ctx, { endpoint: "tx_kline", symbol, args: { period: "day", count: 120 } });
  } catch (e) {
    gaps.push(`日 K 取数失败:${e instanceof Error ? e.message.slice(0, 60) : "未知原因"}`);
    return [];
  }
  const evs = (r.envelope as { evidence?: { raw_ref?: unknown }[] }).evidence ?? [];
  const ref = evs.map((e) => (typeof e.raw_ref === "string" ? e.raw_ref : "")).find((x) => x.startsWith("raw/extracted_"));
  const doc = ref ? (readRawDoc(ctx, r.out_dir, ref) as { rows?: unknown } | null) : null;
  const rows = Array.isArray(doc?.rows) ? (doc!.rows as Record<string, unknown>[]) : [];
  if (!rows.length) {
    gaps.push("日 K 没有取到全表行(取数器没落盘 extracted 文件)");
    return [];
  }
  const bars: KlineBar[] = [];
  for (const row of rows) {
    const date = typeof row.date === "string" ? row.date.slice(0, 10) : "";
    const open = num(row.open), high = num(row.high), low = num(row.low);
    const close = num(row.close), volume = num(row.volume);
    if (!date || close === null || close <= 0) continue;
    bars.push({ date, open: open ?? close, close, high: high ?? close, low: low ?? close, volume: volume ?? 0 });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  if (!bars.length) gaps.push("日 K 行里没有可用的收盘价");
  return bars;
}

/** 信封 → 当前行情。腾讯批量行情按 record_key 分组,字段名见 mappers_cn 的 _TX_SPECS */
async function quoteOf(ctx: ServiceContext, symbol: string, gaps: string[]): Promise<Quote | null> {
  let r: Awaited<ReturnType<typeof fetchEndpoint>>;
  try {
    r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: [symbol] } });
  } catch (e) {
    gaps.push(`行情取数失败:${e instanceof Error ? e.message.slice(0, 60) : "未知原因"}`);
    return null;
  }
  const row = rowsOf(r.envelope).find((x) => x.key === symbol || x.key.toLowerCase().endsWith(symbol));
  if (!row) {
    gaps.push("腾讯批量行情里没有这只代码");
    return null;
  }
  const f = row.f;
  const name = typeof f.security_name?.value === "string" && f.security_name.value ? f.security_name.value : "";
  const close = num(f.price?.value);
  if (close === null || close <= 0) {
    gaps.push("行情没给到现价");
    return null;
  }
  return {
    symbol,
    name: name || symbol,
    close,
    prev_close: num(f.last_close?.value) ?? close,
    pct_change: num(f.change_pct?.value) ?? 0,
    turnover: num(f.turnover_rate?.value) ?? 0,
    high: num(f.high?.value) ?? close,
    low: num(f.low?.value) ?? close,
    open: num(f.open?.value) ?? close,
    market_cap: num(f.market_cap?.value),
    pe: num(f.pe_ttm?.value),
  };
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

// ─── 主入口 ────────────────────────────────────────────────

export async function analyzeStock(ctx: ServiceContext, symbol: string): Promise<StockAnalysisResult> {
  const code = /^\d{6}$/.test(symbol) ? symbol : symbol.replace(/^(?:sh|sz|bj)?/i, "");
  const gaps: string[] = [];

  const [bars, quote] = await Promise.all([klineOf(ctx, code, gaps), quoteOf(ctx, code, gaps)]);

  const trend = trendScore(bars);
  const volume = volumeScore(bars);
  const position = positionScore(bars);
  const sufficient = bars.length >= 61 && !!quote;
  if (!sufficient) gaps.push("数据不足以给出可信评分,以下读数请谨慎看待");

  const vols = bars.map((b) => b.volume);
  const avg = vols.length > 21 ? vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : 0;
  const ratio = avg > 0 ? (vols[vols.length - 1] ?? 0) / avg : 1;
  const closes = bars.map((b) => b.close);
  const ret20 = bars.length >= 21 && closes[closes.length - 21]! > 0
    ? ((closes[closes.length - 1]! / closes[closes.length - 21]!) - 1) * 100 : 0;

  const mc = mainCapital(trend.score, volume.score, position.score, {
    ratio, pct: quote?.pct_change ?? 0, ret20, turnover: quote?.turnover ?? 0,
  });

  const technicalScore = Math.round(trend.score * 0.4 + volume.score * 0.35 + position.score * 0.25);
  const composite = sufficient ? Math.round(technicalScore * 0.6 + mc.score * 0.4) : 50;

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
    gaps,
    sufficient,
  };
}
