import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import { useMarketAutoRefresh } from "@/hooks/useMarketAutoRefresh";
import { isMarketTrading } from "@/lib/marketSymbol";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";
import { emptyOpportunityHint, type ShortlineOpportunityResult } from "@/lib/shortlineOpportunities";
import type { OpportunityTrackResult } from "@/lib/shortlineOpportunityTrack";
import type { IntradayResult, WatchView } from "../shortline/watchTypes";
import { verifyOpportunities, type OppCall, type VerifyFlow } from "../shortline/opportunityVerify";
import { PRIOR, type PatternCategory, type Regime, type RescoreResult } from "../shortline/patternPrior";
import type { LampTone } from "../shortline/intradayVerdict";
import type { SamplesResult } from "../shortline/viewTypes";
import {
  buildCounterTrend, counterTrendSummary, CT_MIN_SAMPLE, CT_MIN_WIN_RATE,
  type CounterTrendResult,
} from "../shortline/counterTrend";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
const pctColor = (p: number | null | undefined) =>
  p == null ? "text-muted-foreground/40" : p > 0 ? "text-danger" : p < 0 ? "text-success" : "text-muted-foreground";
const fmt = (v: number | null, digits = 2) => v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const pctText = (v: number | null | undefined, digits = 2) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;

const RISK_COLOR = { 低: "text-success", 中: "text-warning", 高: "text-danger" } as const;
const PATTERN_COLOR = {
  "首板爆发": "text-blue-400",
  "弱转强": "text-green-400",
  "分歧转一致": "text-purple-400",
  "N字反包": "text-amber-400",
  "龙头接力": "text-red-400",
} as const;

/** 裁决档位不用红绿（红绿在 A 股语义是涨跌），跟盯盘判断条同一套色 */
const CALL_STYLE: Record<OppCall, string> = {
  支持: "border-primary/40 bg-primary/10 text-primary",
  观察: "border-border/60 bg-muted/20 text-muted-foreground",
  降级: "border-info/40 bg-info/10 text-info",
  回避: "border-warning/45 bg-warning/10 text-warning",
};
const GATE_TONE: Record<LampTone, string> = {
  danger: "border-warning/45 bg-warning/[0.07] text-warning",
  warning: "border-info/40 bg-info/[0.06] text-info",
  ok: "border-primary/35 bg-primary/[0.05] text-primary",
  unknown: "border-border/60 bg-muted/[0.12] text-muted-foreground",
};
const HEAD_TONE: Record<LampTone, string> = {
  danger: "text-warning", warning: "text-info", ok: "text-primary", unknown: "text-muted-foreground",
};

/** 验证流区块:总裁决 + 佐证清单(每条带来源页)+ 裁决计数。导出是为了测试能直接喂 VerifyFlow 断言文案 */
export function VerifyCard({ v, loading, why }: { v: VerifyFlow | null; loading: boolean; why: string | null }) {
  return (
    <GlassCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4" />验证流 · 盯盘三页的结论盖到清单上
        </h2>
        {loading && <span className="text-[11px] text-muted-foreground">佐证取数中…</span>}
      </div>
      {!v && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {why ?? "佐证还没回来;清单先按模式置信度排。"}
        </p>
      )}
      {v && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[11px] text-muted-foreground">现在做不做</span>
              <b className={cn("text-lg font-bold", HEAD_TONE[v.tone])}>{v.head}</b>
            </div>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{v.note}</p>
          </div>
          <ul className="space-y-1.5">
            {v.gates.map((g) => (
              <li key={g.key} className={cn("rounded-lg border px-3 py-2 text-[12px]", GATE_TONE[g.tone])}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">{g.from}</span>
                  <b>{g.label}</b>
                  <span className="font-mono tabular-nums">{g.read}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{g.why}</p>
              </li>
            ))}
            {v.gates.length === 0 && <li className="text-[12px] text-muted-foreground">三页佐证一条都没取到,这里不猜。</li>}
          </ul>
          <p className="text-[12px] text-muted-foreground">
            裁决:<b className="text-primary">{v.counts.支持} 支持</b> · {v.counts.观察} 观察 · {v.counts.降级} 降级 · {v.counts.回避} 回避。
            <span className="ml-1 text-[11px]">档位说的是「环境对这个模式的态度」,不是买卖建议。</span>
          </p>
        </div>
      )}
    </GlassCard>
  );
}

