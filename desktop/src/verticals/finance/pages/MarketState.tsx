import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, AlertCircle, ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import { useMarketAutoRefresh } from "@/hooks/useMarketAutoRefresh";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";
import type { MarketStateResult, Dimension } from "@/lib/marketState";
import { DIMENSION_LABELS, RISK_LEVEL_META, RISK_LEVEL_HINT, PHASE_COLORS, weightPct } from "@/lib/marketState";
/** 四档徽标配色 / 触发比较符 / 读数行:统一在 lib/marketCall,与每日复盘页共用一份 */
import { CALL_COLORS, OP_LABEL, METRIC_LABEL, readingsText, triggerAction, type MarketCallView } from "@/lib/marketCall";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

export function ScoreRing({
  value,
  color,
  label,
  hint,
  weight,
  asOf,
  stale,
}: {
  value: number | null;
  color: string;
  label: string;
  /** 这一维「分高」是什么意思（五维同向：越高越正面）。不写就不渲染，别留一行空白 */
  hint?: string;
  /** 这一维的实际权重（0..1）。显示的是**生效**权重，不是名义权重 */
  weight?: number | null;
  /** 数据是哪一天的 */
  asOf?: string | null;
  /** 数据不是当日的 —— 标灰，别让人拿旧数据当今天的读数 */
  stale?: boolean;
}) {
  // null = 这一维没算出来。显示成 0 会让人以为市场是 0 分,所以画个空环 + 「—」
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className={cn("flex flex-col items-center gap-1", stale && "opacity-55")} title={stale && asOf ? `这一维用的是 ${asOf} 的数据` : undefined}>
      <div className="relative h-16 w-16">
        <svg className="h-16 w-16 -rotate-90" viewBox="0 0 36 36">
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none" stroke="rgba(120,113,108,.12)" strokeWidth="3" />
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none" stroke={color} strokeWidth="3"
            strokeDasharray={`${pct}, 100`}
            // 🔴 值为 0 时不能用 round linecap:圆头会把「0 长度」画成一个点,
            //    看起来像「这一维有个很小的读数」,而实际是「根本没有这一维」
            strokeLinecap={pct > 0 ? "round" : "butt"} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={cn("text-sm font-bold tabular-nums", value === null && "text-muted-foreground")}>
            {value === null ? "—" : Math.round(value)}
          </span>
        </div>
      </div>
      <span className="text-[11px] text-foreground text-center leading-tight">
        {label}
        <span className="tabular-nums text-muted-foreground"> ({weightPct(weight)})</span>
      </span>
      {hint && <span className="text-[11px] text-muted-foreground text-center leading-tight">{hint}</span>}
      {/* 只有陈旧时才渲染这一行 —— 否则空 span 会在每张卡下面留一行白 */}
      {stale && asOf && (
        <span className="text-[10px] leading-none text-warning">{asOf} 旧数据</span>
      )}
    </div>
  );
}

