/**
 * 个股分析(本地规则引擎)的界面数据(后端见 orchestrator/src/finance/stock_analysis.ts)。
 *
 * 🔴 这份结构里**没有「猜」出来的数**:每个域都带自己的 `as_of`(数据日)和 `note`(口径),
 *    取不到就是 `null`,不是 0、也不是 50 分。
 * 🔴 `composite` / `main_capital.score` 可为 `null`:样本不够时后端**不给结论**,
 *    界面必须显示「不下判断」,不能把 null 当成 0 画成一条到底的进度条。
 * 🔴 筹码是**模型推算**、估值分位是 baostock 口径,换到别处看就不一定是同一个数字 ——
 *    `note` 要跟着数一起上屏,不能只留数、把口径丢掉。
 */
export interface StockAnalysisQuote {
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

export interface StockAnalysisKlineBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface StockTechnical {
  trend_score: number;
  volume_score: number;
  position_score: number;
  factors: string[];
}

/** 「数据不足」是**状态**不是结论:样本不够时后端一律用它,不拿观望/洗盘顶上 */
export type MainCapitalStageName = "吸筹" | "洗盘" | "主升" | "出货" | "观望" | "数据不足";

export interface StockMainCapital {
  /** 数据不足时为 null(不是给 50 凑数) */
  score: number | null;
  stage: MainCapitalStageName;
  confidence: string;
  advice: string;
  factors: string[];
}

/** 估值位置:贵不贵只能靠分位回答,现值本身没有参照物 */
export interface StockValuation {
  as_of: string;
  window: { from: string; to: string; n: number };
  pe_ttm: number | null;
  pb: number | null;
  ps_ttm: number | null;
  /** 低于当前值的交易日占比(0~1);样本不足或当前值无效时为 null */
  pe_percentile: number | null;
  pb_percentile: number | null;
  basis: string;
  note: string;
}

/** 筹码分布:**模型推算**,不是交易所数据 */
export interface StockChips {
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

/** 股东与事件:谁在买、谁可能要卖。full 层才有质押 / 解禁 / 大宗 / 增减持 */
export interface StockHolders {
  as_of: string | null;
  shareholder_count: number | null;
  shareholder_count_change_pct: number | null;
  pledge_ratio: number | null;
  pledge_as_of: string | null;
  /** 0 批 与「没取到」是两件事:前者是确切结论,后者是 null */
  lockup_upcoming: number | null;
  lockup_window: string | null;
  block_trade_count: number | null;
  /** 只给折价率(无量纲):金额与成交量的 unit 在后端标错了,标注错了就不该上屏 */
  block_trade_latest: { date: string; premium_pct: number | null } | null;
  holder_trade_latest: { date: string; direction: string; change_pct: number | null } | null;
}

export interface StockAnalysisResult {
  symbol: string;
  name: string;
  /** 数据不足时为 null —— 不拿 50 分凑数 */
  composite: number | null;
  main_capital: StockMainCapital;
  technical: StockTechnical;
  /** 日 K(近 60 根) */
  kline_data: StockAnalysisKlineBar[];
  quote: StockAnalysisQuote | null;
  valuation: StockValuation | null;
  chips: StockChips | null;
  holders: StockHolders | null;
  /** 各域取数时刻里最早的那个:整份结论最早是这个时点的事实 */
  fetched_at: string;
  /** 有域读的是快照(不是这次真取的) */
  from_cache: boolean;
  gaps: string[];
  /** 数据够不够支撑评分;false 时界面必须弱化读数、不给结论 */
  sufficient: boolean;
  depth: "basic" | "full";
}

/** 取数选项:`refresh` = 用户点了「刷新」,后端必须真取、不许读快照 */
export interface StockAnalysisOpts {
  refresh?: boolean;
  depth?: "basic" | "full";
}
