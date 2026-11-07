/**
 * 交易计划 —— 闭环缺的前半球。
 *
 * 过去只有成交之后才补的 `journal_tag`,于是「这单算不算计划内」只能靠用户事后自己勾布尔,
 * 交易日志也只能在持仓之后抱怨一句「没写计划止损」。计划先于成交存在,同一句话放到**买入之前**说。
 *
 * 这一页按**客观状态**分组(今天要处理 / 待执行 / 已过期 / 已成交 / 已放弃),不替用户排重要度。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Plus, RefreshCw, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import { useMarketAutoRefresh } from "@/hooks/useMarketAutoRefresh";
import { cn } from "@/lib/utils";
import { PLAN_KIND, PLAN_LIFECYCLE_META, type PlanLifecycle, type PlanView, type PlansResult } from "@/lib/plans";
import type { MarketSignal } from "@/lib/marketState";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
const INPUT = "w-full rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary";
const LABEL = "mb-1 block text-[11px] text-muted-foreground";

const GROUPS: { key: string; label: string; match: (p: PlanView) => boolean }[] = [
  { key: "today", label: "今天要处理", match: (p) => p.lifecycle === "planned" && (p.due_today || p.check_arrived) },
  { key: "planned", label: "待执行", match: (p) => p.lifecycle === "planned" && !p.due_today && !p.check_arrived },
  { key: "expired", label: "已过期（过了有效期还没成交）", match: (p) => p.lifecycle === "expired" },
  { key: "executed", label: "已成交", match: (p) => p.lifecycle === "executed" },
  { key: "abandoned", label: "已放弃", match: (p) => p.lifecycle === "abandoned" },
];

function Chips({ d }: { d: PlansResult }) {
  const items = [
    { label: "待执行", value: d.open_count, tone: "text-blue-700" },
    { label: "今天到期", value: d.due_count, tone: "text-amber-700" },
    { label: "已过期", value: d.expired_count, tone: "text-orange-700" },
    { label: "已对照成交", value: d.linked_count, tone: "text-emerald-700" },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => (
        <span key={it.label} className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1 text-xs">
          <span className="text-muted-foreground">{it.label}</span>{" "}
          <span className={cn("font-semibold tabular-nums", it.tone)}>{it.value}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 市场仓位纪律横幅 —— 复用「市场状态信号」同一套派生结果(can_open_position / position_cap_pct)。
 * 🔴 null = 算不出来 / 未设上限,绝不当成「禁止开仓」;只有明确 false 才提示暂不开新仓。
 */
function MarketPosture({ signal }: { signal: MarketSignal }) {
  const { can_open_position, position_cap_pct, unavailable } = signal;
  const open =
    can_open_position === true
      ? { t: "可开新仓", tone: "text-emerald-700 bg-emerald-50 border-emerald-200" }
      : can_open_position === false
        ? { t: "暂不开新仓", tone: "text-red-700 bg-red-50 border-red-200" }
        : { t: "能不能开新仓:不知道", tone: "text-muted-foreground bg-muted/30 border-border/60" };
  return (
    <GlassCard className="p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-muted-foreground">当前市场仓位纪律:</span>
        <span className={cn("rounded-full border px-2 py-0.5", open.tone)}>{open.t}</span>
        <span className="text-muted-foreground">
          仓位上限{" "}
          <span className={cn("font-semibold tabular-nums", position_cap_pct === null ? "text-muted-foreground" : "text-foreground")}>
            {position_cap_pct === null ? "未设(信号没算出来)" : `${position_cap_pct}%`}
          </span>
        </span>
        {unavailable && <span className="text-amber-700">· {unavailable}</span>}
      </div>
    </GlassCard>
  );
}