export function CompositeBadge({ signal }: { signal: MarketStateResult["signal"] }) {
  /**
   * 🔴 算不出来 ≠ 冰点期。过去空数据会被算出 29 分、贴上「极高风险 / 暂不开新仓」,
   * 而真相只是涨跌分布没取到。这里一个数字都不编,连「暂不开新仓」这种结论也不给。
   */
  if (signal.composite == null || signal.phase == null) {
    return (
      <div className="flex flex-col items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-sm text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" />算不出来
        </span>
        <span className="max-w-sm text-center text-xs text-muted-foreground">
          {signal.unavailable ?? "涨跌分布没取到，不给分数，也不设仓位上限。"}
        </span>
      </div>
    );
  }
  const c = signal.composite;
  const color = c >= 75 ? "text-emerald-600 bg-emerald-50 border-emerald-200"
    : c >= 60 ? "text-blue-600 bg-blue-50 border-blue-200"
    : c >= 45 ? "text-amber-600 bg-amber-50 border-amber-200"
    : c >= 30 ? "text-orange-600 bg-orange-50 border-orange-200"
    : "text-red-600 bg-red-50 border-red-200";
  const phaseColor = PHASE_COLORS[signal.phase ?? ""] ?? "#6366f1";
  const risk = signal.risk_level ? RISK_LEVEL_META[signal.risk_level] : null;
  // 阶段与「只看涨停家数」的读数不一致时必须解释 —— 否则「涨停 49 家却叫退潮期」看着像 bug。
  // 🔴 但**怎么解释**要听后端的：跌停 82 家 / 广度 15% 的那天，说「情绪本可到主升期」
  //    是在给盘面贴金；那天真实情况是「跌停潮让只看涨停的粗口径失真」，不是被闸门压下来。
  const squeezed = signal.base_phase && signal.base_phase !== signal.phase;
  const squeezeNote = squeezed
    ? (signal.base_note ?? `情绪读数本可到「${signal.base_phase}」，被准入闸门压到「${signal.phase}」`)
    : null;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={cn("inline-flex items-center gap-2 rounded-full border px-4 py-2 text-lg font-bold", color)}>
        <span style={{ color: phaseColor }} className="h-2.5 w-2.5 rounded-full inline-block" />
        <span>{signal.phase ?? "—"}</span>
        <span className="text-muted-foreground font-normal">· {c} 分</span>
      </div>
      {squeezeNote && (
        <span className="max-w-xl text-center text-[11px] text-muted-foreground">{squeezeNote}</span>
      )}
      <div className="flex flex-wrap justify-center gap-2 text-xs">
        {risk && <span className={cn("rounded-full border px-2 py-0.5", risk.tone)} title={RISK_LEVEL_HINT}>{risk.label}</span>}
        {signal.can_open_position === true
          ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">
            可开新仓（上限 {signal.position_cap_pct}%）
          </span>
          : signal.can_open_position === false
            ? <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-muted-foreground">暂不开新仓</span>
            : <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-muted-foreground">能不能开新仓：不知道</span>}
      </div>
      {/* 风险徽标与五维「抗跌度」方向相反,并排时必须当场说破,不然「低风险」会被读成「抗跌度低」 */}
      {risk && <p className="max-w-xl text-center text-[10px] text-muted-foreground">{RISK_LEVEL_HINT}</p>}
    </div>
  );
}

/** 三道闸门的状态牌：过 / 没过 / 没数据。**没数据不能说成过。** */
function GateCard({ signal }: { signal: MarketStateResult["signal"] }) {
  const blockers = signal.gate_blockers ?? [];
  const unknown = signal.gate_unknown ?? [];
  /**
   * 🔴 优先用后端给的**结构化** `gate_items`（key + state）。
   *    旧实现是按文案关键字（"广度"/"量能"/"MA20"）去 blockers/unknown 里配对 ——
   *    哪天措辞一改（「MA20」写成「20 日均线」），三道门会静默全显示「通过」，
   *    把「本该红的地方变绿」这是最危险的方向。只有旧快照（没有 items）才退回文案匹配。
   */
  const items = signal.gate_items ?? [];
  const names = ["广度 ≥ 55%", "量能 ≥ 20 日均额 +10%", "上证 > MA20"];
  const fallbackState = (i: number): "pass" | "fail" | "unknown" => {
    const keys = ["广度", "量能", "MA20"];
    if (blockers.some((b) => b.includes(keys[i]!))) return "fail";
    if (unknown.some((u) => u.includes(keys[i]!))) return "unknown";
    return "pass";
  };
  const rows = (items.length === 3
    ? items.map((it) => ({ label: it.label, state: it.state, detail: it.detail as string | undefined }))
    : names.map((n, i) => ({ label: n, state: fallbackState(i), detail: undefined as string | undefined })));
  const icon = (s: string) => s === "pass" ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
    : s === "fail" ? <ShieldX className="h-3.5 w-3.5 text-red-600" />
      : <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />;
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.label} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
            r.state === "pass" ? "border-emerald-200 bg-emerald-50/60" : r.state === "fail" ? "border-red-200 bg-red-50/60" : "border-border/60")}
            title={r.detail}>
            {icon(r.state)}
            <span className="flex-1">{r.label}</span>
            <span className="text-[11px] text-muted-foreground">{r.state === "pass" ? "通过" : r.state === "fail" ? "未过" : "无数据"}</span>
          </div>
        ))}
      </div>
      {blockers.length > 0 && (
        <ul className="space-y-1 text-[11px] text-red-600">
          {blockers.map((b) => <li key={b}>• {b}</li>)}
        </ul>
      )}
      {unknown.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          没数据的门记「无数据」而不是「通过」—— 取不到量能/均线时，不许假装它俩过关了。
        </p>
      )}
    </div>
  );
}