/**
 * 逆市候选 —— 环境关闭时的**第二视图**，与验证流并列，不推翻它。
 * 验证流仍写「环境关闭，不加」、清单仍全部回避；这一栏只回答
 * 「若只看模式的历史现象统计，哪些格子是正的」，判断权留给人。
 */
export function CounterTrendCard({ c, loading }: { c: CounterTrendResult; loading: boolean }) {
  return (
    <GlassCard>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <TrendingUp className="h-4 w-4" />逆市候选 · 不看大盘闸门的第二视图
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {c.window ?? "窗口未知"} · {c.sample_days ?? "?"} 个交易日 · 环境 {c.regime}
        </span>
      </div>

      {/* 这段不能删也不能弱化：闸门结论在上，这一栏只是并列信息 */}
      <div className="mb-3 rounded-lg border border-warning/40 bg-warning/[0.07] px-3 py-2 text-[12px] leading-relaxed text-warning">
        <b>闸门仍以验证流为准</b>（环境关闭时下面清单照旧全部回避）。这一栏只把「历史上哪些模式格子是正期望」并列摆出来，
        {c.disclaimer}
        <div className="mt-1 text-[11px] opacity-90">{c.regime_note}</div>
      </div>

      {loading && <p role="status" className="text-[12px] text-muted-foreground">涨停样本统计取数中…（第一次要逐日拉，可能几十秒）</p>}

      {c.status === "failed" && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          这一轮涨停样本没取到，逆市候选留白 —— <b>不等于今天没有逆市机会</b>。{c.gaps[0] ?? ""}
        </p>
      )}

      {c.status === "no_qualified_cell" && (
        <div className="text-[12px] text-muted-foreground">
          <p>本轮没有任何格子通过证据门槛（n≥{CT_MIN_SAMPLE}、历史均值&gt;0、胜率≥{CT_MIN_WIN_RATE * 100}%），所以不给候选，不降标准凑数。</p>
          <ul className="mt-1.5 space-y-1">
            {c.rejected.map((r) => <li key={r.strategy}>· {r.strategy}：{r.reason}</li>)}
          </ul>
        </div>
      )}

      {c.status === "ok" && (
        <>
          <p className="mb-2 text-[12px] text-muted-foreground">
            {c.rows.length} 只落在历史正期望格子里（按格子均值排序）。每条并列<b>最差一只</b>与样本数，别只看均值。
          </p>
          <div className="space-y-1.5">
            {c.rows.map((r) => (
              <div key={r.code} className="rounded-lg border border-border/50 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{r.code}</span>
                  <span>{r.name}</span>
                  <span className="text-muted-foreground">{r.sector} · {r.boards} 板</span>
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{r.strategy}·{r.regime}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">n={r.stats.sample}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono tabular-nums text-[11px] text-muted-foreground">
                  <span>胜率 <b className={pctColor(r.stats.win_rate)}>{r.stats.win_rate == null ? "—" : `${(r.stats.win_rate * 100).toFixed(1)}%`}</b></span>
                  <span>均值 <b className={pctColor(r.stats.avg)}>{pctText(r.stats.avg)}</b></span>
                  <span>中位 <b className={pctColor(r.stats.median)}>{pctText(r.stats.median)}</b></span>
                  <span>最差 <b className="text-success">{pctText(r.stats.worst)}</b></span>
                  <span>再板 <b>{r.stats.limit_up_rate == null ? "—" : `${(r.stats.limit_up_rate * 100).toFixed(1)}%`}</b></span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {c.caveat && <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">口径：{c.caveat}</p>}
      {c.gaps.length > 0 && (
        <details className="mt-2 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">本轮缺口 / 未过门槛的格子（{c.gaps.length}）</summary>
          <ul className="mt-1 space-y-1">{c.gaps.map((g, i) => <li key={i}>· {g}</li>)}</ul>
        </details>
      )}
    </GlassCard>
  );
}

const TRACK_CATEGORIES: PatternCategory[] = ["首板", "连板", "高标"];
const TRACK_REGIMES: Regime[] = ["情绪强", "情绪中", "情绪弱", "环境未覆盖"];
/** 胜率差用红涨绿跌的同一套色(实测高于先验=红);A股语境里别用蓝绿表示「好」 */
const ppColor = (pp: number | null) =>
  pp == null ? "text-muted-foreground/40" : pp > 0 ? "text-danger" : pp < 0 ? "text-success" : "text-muted-foreground";

/**
 * 本页战绩:收盘快照的清单实测(类别 × 环境)与 patternPrior 历史先验并排。
 * 实测来自台账(18:45 快照、次日收盘对账);先验是别处统计的同一张表 —— 两列数字同源可复核。
 * 无样本的格子显示「—」,不伪装 0(stats 口径:判不了不进分母)。导出是为了测试能直接喂数据。
 */
export function TrackCard({ t, loading, why }: { t: OpportunityTrackResult | null; loading: boolean; why: string | null }) {
  return (
    <GlassCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <TrendingUp className="h-4 w-4" />本页战绩 · 清单实测 vs 历史先验
        </h2>
        {loading && <span className="text-[11px] text-muted-foreground">台账取数中…</span>}
      </div>
      {!t && !why && (
        <p role="status" className="text-[13px] text-muted-foreground">战绩台账还没回来(不影响上面的清单)。</p>
      )}
      {why && <p role="status" className="text-[13px] text-muted-foreground">{why}</p>}
      {t && !t.available && (
        <p className="text-[13px] text-muted-foreground">
          还没跑过第一次收盘快照:每天 18:45 收盘后会把当天清单(含置信度、类别、情绪环境)落进台账,
          次日收盘自动对账每只的涨跌与是否再板,之后这里就是实测成绩。
        </p>
      )}
      {t && t.available && (
        <div className="space-y-3">
          <p className="text-[12px] text-muted-foreground">
            快照 {t.snapshot_days} 个交易日 · 共 {t.total} 只 ·
            已对账 <b className="text-foreground">{t.settled_count}</b> 只 · 待对账 {t.pending_count} 只
          </p>
          <div className="space-y-2">
            {TRACK_CATEGORIES.map((cat) => (
              <div key={cat} className="rounded-lg border border-border/50 px-3 py-2">
                <div className="mb-1.5 text-xs font-medium">{cat}</div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {TRACK_REGIMES.map((reg) => {
                    const cell = t.cells.find((c) => c.category === cat && c.regime === reg);
                    const prior = PRIOR[cat][reg];
                    const measured = cell && cell.sample > 0 && cell.win_rate != null ? cell : null;
                    const pp = measured ? (measured.win_rate! - prior.win) * 100 : null;
                    return (
                      <div key={reg} className="rounded bg-background/40 px-2 py-1.5 text-[11px]">
                        <div className="text-muted-foreground">{reg}</div>
                        <div className="mt-0.5 font-mono tabular-nums">
                          {measured
                            ? <b>{(measured.win_rate! * 100).toFixed(1)}%</b>
                            : <span className="text-muted-foreground/60">实测 —</span>}
                          <span className="text-muted-foreground"> (n={cell?.sample ?? "—"})</span>
                        </div>
                        <div className="font-mono tabular-nums text-muted-foreground">
                          先验 {(prior.win * 100).toFixed(1)}% (n={prior.n})
                        </div>
                        {pp != null && (
                          <div className={cn("font-mono tabular-nums", ppColor(pp))}>
                            实测−先验 {pp > 0 ? "+" : ""}{pp.toFixed(1)}pp
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {t.pending_rows.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">待对账清单(还没到次日收盘,不进统计)</h3>
              <ul className="space-y-0.5 text-[11px]">
                {t.pending_rows.slice(0, 8).map((p) => (
                  <li key={`${p.date}-${p.code}`} className="tabular-nums">
                    <span className="text-muted-foreground">{p.date}</span>{" "}
                    <span className="font-mono">{p.code}</span> {p.name}
                    <span className="text-muted-foreground"> · {p.category}·{p.regime}</span>
                  </li>
                ))}
                {t.pending_rows.length > 8 && (
                  <li className="text-muted-foreground">… 本页只列前 8 条,待对账共 {t.pending_count} 只</li>
                )}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">{t.sample_caveat}</p>
        </div>
      )}
    </GlassCard>
  );
}

export function ShortlineOpportunities() {
  const [data, setData] = useState<ShortlineOpportunityResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  /**
   * 验证流：盯盘三页的动态结论盖到清单上。
   * 和清单**分两批**回来 —— 佐证取数慢（要开三个端点），不能让人对着「正在取数」等；
   * 佐证没回来之前清单照常显示，验证流区块自己转。
   */
  const [verify, setVerify] = useState<VerifyFlow | null>(null);
  const [verifyWhy, setVerifyWhy] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  /**
   * 本页战绩:收盘快照+次日对账的实测(类别×环境)。和清单、验证流都分开取 ——
   * 只读视图,失败只降级文案,绝不挡清单。
   */
  const [track, setTrack] = useState<OpportunityTrackResult | null>(null);
  const [trackWhy, setTrackWhy] = useState<string | null>(null);
  const [trackLoading, setTrackLoading] = useState(true);
  /**
   * 逆市候选的证据源：实机涨停样本统计（不是 patternPrior 的 18 日冻结表）。
   * 单独一批取，第一次可能要逐日拉几十秒；取不到只让这一栏留白，不挡清单、不挡验证流。
   */
  const [ctSamples, setCtSamples] = useState<SamplesResult | null>(null);
  const [ctWhy, setCtWhy] = useState<string | null>(null);
  const seq = useRef(0);
  /** 最近一次**取完数**的时刻 —— 自动刷新据此决定切回前台要不要补 */
  const loadedAt = useRef<number | null>(null);

  /** 佐证三件套：盘中路径 / 市场状态 / 实时动态。各自失败各自降级，只要有一个回来就能算。
   *  opps 显式传参，不从闭包抓 data —— 依赖数组留空时闭包里的 data 永远是首帧的 null，
   *  `data!` 断言会在 verifyOpportunities 里炸(opps.opportunities.map 读 null)，被 catch 吞成「佐证取数出错」。 */
  const loadVerify = useCallback(async (day: string, my: number, opps: ShortlineOpportunityResult) => {
    setVerifyLoading(true);
    try {
      const [intra, mkt, watch] = await Promise.allSettled([
        backend.shortlineIntraday<IntradayResult>(day),
        backend.marketState(),
        // 实时动态的 poll 会拉实时行情；非交易时段不值得为它开一次请求
        isMarketTrading("CN") ? backend.shortlineWatchPoll<WatchView>() : Promise.resolve(null),
      ]);
      if (my !== seq.current) return;
      const i = intra.status === "fulfilled" ? intra.value : null;
      const m = mkt.status === "fulfilled" ? mkt.value : null;
      const w = watch.status === "fulfilled" ? watch.value : null;
      if (!i && !m && !w) {
        setVerify(null);
        setVerifyWhy("盯盘三页的佐证都没取到（清单本身不受影响）");
      } else {
        setVerify(verifyOpportunities({ opps, intra: i, watch: w, mkt: m }));
        setVerifyWhy(null);
      }
    } catch (e) {
      if (my === seq.current) {
        setVerify(null);
        setVerifyWhy(`佐证取数出错（清单本身不受影响）: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (my === seq.current) setVerifyLoading(false);
    }
  }, []);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const r = await backend.shortlineOpportunities({ refresh });
      if (my !== seq.current) return;
      setData(r); setError("");
      loadedAt.current = Date.now();
      void loadVerify(r.date, my, r);
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [loadVerify]);

  useEffect(() => { void load(false); }, [load]);

  // 这一页原来**没有定时器**：清单与验证流只会停在打开那一刻。交易时段每 2 分钟一次 + 切回补刷。
  useMarketAutoRefresh({ onTick: () => { void load(false); }, loadedAt: loadedAt.current });

  // 战绩台账独立取:失败只写降级文案,不影响清单/验证流
  useEffect(() => {
    let alive = true;
    backend.shortlineOpportunityTrack()
      .then((t) => { if (alive) { setTrack(t); setTrackWhy(null); } })
      .catch((e) => { if (alive) setTrackWhy(`战绩台账没取到(不影响上面的清单): ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { if (alive) setTrackLoading(false); });
    return () => { alive = false; };
  }, []);

  // 逆市候选的证据单独取。90 天窗口由后端按「有缓存的日子」算，实机可用 24 个交易日。
  useEffect(() => {
    if (!data?.date) return;
    let alive = true;
    const ctl = new AbortController();
    backend.shortlineView<SamplesResult>("shortline_samples", { date: data.date, days: 90, refresh: false }, ctl.signal)
      .then((s) => { if (alive) { setCtSamples(s); setCtWhy(null); } })
      .catch((e: unknown) => { if (alive) setCtWhy(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; ctl.abort(); };
  }, [data?.date]);

  /** 缺口合并去重：gaps 是新后端字段，notes 是同源的兼容别名；老后端只有 notes */
  const allGaps = data ? [...new Set([...(data.gaps ?? []), ...(data.notes ?? [])])] : [];
  // 环境档必须与验证流同源：用 mkt.signal.phase（MarketPhase）。
  // 不能用 data.phase —— 那是机会页按封板率派生的「强势/温和/分歧/震荡」，查 regime 会全部落空。
  const counterTrend = buildCounterTrend({ opps: data, samples: ctSamples, phase: verify?.phase, samplesWhy: ctWhy });

  useAiPage({
    key: "shortline_opportunities",
    title: "超短线机会发现",
    context: data
      ? `超短线机会发现(${data.clock} 北京时间):\n`
        + `市场相位:${data.phase} | 涨停${data.limit_up_count}只 | 封板率${data.seal_rate != null ? pctText(data.seal_rate * 100) : "—"}\n`
        + `识别机会:${data.opportunities.length} 只 | 数据状态:${data.status ?? "未标注(老后端)"}\n`
        + (allGaps.length
          ? `⚠️ 本轮数据缺口(下面的空清单或排序要按缺口读,不是完整结论):${allGaps.slice(0, 6).join("；")}\n`
          : "")
        + (verify
          ? `验证流(盯盘三页的佐证):${verify.head}(${verify.note}) | 支持${verify.counts.支持} 观察${verify.counts.观察} 降级${verify.counts.降级} 回避${verify.counts.回避}\n`
            + verify.gates.map((g) => `- ${g.label}:${g.read}(${g.from})`).join("\n")
            : verifyWhy ? `验证流:没取到(${verifyWhy})\n` : "验证流:佐证还在取\n")
        + `${counterTrendSummary(counterTrend)}\n`
        + (track?.available
          ? `本页战绩:已对账 ${track.settled_count} 只 / 待对账 ${track.pending_count} 只(实测与先验并排在页面)\n`
          : "")
        + (allGaps.length > 6 ? `…另有 ${allGaps.length - 6} 条缺口见页面降级提示\n` : "")
      : "超短线机会发现:还没取到。",
    suggestions: ["当前市场适合打板吗", "哪个板块今天最强", "验证流为什么判了回避"],
  });

  if (!data) {
    return (
      <div>
        <PageHeader title="超短线机会发现"
          subtitle="从涨停股中按模式识别候选机会，给出触发清单——只列客观模式和条件，不给买卖建议。" />
        {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
        <p role="status" className="py-12 text-center text-sm text-muted-foreground">正在取数…四个数据源并行请求。</p>
      </div>
    );
  }

  const { limit_up_count, seal_rate, broken_rate, opportunities, by_sector } = data;

  return (
    <div>
      <PageHeader
        title="超短线机会发现"
        subtitle="从涨停股中按模式识别候选机会，给出触发清单——只列客观模式和条件，不给买卖建议。"
        actions={
          <button type="button" onClick={() => void load(true)} disabled={loading} className={BTN}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            {loading ? "取数中…" : "重新取数"}
          </button>
        }
      />

      {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}

      {/* 概览卡片 */}
      <GlassCard>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">今日涨停</span>
            <p className="text-base font-semibold">
              {limit_up_count} 只
              {data.status === "failed" && <span className="ml-1 text-xs font-normal text-warning">没取到，不是 0 家</span>}
            </p>
          </div>
          <div>
            <span className="text-muted-foreground">封板率</span>
            <p className="text-base font-semibold tabular-nums">{seal_rate != null ? `${(seal_rate * 100).toFixed(1)}%` : "—"}</p>
          </div>
          <div>
            <span className="text-muted-foreground">炸板率</span>
            <p className="text-base font-semibold tabular-nums">{broken_rate != null ? `${(broken_rate * 100).toFixed(1)}%` : "—"}</p>
          </div>
        </div>
      </GlassCard>

      {/* 本页战绩:收盘快照+次日对账的实测(类别×环境),与 patternPrior 先验并排 */}
      <TrackCard t={track} loading={trackLoading} why={trackWhy} />

      {/* 验证流:盯盘三页(实时动态 / 市场实时概况 / 竞价与盘中路径)的动态结论 */}
      <VerifyCard v={verify} loading={verifyLoading} why={verifyWhy} />

      {/* 逆市候选:并列第二视图,只加信息、不推翻上面的闸门结论 */}
      <CounterTrendCard c={counterTrend} loading={(!ctSamples && !ctWhy) || verifyLoading} />

      {/* 机会清单 */}
      <GlassCard>
        <h2 className="mb-3 text-sm font-semibold">
          识别机会 ({opportunities.length} 只)
          {opportunities.length > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">{verify ? "按验证裁决排序,支持在前" : "按置信度降序"}</span>
          )}
        </h2>
        {opportunities.length === 0
          ? <p className="py-6 text-center text-sm text-muted-foreground">{emptyOpportunityHint(data)}</p>
          : <div className="space-y-2">
            {(verify ? verify.tagged : opportunities.map((opp) => ({ opp, call: null as OppCall | null, why: "", prior: null as RescoreResult | null }))).map(({ opp: o, call, why, prior }) => (
              <div key={o.code} className="flex items-start gap-3 rounded-lg border border-border/50 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{o.code}</span>
                    <span className="text-foreground">{o.name}</span>
                    {o.sector && <span className="text-muted-foreground">· {o.sector}</span>}
                    {call && <span className={cn("rounded border px-1.5 py-0.5 font-medium", CALL_STYLE[call])}>{call}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {o.pattern && (
                      <span className={cn("rounded px-1.5 py-0.5 font-medium", PATTERN_COLOR[o.pattern.type])}>
                        {o.pattern.type}
                      </span>
                    )}
                    {/* 置信度来自实证查表(环境×模式历史胜率);没佐证时退回后端的模式分并标灰 */}
                    {prior
                      ? <span className={cn("rounded bg-muted/20 px-1.5 py-0.5 font-mono tabular-nums", prior.confidence >= 70 ? "text-primary" : prior.avg < 0 ? "text-warning" : "text-muted-foreground")}>{prior.category}·{prior.regime} 置信{prior.confidence}</span>
                      : <span className="text-muted-foreground/60">置信(未佐证):{o.pattern?.confidence ?? "—"}</span>}
                    {prior?.seal_bucket && <span className="text-muted-foreground">封板:{prior.seal_bucket}</span>}
                    {prior?.in_main_sector && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">板块共振</span>}
                    {o.open_count > 0 && <span className="text-muted-foreground">开板:{o.open_count}次</span>}
                  </div>
                  {prior && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      <span className="text-foreground/70">证据:</span> {prior.evidence}
                    </p>
                  )}
                  {prior && (
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-warning/80">
                      <span className={cn("rounded px-1.5 py-0.5", RISK_COLOR[o.pattern?.risk ?? "中"])}>
                        风险:{o.pattern?.risk ?? "中"}
                      </span>
                      <span>{prior.risk_note}</span>
                    </p>
                  )}
                  {call && <p className="mt-0.5 text-[11px] text-muted-foreground">佐证:{why}</p>}
                </div>
                <div className="text-right tabular-nums">
                  <p className={cn("font-semibold", pctColor(o.change_pct))}>{pctText(o.change_pct)}</p>
                  {o.float_cap_yi != null && <p className="text-muted-foreground">流通{fmt(o.float_cap_yi, 0)}亿</p>}
                </div>
              </div>
            ))}
          </div>
        }
      </GlassCard>

      {/* 按板块聚类 */}
      {Object.keys(by_sector).length > 0 && (
        <GlassCard>
          <h2 className="mb-3 text-sm font-semibold">按板块聚类</h2>
          <div className="space-y-3">
            {Object.entries(by_sector).map(([sector, stocks]) => (
              <div key={sector}>
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">{sector} ({stocks.length} 只)</h3>
                <div className="space-y-1">
                  {stocks.map((o) => (
                    <div key={o.code} className="flex items-center gap-2 text-xs">
                      <span className="font-mono">{o.code}</span>
                      <span className="text-muted-foreground">{o.name}</span>
                      {o.pattern && (
                        <span className={cn("px-1.5 py-0.5 rounded", PATTERN_COLOR[o.pattern.type])}>
                          {o.pattern.type}
                        </span>
                      )}
                      <span className="text-muted-foreground">{o.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {/* 数据来源 & 降级提示：缺口合并 gaps / notes，failed 明说「空清单不是没有机会」 */}
      {(allGaps.length > 0) && (
        <GlassCard>
          <h2 className="mb-2 text-sm font-semibold text-warning">
            降级提示{data.status === "failed" ? " · 本轮取数没成功" : data.status === "partial" ? " · 本轮数据不全" : ""}
          </h2>
          <ul className="space-y-1 text-xs text-warning">
            {allGaps.map((n) => <li key={n}>• {n}</li>)}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">数据来源: {data.source}</p>
        </GlassCard>
      )}
    </div>
  );
}
