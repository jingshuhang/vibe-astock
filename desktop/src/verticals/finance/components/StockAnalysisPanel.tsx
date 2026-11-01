/**
 * 个股分析卡片 — 六域读数(本地规则引擎)
 *
 * 行情 / 日 K 技术面 / 估值分位 / 筹码 / 股东与事件,全部由 Vibe-AStock 自己的端点算,不依赖外部服务。
 * 按需触发的深度研判,不自动轮询。
 *
 * 🔴 「刷新」必须把 refresh 真传给后端:以前这个按钮只是把同一个请求再发一遍,
 *    命中的还是上次的快照(日 K 没有声明缓存上限时那份快照永不过期,读到过四天前的数据)。
 * 🔴 每个区块都带**数据日**与**口径**:筹码是模型推算、PE 分位是 baostock 口径,
 *    换个地方看就不是同一个数字,所以 note 必须跟着数一起上屏。
 * 🔴 `composite === null` / `stage === "数据不足"` 时**不给结论**:那一刻界面要说「不下判断」,
 *    不能画一条 0 分的进度条,也不能把 50 分当读数。
 * 🔴 慢端点(质押 / 解禁 / 大宗 / 增减持)各自 4~10 秒,放在「取更全」后面点一下才取 ——
 *    打开页面就全取会让这张卡等十几秒。
 *
 * 结构:`StockAnalysisPanel` 只管取数与工具栏,数据到手后交给 `StockAnalysisBody` 画 ——
 * 拆开是为了能用静态 HTML 断言「数据不足时页面到底显示了什么」(见 desktop/test/stock_analysis_view.test.ts)。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Database, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import type { StockAnalysisResult } from "@/lib/stockAnalysis";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

// ─── 格式化 ────────────────────────────────────────────────

/** 取数时刻(后端给 ISO,这里按本机时区显示到分钟) */
function fmtAt(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 已经是百分数的值(涨跌幅 / 质押比例 / 折价率) */
const pct = (v: number | null, d = 1): string => (v === null ? "—" : `${v.toFixed(d)}%`);
/** 0~1 的小数(分位 / 获利比例 / 集中度) */
const frac = (v: number | null, d = 1): string => (v === null ? "—" : `${(v * 100).toFixed(d)}%`);
const price = (v: number | null): string => (v === null ? "—" : v.toFixed(2));
const cnNum = (v: number | null): string => (v === null ? "—" : v.toLocaleString("zh-CN"));
/** 元 → 「+12.36 亿」/「-8400 万」;空值给「—」,不写成 0 */
function yi(v: number | null): string {
  if (v === null) return "—";
  const a = Math.abs(v);
  return `${v < 0 ? "-" : "+"}${a >= 1e8 ? `${(a / 1e8).toFixed(2)} 亿` : `${(a / 1e4).toFixed(0)} 万`}`;
}
/** A 股习惯:净流入红、净流出绿(和涨跌幅一致) */
const flowTone = (v: number | null): string => (v === null ? "" : v >= 0 ? "text-danger" : "text-success");

// ─── 小组件 ────────────────────────────────────────────────

function ScoreBar({ value, label, dim }: { value: number; label: string; dim?: boolean }) {
  const pctv = Math.max(0, Math.min(100, value));
  const tone = dim
    ? "text-muted-foreground"
    : pctv >= 70 ? "text-danger" : pctv >= 40 ? "text-warning" : "text-success";
  const fill = dim
    ? "bg-muted-foreground/30"
    : pctv >= 70 ? "bg-danger" : pctv >= 40 ? "bg-warning" : "bg-success";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-mono font-semibold", tone)}>{dim ? "—" : value}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted/40">
        <div className={cn("h-full rounded-full transition-all", fill)} style={{ width: `${dim ? 0 : pctv}%` }} />
      </div>
    </div>
  );
}

function StageBadge({ stage, confidence }: { stage: string; confidence: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    "吸筹": { cls: "bg-success/15 text-success border-success/30", label: "吸筹中" },
    "洗盘": { cls: "bg-warning/15 text-warning border-warning/30", label: "洗盘中" },
    "主升": { cls: "bg-danger/15 text-danger border-danger/30", label: "主升浪" },
    "出货": { cls: "bg-muted text-muted-foreground border-border", label: "出货中" },
    // 「数据不足」与「观望」都是**中性**状态,不能借用洗盘/出货的配色去暗示方向
    "数据不足": { cls: "bg-muted text-muted-foreground border-border", label: "数据不足" },
    "观望": { cls: "bg-muted text-muted-foreground border-border", label: "观望" },
  };
  const s = map[stage] ?? { cls: "bg-muted text-muted-foreground border-border", label: stage };
  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", s.cls)}>
      <Activity className="h-3 w-3" />
      <span className="font-medium">{s.label}</span>
      {stage !== "数据不足" && confidence !== "高" && <span className="text-[10px] opacity-70">· 置信{confidence}</span>}
    </div>
  );
}