/** 五维公式：用**生效**权重拼，而不是写死的 0.30/0.15/… */
export function formulaText(dimensions: MarketStateResult["dimensions"]): string {
  const items: string[] = [];
  const push = (name: string, d: Dimension) => {
    if (d.weight != null && d.weight > 0) items.push(`${name}×${d.weight.toFixed(2)}`);
  };
  push(DIMENSION_LABELS.emotion.label, dimensions.emotion);
  push(DIMENSION_LABELS.dragon.label, dimensions.dragon);
  push(DIMENSION_LABELS.risk.label, dimensions.risk);
  push(DIMENSION_LABELS.earning.label, dimensions.earning);
  push(DIMENSION_LABELS.event.label, dimensions.event);
  const dropped = dimensions.event.weight === 0
    ? "（事件面没算出来，权重已让渡给其余四项）"
    : (dimensions.event.weight ?? 0) > 0 && (dimensions.event.weight ?? 0) < 0.15
      ? "（事件面名义 0.15，实际封顶 0.08 —— 文本代理指标不该拿走 15% 的分数）"
      : "";
  return `综合健康分 = ${items.join(" + ")}${dropped}`;
}

/**
 * 事件面明细 —— 让人能看出「这个分是怎么来的」。
 *
 * 🔴 三条必须写在卡片上，否则一个 50 分看起来像「宏观中性」的客观结论：
 *    ① 它只是**标题词频**，认不出否定与条件（「暂缓降准」会被算成利多）；
 *    ② 分数锁在 35~65 的窄幅里，权重封顶 8% —— 它几乎不影响仓位结论；
 *    ③ 新闻联播是晚上 19:00 播，白天拿到的是**前一晚**那期。
 */