/** 买入之前该问的话 */
function Gaps({ gaps }: { gaps: PlanView["gaps"] }) {
  if (!gaps.length) return <p className="mt-2 text-[11px] text-emerald-700">止损 / 价位 / 仓位 / 理由都写了</p>;
  return (
    <ul className="mt-2 space-y-1">
      {gaps.map((g) => (
        <li key={g.key} className="flex items-start gap-1.5 text-[11px] text-amber-700">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{g.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Levels({ plan }: { plan: PlanView["plan"] }) {
  const rows = [
    { k: "计划入场", v: plan.planned_entry },
    { k: "计划止损", v: plan.planned_stop },
    { k: "计划目标", v: plan.planned_target },
  ];
  const any = rows.some((r) => r.v !== null);
  if (!any && plan.position_pct === null) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
      {rows.filter((r) => r.v !== null).map((r) => (
        <span key={r.k} className="text-muted-foreground">
          {r.k} <span className="font-semibold tabular-nums text-foreground">{r.v}</span>
        </span>
      ))}
      {plan.position_pct !== null && (
        <span className="text-muted-foreground">
          计划占仓 <span className="font-semibold tabular-nums text-foreground">{plan.position_pct}%</span>
        </span>
      )}
    </div>
  );
}

/** 成交之后与计划的对照 */
function Execution({ v }: { v: PlanView }) {
  const e = v.execution;
  if (!e) {
    if (v.candidates.length) {
      return (
        <div className="mt-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-2.5 py-2">
          <p className="text-[11px] text-muted-foreground">
            还没成交，但有 {v.candidates.length} 笔同代码交易可能是这笔 —— 关联后才有事后对照：
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {v.candidates.map((c) => (
              <button key={c.round_key} className={BTN}
                onClick={async () => {
                  await backend.ledgerSave(PLAN_KIND, { ...v.plan, round_ref: c.round_key, status: "executed" });
                  location.reload();
                }}>
                <CheckCircle2 className="h-3.5 w-3.5" />{c.date} {c.first_price ?? "?"}
              </button>
            ))}
          </div>
        </div>
      );
    }
    return <p className="mt-2 text-[11px] text-muted-foreground">还没成交，也没发现同代码的交易</p>;
  }
  const gap = e.entry_gap_pct;
  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 text-[11px]">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>入场日 <span className="font-semibold text-foreground">{e.date}</span></span>
        <span>首笔成交 <span className="font-semibold tabular-nums text-foreground">{e.first_price ?? "—"}</span></span>
        {e.closed ? <span>已实现 <span className={cn("font-semibold tabular-nums", (e.realized_pnl_pct ?? 0) >= 0 ? "text-red-600" : "text-green-600")}>{e.realized_pnl_pct}%</span></span>
          : <span className="text-muted-foreground">还拿着（{e.hold_days ?? "—"} 天）</span>}
        {gap !== null && (
          <span className={cn("font-semibold tabular-nums", gap > 0 ? "text-orange-700" : "text-emerald-700")}>
            {gap > 0 ? `比计划高买 ${gap}%` : gap < 0 ? `比计划低买 ${Math.abs(gap)}%` : "进场价与计划一致"}
          </span>
        )}
      </div>
      <button className={cn(BTN, "mt-1.5")} onClick={async () => {
        await backend.ledgerSave(PLAN_KIND, { ...v.plan, round_ref: "", status: "planned" });
        location.reload();
      }}>取消关联</button>
    </div>
  );
}

function PlanCard({ v, marketCap }: { v: PlanView; marketCap: number | null }) {
  const meta = PLAN_LIFECYCLE_META[v.lifecycle as PlanLifecycle];
  const overCap = v.plan.position_pct !== null && marketCap !== null && v.plan.position_pct > marketCap;
  return (
    <GlassCard className="p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{v.plan.name || v.plan.symbol}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{v.plan.symbol}</span>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", meta.tone)}>{meta.label}</span>
            {v.due_today && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">今天到期</span>}
            {v.check_arrived && v.plan.next_check && (
              <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">
                已过检查点 {v.plan.next_check}
              </span>
            )}
          </div>
          {v.plan.thesis && <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">{v.plan.thesis}</p>}
        </div>
        <button className={BTN} onClick={async () => {
          await backend.ledgerSave(PLAN_KIND, { ...v.plan, status: v.plan.status === "planned" ? "executed" : "planned" });
          location.reload();
        }}>
          {v.plan.status === "planned" ? "标记成交" : "回到待执行"}
        </button>
      </div>
      <Levels plan={v.plan} />
      {overCap && (
        <p className="mt-1.5 text-[11px] text-orange-700">
          ⚠ 计划占仓 {v.plan.position_pct}% 超过当前市场建议上限 {marketCap}%，注意收紧或分批建仓。
        </p>
      )}
      {v.plan.watch.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {v.plan.watch.map((w, i) => (
            <li key={i} className="text-[11px] text-muted-foreground">· 先看到再动手：{w}</li>
          ))}
        </ul>
      )}
      <Gaps gaps={v.gaps} />
      <Execution v={v} />
    </GlassCard>
  );
}

export function TradePlans() {
  const [data, setData] = useState<PlansResult | null>(null);
  const [signal, setSignal] = useState<MarketSignal | null>(null);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [openForm, setOpenForm] = useState(false);
  /** 最近一次**取完数**的时刻 —— 自动刷新据此决定切回前台要不要补 */
  const loadedAt = useRef<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      setData(await backend.tradePlans());
      // 市场信号独立取数:失败不影响计划列表,只出不来横幅
      try { setSignal((await backend.marketState()).signal); loadedAt.current = Date.now(); } catch { setSignal(null); }
    }
    catch (e) { setErr(e instanceof ApiError ? `${e.status} ${e.message}` : String(e)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 这一页的仓位上限/风险档来自「市场状态」，原来只在打开时取一次 —— 盘中会一直挂着开盘时那份。
  useMarketAutoRefresh({ onTick: () => { void load(); }, loadedAt: loadedAt.current });

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      symbol: String(f.get("symbol") ?? "").trim(),
      name: String(f.get("name") ?? "").trim(),
      thesis: String(f.get("thesis") ?? "").trim(),
      planned_entry: Number(f.get("planned_entry") ?? "") || undefined,
      planned_stop: Number(f.get("planned_stop") ?? "") || undefined,
      planned_target: Number(f.get("planned_target") ?? "") || undefined,
      position_pct: Number(f.get("position_pct") ?? "") || undefined,
      due: String(f.get("due") ?? "").trim(),
      next_check: String(f.get("next_check") ?? "").trim(),
      valid_until: String(f.get("valid_until") ?? "").trim(),
      status: "planned",
    };
    if (!body.symbol) return;
    await backend.ledgerSave(PLAN_KIND, body);
    setOpenForm(false);
    await load();
  }

  return (
    <div>
      <PageHeader
        title="交易计划"
        subtitle="下单之前写下这一笔：到期 / 到检查点会被顶到这里，止损、价位、仓位、理由缺哪样在买入之前就告诉你；成交之后和实际对着看。"
        actions={
          <div className="flex items-center gap-2">
            <button className={BTN} onClick={() => setOpenForm((v) => !v)}>
              {openForm ? <><X className="h-3.5 w-3.5" />收起</> : <><Plus className="h-3.5 w-3.5" />写计划</>}
            </button>
            <button className={BTN} onClick={load} disabled={busy}>
              <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />刷新
            </button>
          </div>
        }
      />

      {err && <GlassCard className="mb-3 p-3 text-xs text-red-600">加载失败：{err}</GlassCard>}

      {openForm && (
        <GlassCard className="mb-3 p-3">
          <form onSubmit={create} className="grid gap-2 sm:grid-cols-3">
            <label><span className={LABEL}>代码 *</span><input name="symbol" className={INPUT} placeholder="600519" /></label>
            <label><span className={LABEL}>名称</span><input name="name" className={INPUT} placeholder="贵州茅台" /></label>
            <label><span className={LABEL}>计划占仓 %</span><input name="position_pct" type="number" step="0.1" className={INPUT} placeholder="20" /></label>
            <label><span className={LABEL}>计划入场价</span><input name="planned_entry" type="number" step="0.01" className={INPUT} /></label>
            <label><span className={LABEL}>计划止损价</span><input name="planned_stop" type="number" step="0.01" className={INPUT} /></label>
            <label><span className={LABEL}>计划目标价</span><input name="planned_target" type="number" step="0.01" className={INPUT} /></label>
            <label><span className={LABEL}>复核日</span><input name="due" type="date" className={INPUT} /></label>
            <label><span className={LABEL}>检查点</span><input name="next_check" className={INPUT} placeholder="14:00" /></label>
            <label><span className={LABEL}>有效期至</span><input name="valid_until" type="date" className={INPUT} /></label>
            <label className="sm:col-span-3"><span className={LABEL}>为什么做这笔</span>
              <textarea name="thesis" className={cn(INPUT, "h-16 resize-none")} placeholder="理由写下来，事后才检验得动它还在不在" />
            </label>
            <div className="sm:col-span-3"><button type="submit" className={BTN}><CheckCircle2 className="h-3.5 w-3.5" />保存计划</button></div>
          </form>
        </GlassCard>
      )}

      {data && (
        <div className="space-y-3">
          <Chips d={data} />
          {signal && <MarketPosture signal={signal} />}
          <p className="text-[11px] text-muted-foreground">
            {data.day} {data.hm} · {data.source}
          </p>
          {data.notes.map((n, i) => <p key={i} className="text-[11px] text-amber-700">{n}</p>)}
          {data.issues.length > 0 && (
            <GlassCard className="p-3 text-[11px] text-amber-700">
              有 {data.issues.length} 条计划不合台账规则，已跳过。
            </GlassCard>
          )}
          {GROUPS.map((g) => {
            const list = data.plans.filter(g.match);
            if (!list.length) return null;
            return (
              <section key={g.key}>
                <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <ClipboardCheck className="h-3.5 w-3.5" />{g.label}
                  <span className="tabular-nums">（{list.length}）</span>
                </h2>
                <div className="space-y-2">
                  {list.map((v) => <PlanCard key={v.plan.id} v={v} marketCap={signal?.position_cap_pct ?? null} />)}
                </div>
              </section>
            );
          })}
          {data.plans.length === 0 && (
            <GlassCard className="p-6 text-center text-xs text-muted-foreground">
              还没有计划。写下第一笔，把「止损写了吗」放到买入之前问。
            </GlassCard>
          )}
        </div>
      )}
    </div>
  );
}