/** 资金面方向徽章:同向才算有方向,两个窗口打架就叫分歧 */
function FlowBadge({ trend }: { trend: string }) {
  const m: Record<string, string> = {
    "净流入": "bg-danger/15 text-danger border-danger/30",
    "净流出": "bg-success/15 text-success border-success/30",
    "分歧": "bg-muted text-muted-foreground border-border",
    "样本不足": "bg-muted text-muted-foreground border-border",
  };
  return (
    <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-medium", m[trend] ?? m["分歧"])}>
      {trend}
    </span>
  );
}

/** 一行「标签 — 值」;`hint` 给口径,跟在值后面灰字 */
function KV({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1.5 text-right">
        <span className={cn("font-mono font-semibold text-foreground", tone)}>{value}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}

/** 分位条:0(历史最低)~1(历史最高)。只表示位置,不表示好坏 */
function PercentileBar({ value }: { value: number | null }) {
  if (value === null) return <div className="h-1.5 w-full rounded-full bg-muted/40" />;
  const w = Math.max(2, Math.min(100, value * 100));
  const fill = value >= 0.7 ? "bg-danger" : value <= 0.3 ? "bg-success" : "bg-warning";
  return (
    <div className="h-1.5 w-full rounded-full bg-muted/40">
      <div className={cn("h-full rounded-full transition-all", fill)} style={{ width: `${w}%` }} />
    </div>
  );
}

function Block({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-border/50 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
        {sub && <span className="text-[10px] text-muted-foreground/80">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[10px] leading-4 text-muted-foreground/80">{children}</p>;
}

// ─── 展示层(拿数据就画,不取数) ────────────────────────────

export function StockAnalysisBody({ data }: { data: StockAnalysisResult }) {
  /** 数据不够支撑评分:读数一律弱化,不给结论 */
  const dim = data.sufficient === false;
  const full = data.depth === "full";

  return (
    <div className="space-y-4">
      {/* 数据日 + 现价:下面的每个数都要能对上「这是什么时候的事实」 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>数据截至 {fmtAt(data.fetched_at)}</span>
        {data.from_cache && <span className="text-warning">· 部分读数来自快照</span>}
        <span>· {full ? "含质押/解禁/大宗/增减持" : "基础层"}</span>
        {data.quote && (
          <span className="font-mono">
            · 现价 {price(data.quote.close)}
            <span className={data.quote.pct_change >= 0 ? "text-danger" : "text-success"}>
              {` ${data.quote.pct_change >= 0 ? "+" : ""}${data.quote.pct_change.toFixed(2)}%`}
            </span>
            {` · 换手 ${data.quote.turnover.toFixed(2)}%`}
          </span>
        )}
      </div>

      {data.gaps.length > 0 && (
        <div className={cn("rounded-lg border px-3 py-2",
          dim ? "border-warning/30 bg-warning/[0.06]" : "border-border/50 bg-muted/20")}>
          <p className={cn("text-[11px] font-medium", dim ? "text-warning" : "text-muted-foreground")}>
            {dim ? "数据不足,评分与阶段不作数,下面只列读数" : `有几项没取到（${data.gaps.length}）`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {data.gaps.map((g, i) => (
              <li key={i} className="text-[11px] leading-4 text-muted-foreground">• {g}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 综合评分 + 主力阶段 */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-lg border border-border/50 px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground">综合评分</p>
          {data.composite === null ? (
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-muted-foreground">不下判断</span>
              <span className="text-xs text-muted-foreground">样本不足</span>
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className={cn("font-mono text-2xl font-bold",
                data.composite >= 70 ? "text-danger" : data.composite >= 40 ? "text-warning" : "text-success")}>
                {data.composite}
              </span>
              <span className="text-xs text-muted-foreground">/ 100</span>
            </div>
          )}
          <div className="mt-2 space-y-2">
            <ScoreBar value={data.technical.trend_score} label="趋势" dim={dim} />
            <ScoreBar value={data.technical.volume_score} label="量能" dim={dim} />
            <ScoreBar value={data.technical.position_score} label="位置" dim={dim} />
          </div>
          {dim && <Note>日 K 不满 61 根时,这三项按中性 50 占位,不代表读数 —— 所以不给总分。</Note>}
        </div>

        <div className="space-y-2 rounded-lg border border-border/50 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">主力行为</p>
            {data.main_capital.score !== null && (
              <span className="font-mono text-[11px] text-muted-foreground">均值 {Math.round(data.main_capital.score)}</span>
            )}
          </div>
          <StageBadge stage={data.main_capital.stage} confidence={data.main_capital.confidence} />
          <p className="mt-2 text-xs leading-5 text-foreground">{data.main_capital.advice}</p>
          {data.main_capital.factors.length > 0 && (
            <div className="mt-2 space-y-1">
              {data.main_capital.factors.slice(0, 4).map((f, i) => (
                <p key={i} className="text-[11px] leading-4 text-muted-foreground">• {f}</p>
              ))}
            </div>
          )}
          {data.main_capital.stage !== "数据不足" && data.money === null && (
            <Note>
              判定依据只有量价与位置（日 K + 行情），这次没取到资金流 —— 所以这里的「主力」是量价代理，
              不是真有资金流向的证据。
            </Note>
          )}
        </div>
      </div>

      {/* 技术面因子 */}
      {data.technical.factors.length > 0 && (
        <div className="rounded-lg border border-border/50 px-3 py-2.5">
          <p className="mb-2 text-[11px] font-medium text-muted-foreground">技术信号</p>
          <div className="space-y-1">
            {data.technical.factors.map((f, i) => (
              <p key={i} className="text-xs leading-5 text-foreground">• {f}</p>
            ))}
          </div>
        </div>
      )}

      {/* 资金流向:这是真的钱,不是量价代理 */}
      <Block title="资金流向" sub={data.money ? `截至 ${data.money.as_of} · ${data.money.window.n} 个交易日` : undefined}>
        {data.money ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">主力净流入(大单 + 特大单)</span>
              <FlowBadge trend={data.money.trend} />
            </div>
            <KV label="今日" value={yi(data.money.net_1d)} tone={flowTone(data.money.net_1d)} />
            <KV label="近 5 日" value={yi(data.money.net_5d)} tone={flowTone(data.money.net_5d)} />
            <KV label="近 20 日" value={yi(data.money.net_20d)} tone={flowTone(data.money.net_20d)} />
            <KV label="连续"
              value={data.money.streak === 0 ? "—" : `${Math.abs(data.money.streak)} 日${data.money.streak > 0 ? "净流入" : "净流出"}`}
              tone={data.money.streak === 0 ? "" : flowTone(data.money.streak)} />
            {data.money.big_order_5d !== null && (
              <KV label="超大单 5 日" value={yi(data.money.big_order_5d)} tone={flowTone(data.money.big_order_5d)} />
            )}
            <Note>{data.money.note}</Note>
          </>
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">没取到资金流序列,这一栏空着（不当成 0）</p>
        )}
      </Block>

      {/* 估值 + 筹码 */}
      <div className="grid gap-3 md:grid-cols-2">
        <Block title="估值位置" sub={data.valuation ? `截至 ${data.valuation.as_of || "—"}` : undefined}>
          {data.valuation ? (
            <>
              <KV label="PE(TTM)" value={price(data.valuation.pe_ttm)}
                hint={data.valuation.pe_percentile === null ? "分位算不了" : `历史分位 ${frac(data.valuation.pe_percentile, 0)}`} />
              <PercentileBar value={data.valuation.pe_percentile} />
              <KV label="PB(MRQ)" value={price(data.valuation.pb)}
                hint={data.valuation.pb_percentile === null ? "分位算不了" : `历史分位 ${frac(data.valuation.pb_percentile, 0)}`} />
              <PercentileBar value={data.valuation.pb_percentile} />
              <KV label="PS(TTM)" value={price(data.valuation.ps_ttm)} />
              <Note>
                {data.valuation.window.n} 个交易日（{data.valuation.window.from || "—"} ~ {data.valuation.window.to || "—"}）。
                {data.valuation.basis}
              </Note>
              <Note>{data.valuation.note}</Note>
            </>
          ) : (
            <p className="text-[11px] leading-4 text-muted-foreground">没取到估值序列,分位与现值都空着（不当成 0）</p>
          )}
        </Block>

        <Block title="筹码分布" sub={data.chips ? `截至 ${data.chips.as_of || "—"}` : undefined}>
          {data.chips ? (
            <>
              <KV label="获利比例" value={frac(data.chips.profit_ratio)} />
              <KV label="平均成本" value={price(data.chips.avg_cost)} hint="元" />
              <KV label="现价 vs 平均成本" value={pct(data.chips.above_avg_cost)}
                tone={data.chips.above_avg_cost === null ? undefined
                  : data.chips.above_avg_cost >= 0 ? "text-danger" : "text-success"} />
              <KV label="90% 成本区间"
                value={data.chips.cost_90 ? `${price(data.chips.cost_90[0])} ~ ${price(data.chips.cost_90[1])}` : "—"} />
              <KV label="90% 集中度" value={frac(data.chips.concentration_90, 2)} hint="越小越集中" />
              {data.chips.peak_price !== null && <KV label="筹码峰" value={price(data.chips.peak_price)} hint="元" />}
              <Note>{data.chips.note}</Note>
            </>
          ) : (
            <p className="text-[11px] leading-4 text-muted-foreground">没取到筹码分布</p>
          )}
        </Block>
      </div>

      {/* 股东与事件 */}
      <Block title="股东与事件" sub={data.holders?.as_of ? `户数截至 ${data.holders.as_of}` : undefined}>
        {data.holders ? (
          <>
            <KV label="股东户数" value={cnNum(data.holders.shareholder_count)}
              hint={data.holders.shareholder_count_change_pct === null ? undefined
                : `环比 ${pct(data.holders.shareholder_count_change_pct, 2)}`} />
            {full ? (
              <>
                <KV label="质押比例" value={pct(data.holders.pledge_ratio, 2)}
                  hint={data.holders.pledge_as_of ?? undefined} />
                {/* 0 批 = 窗口内确实没有;没取到才是「—」。两者不能显示成同一个东西 */}
                <KV label="未来待解禁"
                  value={data.holders.lockup_upcoming === null ? "—" : `${data.holders.lockup_upcoming} 批`}
                  hint={data.holders.lockup_window ?? undefined} />
                <KV label="大宗交易" value={data.holders.block_trade_count === null ? "—" : `${data.holders.block_trade_count} 笔`}
                  hint={data.holders.block_trade_latest
                    // 用中性的「溢价率」:负数是折价、正数是溢价、0 就是按收盘价成交,别一律写成「折价」
                    ? `${data.holders.block_trade_latest.date} 溢价率 ${pct(data.holders.block_trade_latest.premium_pct)}`
                      + ` · 成交 ${yi(data.holders.block_trade_latest.amount)}`
                    : undefined} />
                <KV label="最近增减持"
                  value={data.holders.holder_trade_latest
                    ? `${data.holders.holder_trade_latest.direction} ${pct(data.holders.holder_trade_latest.change_pct, 2)}`
                    : "—"}
                  hint={data.holders.holder_trade_latest?.date} />
                <Note>大宗成交量按股、成交额按元(上游早期标成万股/万元,差 1e4,已修正并回归)。</Note>
              </>
            ) : (
              <Note>质押 / 解禁 / 大宗 / 增减持按需取（点右上角「取更全」）,各自 4~10 秒。</Note>
            )}
          </>
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">没取到股东户数</p>
        )}
      </Block>

      <p className="text-[10px] leading-4 text-muted-foreground/80">
        按需计算的规则引擎读数,不自动轮询;筹码为模型推算、估值分位为 baostock 口径。以上为客观读数与条件记录,不构成投资建议,不替你做决定。
      </p>
    </div>
  );
}

// ─── 主组件(取数 + 工具栏) ────────────────────────────────

export function StockAnalysisPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<StockAnalysisResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  /** 上一次选的深度:换个代码重算时沿用(深度是用户的偏好,不是这份数据的属性) */
  const depthRef = useRef<"basic" | "full">("basic");

  const load = useCallback(async (o: { depth: "basic" | "full"; refresh?: boolean; clear?: boolean }) => {
    const my = ++seq.current;
    depthRef.current = o.depth;
    setLoading(true);
    setError("");
    // 只有「换股票」才清屏:上一只的读数不能留在屏上;刷新 / 取更全要保留旧数据直到新数据回来
    if (o.clear) setData(null);
    try {
      const r = await backend.stockAnalysis(symbol, { refresh: o.refresh === true, depth: o.depth });
      if (my !== seq.current) return;
      setData(r);
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    void load({ depth: depthRef.current, clear: true });
    return () => { seq.current++; };
  }, [load]);

  if (!symbol) return null;

  const depth = data?.depth ?? depthRef.current;

  return (
    <GlassCard className="mb-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4 text-primary" />
          个股分析（本地引擎）
        </h3>
        <div className="flex items-center gap-1.5">
          {depth === "basic" && (
            <button
              type="button"
              onClick={() => void load({ depth: "full" })}
              disabled={loading}
              className={BTN}
              title="再取质押 / 解禁 / 大宗 / 增减持（各自 4~10 秒）"
            >
              <Database className="h-3.5 w-3.5" /> 取更全
            </button>
          )}
          <button
            type="button"
            onClick={() => void load({ depth, refresh: true })}
            disabled={loading}
            className={BTN}
            title="全部重取（不读快照）"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 刷新
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        行情 · 日 K 技术面 · 估值分位 · 筹码 · 股东与事件，六域读数各自带数据日与口径。
      </p>

      {error && <p role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
      {loading && !data && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在分析 {symbol}…</span>
        </div>
      )}

      {data && <StockAnalysisBody data={data} />}
    </GlassCard>
  );
}