function EventDetailCard({ reading }: { reading: MarketStateResult["signal"]["event_detail"] }) {
  if (!reading) {
    return (
      <GlassCard>
        <h2 className="mb-1 text-sm font-semibold">事件面明细</h2>
        <p className="text-xs text-muted-foreground">
          没取到当期《新闻联播》文字稿（或当期没有条目）—— 事件面这一维**没算出来**，权重已让渡给其余四项，
          不是「事件面 50 分」。取数恢复后会自动回来。
        </p>
      </GlassCard>
    );
  }
  const neutral = reading.macro_hits === 0;
  return (
    <GlassCard>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">事件面明细</h2>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground">
          来源 · 央视《新闻联播》文字稿
        </span>
      </div>
      <div className="grid grid-cols-4 gap-3 text-center">
        {[
          { k: "期次", v: reading.date ?? "—" },
          { k: "条目", v: `${reading.items} 条` },
          { k: "宏观政策", v: `${reading.macro_hits} 条` },
          { k: "利多 / 利空词", v: `${reading.bullish} / ${reading.bearish}` },
        ].map((c) => (
          <div key={c.k} className="rounded-lg border border-border/50 py-2">
            <div className="text-[11px] text-muted-foreground">{c.k}</div>
            <div className="text-sm font-medium tabular-nums">{c.v}</div>
          </div>
        ))}
      </div>
      {neutral ? (
        <p className="mt-3 text-xs text-muted-foreground">
          当期没有命中宏观政策主题的条目 —— 这是「今天宏观面很安静」，按中性 50 计，与「没取到数据」不是一回事。
        </p>
      ) : (
        <ul className="mt-3 space-y-1 text-[11px] text-muted-foreground">
          {reading.samples.map((s) => <li key={s}>• {s}</li>)}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground/80">
        这是**文本代理指标**，不是对行情的判断：只认词、认不出否定与条件（「暂缓降准」会被算成利多），
        官方表述也天然偏正面。因此分数锁在 35~65、权重封顶 8% —— 判断全错也只影响综合分 ±2 分。
        另外《新闻联播》19:00 播出，白天拿到的是前一晚那期。
      </p>
    </GlassCard>
  );
}

/**
 * 大盘判断台账卡 —— WorkBuddy 大盘全景收盘档的「交易倾向四档」+ 次日触发条件对账。
 * 🔴 只呈现全景侧写下的判断与本系统的对账结果,**不生成任何大盘建议**;
 * 触发命中按结构化阈值机器判,判不了(trigger_hit=null)如实留白、不进战绩分母。
 */
export function MarketCallCard({ view, error }: { view: MarketCallView | null; error: string }) {
  if (!view || !view.available) {
    return (
      <GlassCard>
        <h2 className="mb-1 text-sm font-semibold">大盘判断台账（全景收盘档）</h2>
        <p className="text-xs text-muted-foreground">
          {error
            ? `台账没读到：${error}`
            : "还没有落账记录。WorkBuddy 大盘全景收盘档跑完后，会把「交易倾向四档 + 触发条件」写进数据根 inbox/market_call/ 的交接件；每天 16:05 的任务自动扫描落账，次日收盘对账触发条件。本台账只存档，不生成大盘建议。"}
        </p>
      </GlassCard>
    );
  }
  const latest = view.rows[0]!;
  return (
    <GlassCard>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">大盘判断台账（全景收盘档）</h2>
        <span className="text-[11px] text-muted-foreground">
          共 {view.total} 条 · 已对账 {view.settled_count} · 待对账 {view.pending_count}
          {view.judged > 0 ? ` · 条件命中 ${view.hit}/${view.judged}` : ""}
        </span>
      </div>

      <p className="mb-2 text-[10px] text-muted-foreground/70">
        四档白话：加仓=可加 · 持有=拿着别动 · 减仓=减掉 · 观望=先不开新仓。下面只存档全景的判断，不替你下结论。
      </p>

      {/* 最新一档 */}
      <div className="mb-3 rounded-lg border border-border/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground tabular-nums">{latest.date}</span>
          <span className={cn("rounded-full border px-2 py-0.5 font-semibold", CALL_COLORS[latest.call] ?? "border-border/60")}>{latest.call}</span>
          <span className="text-muted-foreground">· {latest.direction}</span>
          {latest.source === "inbox"
            ? <span className="text-[11px] text-warning">交接件还没落账(16:05 扫描后入台账)</span>
            : latest.settled
              ? <span className="text-[11px] text-muted-foreground">已对账 {latest.settled_date}</span>
              : <span className="text-[11px] text-warning">待次日对账</span>}
        </div>
        {latest.basis && <p className="mt-1 text-xs">{latest.basis}</p>}
        {(latest.trigger || latest.trigger_metric) && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            触发条件：{latest.trigger_metric
              ? `${METRIC_LABEL[latest.trigger_metric] ?? latest.trigger_metric} ${OP_LABEL[latest.trigger_op ?? ""] ?? "?"} ${latest.trigger_value}`
              : "—"}
            {latest.trigger ? `（${latest.trigger}）` : ""}
            {latest.trigger_hit === true
              ? ` · 次日条件到了${triggerAction(latest.trigger) ? ` → 全景原文：${triggerAction(latest.trigger)}` : ""}`
              : latest.trigger_hit === false
                ? ` · 次日没到${triggerAction(latest.trigger) ? `（到了则${triggerAction(latest.trigger)}）` : ""}`
                : latest.settled ? " · 次日数据缺，没判" : ""}
          </p>
        )}
        {latest.html_path && (
          <p className="mt-1 text-[10px] text-muted-foreground/70" title={latest.html_path}>
            全景报告：{latest.html_path.split(/[\\/]/).pop()}
          </p>
        )}
      </div>

      {/* 历史对账并排 */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border/50 text-left text-muted-foreground">
              <th className="py-1 pr-2 font-normal">日期</th>
              <th className="py-1 pr-2 font-normal">档位 · 方向</th>
              <th className="py-1 pr-2 font-normal">写下时读数</th>
              <th className="py-1 pr-2 font-normal">次日读数</th>
              <th className="py-1 font-normal">条件到了吗</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.date} className="border-b border-border/30 last:border-0">
                <td className="py-1.5 pr-2 tabular-nums whitespace-nowrap">{r.date}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  <span className={cn("rounded-full border px-1.5 py-0.5", CALL_COLORS[r.call] ?? "border-border/60")}>{r.call}</span>
                  <span className="ml-1 text-muted-foreground">{r.direction}</span>
                </td>
                <td className="py-1.5 pr-2 tabular-nums">{readingsText(r, "")}</td>
                <td className="py-1.5 pr-2 tabular-nums">{r.settled ? readingsText(r, "next_") : <span className="text-warning">{r.source === "inbox" ? "未落账" : "待对账"}</span>}</td>
                <td className="py-1.5 whitespace-nowrap">
                  {r.trigger_hit === true
                    ? <span className="text-red-600">到了·{triggerAction(r.trigger) ?? "按原文"}</span>
                    : r.trigger_hit === false
                      ? <span className="text-emerald-600">没到·待{triggerAction(r.trigger) ?? "看条件"}</span>
                      : <span className="text-muted-foreground">{r.settled ? "数据缺，没判" : "—"}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground/80">{view.caveat}</p>
    </GlassCard>
  );
}

export function MarketState() {
  const [data, setData] = useState<MarketStateResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [call, setCall] = useState<MarketCallView | null>(null);
  const [callError, setCallError] = useState("");
  const seq = useRef(0);
  /** 最近一次**取完数**的时刻（不是发请求的时刻）—— 自动刷新据此判断要不要补刷 */
  const loadedAt = useRef<number | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const r = await backend.marketState({ refresh });
      // 只有**真的拿到数据**才算「取完了」：失败也记时刻的话，一次挂掉的请求会把
      // 「切回前台补刷」压住两分钟，而这恰恰是最该重试的时候。
      if (my === seq.current) { setData(r); setError(""); loadedAt.current = Date.now(); }
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  /**
   * 这一页原来**根本没有定时器**，只有「重新取数」按钮 —— 用户盯着一个不会自己更新的
   * 「市场状态信号」。交易时段每 2 分钟取一次，切回前台时若已过期立刻补。
   */
  useMarketAutoRefresh({ onTick: () => { void load(false); }, loadedAt: loadedAt.current });

  // 大盘判断台账独立取数:失败只降级卡片文案,不挡市场状态主视图
  useEffect(() => {
    const ac = new AbortController();
    backend.marketCall(ac.signal).then(setCall).catch((e) => {
      if (!ac.signal.aborted) setCallError(e instanceof Error ? e.message : String(e));
    });
    return () => ac.abort();
  }, []);

  /**
   * 🔴 算不出来时必须明确告诉 AI「没有结论」，不能让它读到「仓位上限 0% / 不可开新仓」——
   * 那会被当成一条真实的市场判断继续往下传。
   */
  const aiContext = !data ? "市场状态:还没取到。"
    : data.signal.unavailable
      ? `市场状态(${data.clock} 北京时间):算不出来。\n`
        + `原因: ${data.signal.unavailable}\n`
        + `⚠️ 没有综合健康分、没有仓位上限、也没有「能不能开新仓」的结论。不要据此推断市场强弱或建议仓位。\n`
        + `预期取数来源(设计清单,不代表本次全部取到): ${data.signal.sources.join(", ")}`
        + (data.notes.length ? `\n降级提示: ${data.notes.join(";")}` : "")
      : `市场状态(${data.clock} 北京时间):\n`
        + `综合健康分 ${data.signal.composite} 分 · ${data.signal.phase}`
        + (data.signal.base_phase && data.signal.base_phase !== data.signal.phase
          ? `（${data.signal.base_note ?? `只看涨停家数的情绪读数是「${data.signal.base_phase}」，被准入闸门压到「${data.signal.phase}」`}）` : "")
        + `\n`
        + `风险等级: ${data.signal.risk_level ? RISK_LEVEL_META[data.signal.risk_level].label : "未知"}\n`
        + `可开新仓: ${data.signal.can_open_position === null ? "不知道" : data.signal.can_open_position ? "是" : "否"} · 仓位上限: ${data.signal.position_cap_pct === null ? "未设" : `${data.signal.position_cap_pct}%`}\n`
        + `五维评分(0–100,分越高越正面;抗跌度原名「风险」,量的是安全度,分低=危险): 情绪${data.dimensions.emotion.score ?? "—"}(权重${weightPct(data.dimensions.emotion.weight)}) 龙头${data.dimensions.dragon.score ?? "—"}(${weightPct(data.dimensions.dragon.weight)}) 抗跌度${data.dimensions.risk.score ?? "—"}(${weightPct(data.dimensions.risk.weight)}) 赚钱效应${data.dimensions.earning.score ?? "—"}(${weightPct(data.dimensions.earning.weight)}) 事件${data.dimensions.event.score ?? "未算出"}(${weightPct(data.dimensions.event.weight)})\n`
        + (data.signal.event_detail
          ? `事件面口径: 央视《新闻联播》${data.signal.event_detail.date ?? ""} 期 ${data.signal.event_detail.items} 条，命中宏观政策 ${data.signal.event_detail.macro_hits} 条(利多词 ${data.signal.event_detail.bullish} / 利空词 ${data.signal.event_detail.bearish})。这是标题词频代理指标，不是宏观结论，权重封顶 8%，不要用它单独推仓位。\n`
          : `事件面: 没取到当期《新闻联播》，该维度没算出来(权重已让渡)，不是 50 分。\n`)
        + (data.signal.gate_blockers?.length ? `准入闸门未过: ${data.signal.gate_blockers.join(";")}\n` : "")
        + (data.signal.gate_unknown?.length ? `闸门未评估(无数据): ${data.signal.gate_unknown.join(";")}\n` : "")
        + (data.signal.stale_dimensions?.length ? `⚠️ 以下维度的数据不是当日的: ${data.signal.stale_dimensions.join(", ")} —— 不要当成今天的读数\n` : "")
        + `操作建议: ${data.recommendation.action}(置信度 ${Math.round(data.recommendation.confidence * 100)}%) — ${data.recommendation.reason}\n`
        // 大盘判断台账:全景收盘档的存档结论,给 AI 只读不推断 —— 明确标注来源与「不生成建议」
        + (call?.available && call.rows[0]
          ? `大盘判断台账(WorkBuddy 大盘全景收盘档存档,${call.rows[0].date}): ${call.rows[0].call} · ${call.rows[0].direction}`
          + (call.rows[0].basis ? ` — ${call.rows[0].basis}` : "")
          + (call.rows[0].trigger ? `;触发条件: ${call.rows[0].trigger}` : "")
          + (call.judged > 0 ? `;条件命中战绩 ${call.hit}/${call.judged}(判得了的才计)` : "")
          + `\n${call.caveat}\n`
          : "大盘判断台账: 还没有落账记录(全景收盘档还没落过交接件)。\n")
        + `预期取数来源(设计清单,不代表本次全部取到): ${data.signal.sources.join(", ")}`
        + (data.notes.length ? `\n降级提示: ${data.notes.join(";")}` : "");

  useAiPage({
    key: "market_state",
    title: "市场状态信号",
    context: aiContext,
    suggestions: ["当前市场适合什么操作", "五维评分哪一项拖累最大", "闸门没过意味着什么"],
  });

  if (!data) {
    return (
      <div>
        <PageHeader title="市场状态信号"
          subtitle="五维加权健康分 + 准入闸门：主升期及以上必须同时满足广度、量能、均线三条。上游工具读它决定仓位上限，参考性结论由你裁决。" />
        {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
        <p role="status" className="py-12 text-center text-sm text-muted-foreground">正在取数…涨跌分布、板块共振、资金流、指数趋势、连板天梯都要轮询。</p>
      </div>
    );
  }

  const { signal, dimensions, recommendation } = data;
  const gate = data.gate ?? {
    // 旧快照没有 gate 字段时自己推：**有门没评估也不算全过**（与后端同一口径）
    all_pass: (signal.gate_blockers ?? []).length === 0 && (signal.gate_unknown ?? []).length === 0,
    blockers: signal.gate_blockers ?? [],
    unknown: signal.gate_unknown ?? [],
  };
  const staleSet = new Set(signal.stale_dimensions ?? []);

  return (
    <div>
      <PageHeader
        title="市场状态信号"
        subtitle="五维加权健康分 + 准入闸门：主升期及以上必须同时满足广度、量能、均线三条。上游工具读它决定仓位上限，参考性结论由你裁决。"
        actions={
          <button type="button" onClick={() => void load(true)} disabled={loading} className={BTN}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            {loading ? "取数中…" : "重新取数"}
          </button>
        }
      />

      {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}

      <div className="space-y-5">
        {/* 综合健康分 */}
        <GlassCard>
          <div className="flex flex-col items-center gap-3 py-4">
            <CompositeBadge signal={signal} />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>派生于 {data.date} {data.clock}(北京时间)</span>
              <span className="text-border">·</span>
              <span title="这是预期取数来源清单的首项，不代表本次这一路一定取到了">{signal.sources[0] ?? ""}</span>
            </div>
          </div>
        </GlassCard>

        {/* 五维评分 */}
        <GlassCard>
          <h2 className="mb-1 text-sm font-semibold">五维评分明细</h2>
          <p className="mb-1 text-[11px] text-muted-foreground">五维都是 0–100 分，<b className="font-medium text-foreground">分越高越正面</b>；环下那行写的是高分那一端的意思。「抗跌度」原名「风险」，量的是安全度 —— 分低才是危险。上方的「低/中/高/极高风险」是独立徽标、方向相反：抗跌度分越低越危险。</p>
          <p className="mb-4 text-[11px] text-muted-foreground">括号里是实际生效权重：某一维没数据时，它的权重会让渡给其余维度；事件面另外设 8% 封顶（名义 0.15）。</p>
          <div className="grid grid-cols-5 gap-4">
            <ScoreRing value={dimensions.emotion.score} color="#6366f1" label={DIMENSION_LABELS.emotion.label} hint={DIMENSION_LABELS.emotion.hint} weight={dimensions.emotion.weight} asOf={dimensions.emotion.as_of} stale={staleSet.has("emotion")} />
            <ScoreRing value={dimensions.dragon.score} color="#f59e0b" label={DIMENSION_LABELS.dragon.label} hint={DIMENSION_LABELS.dragon.hint} weight={dimensions.dragon.weight} asOf={dimensions.dragon.as_of} stale={staleSet.has("dragon")} />
            <ScoreRing value={dimensions.risk.score} color="#22c55e" label={DIMENSION_LABELS.risk.label} hint={DIMENSION_LABELS.risk.hint} weight={dimensions.risk.weight} asOf={dimensions.risk.as_of} stale={staleSet.has("risk")} />
            <ScoreRing value={dimensions.earning.score} color="#3b82f6" label={DIMENSION_LABELS.earning.label} hint={DIMENSION_LABELS.earning.hint} weight={dimensions.earning.weight} asOf={dimensions.earning.as_of} stale={staleSet.has("earning")} />
            {/* 事件环用后端自己的 stale：它按「播出日期 + 允许滞后 1 天」判定，
                不用 stale_dimensions（那是按取数时间算的，会把每晚都正常滞后的一期标成灰） */}
            <ScoreRing value={dimensions.event.score} color="#8b5cf6" label={DIMENSION_LABELS.event.label} hint={DIMENSION_LABELS.event.hint} weight={dimensions.event.weight} asOf={dimensions.event.as_of} stale={dimensions.event.stale ?? staleSet.has("event")} />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">{formulaText(dimensions)}</p>
          {(signal.stale_dimensions?.length ?? 0) > 0 && (
            <p className="mt-1 text-[11px] text-warning">
              标灰的维度用的是非当日数据（{signal.stale_dimensions!.join(" / ")}），读数可能已被冻结，建议重新取数。
            </p>
          )}
        </GlassCard>

        {/* 事件面明细 */}
        <EventDetailCard reading={signal.event_detail} />

        {/* 准入闸门 */}
        <GlassCard>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">准入闸门（主升期及以上必须全过）</h2>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px]",
              gate.all_pass ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : gate.blockers.length ? "border-red-200 bg-red-50 text-red-700"
                  : "border-amber-200 bg-amber-50 text-amber-700")}>
              {/* 三态：全过 / N 门未过 / 有门没数据。不能把「没数据」写成「0 门未过」 */}
              {gate.all_pass ? "全部通过"
                : gate.blockers.length ? `${gate.blockers.length} 门未过`
                  : `${gate.unknown.length} 门无数据`}
            </span>
          </div>
          <GateCard signal={signal} />
        </GlassCard>

        {/* 操作建议 */}
        <GlassCard>
          <h2 className="mb-3 text-sm font-semibold">操作建议</h2>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-20 shrink-0">当前动作</span>
              <span className="text-sm font-medium">{recommendation.action}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-20 shrink-0">仓位上限</span>
              <span className="text-sm font-medium">{recommendation.position_range}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-20 shrink-0">置信度</span>
              <div className="flex-1">
                <div className="h-2 rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-primary transition-all"
                    style={{ width: `${recommendation.confidence * 100}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground mt-1 block">{Math.round(recommendation.confidence * 100)}%</span>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-xs text-muted-foreground w-20 shrink-0 pt-0.5">依据</span>
              <span className="text-sm text-muted-foreground">{recommendation.reason}</span>
            </div>
            <p className="text-[11px] text-muted-foreground/80">
              动作只跟仓位上限走（0% 就是空仓等待），阶段标签只说明情绪周期 —— 两者不会互相冒充。
            </p>
          </div>
        </GlassCard>

        {/* 大盘判断台账(全景收盘档存档 + 次日触发条件对账) */}
        <MarketCallCard view={call} error={callError} />

        {/* 数据来源 & 降级提示 */}
        <GlassCard>
          <h2 className="mb-2 text-sm font-semibold">预期取数来源</h2>
          <p className="mb-2 text-[11px] text-muted-foreground">
            下面是本页设计上会取的六路，<b className="font-medium text-foreground">不是本次实际命中核对</b>：某一路取数失败、用缓存或由备源顶上时，它照样列在这里。本次缺口看下面的降级提示。
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {signal.sources.map((s) => <li key={s}>• {s}</li>)}
          </ul>
          {signal.data_as_of && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              各来源取数日期（不是数据归属日）：
              {Object.entries(signal.data_as_of).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}
            </p>
          )}
          {data.notes.length > 0 && (
            <>
              <h2 className="mt-4 mb-2 text-sm font-semibold text-warning">降级提示</h2>
              <ul className="space-y-1 text-xs text-warning">
                {data.notes.map((n) => <li key={n}>• {n}</li>)}
              </ul>
            </>
          )}
        </GlassCard>
      </div>
    </div>
  );
}
