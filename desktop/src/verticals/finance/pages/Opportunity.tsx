import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw, AlertTriangle, Pause, Play } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";
import type { DayOpportunityResult, BoardBreadth } from "@/lib/dayOpportunity";
import { BREADTH_META, widthTone } from "@/lib/dayOpportunity";
import type {
  OpportunityResult, LeaderPick, PlanDraft, SealBucket, SealTiming, MarketFacts, LiveEmotion,
} from "@/lib/opportunity";
import { IGNITION_META, ALLOWANCE_META, ROLE_META, seriesMax } from "@/lib/opportunity";
import { canOpenLabel, type MarketStateResult } from "@/lib/marketState";
import { isMarketTrading } from "@/lib/marketSymbol";
import { useMarketAutoRefresh } from "@/hooks/useMarketAutoRefresh";

/**
 * 机会发现（盘中判断用）。
 *
 * 这一页只服务一个动作：**盘中某一刻，要不要动手、动哪个**。
 * 所以顺序是「现在能不能动 → 哪里在动 → 哪只最硬 → 凭什么 → 什么时候算触发」，
 * 每一步都带**变化量**（相比上一拍）和**证据强度**（有统计支撑 / 只当背景）。
 *
 * 三个数据源各自独立：任一路挂了，其余照常展示（宽度与涨停链的取数速度差很多）。
 */
const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-[14px] text-muted-foreground hover:text-foreground disabled:opacity-50";
const BTN_ON = "inline-flex items-center gap-1.5 rounded-lg border border-info/40 bg-info/10 px-3 py-1.5 text-[14px] text-info";

/** 盘中自动刷新间隔：涨停/炸板是分钟级变化，2 分钟够；再快就是在重复拉同一份数据 */
// 刷新间隔与「切回前台补刷」都在 useMarketAutoRefresh 里（三页共用一份，别在这里再写一遍）

const upDown = (v: number | null | undefined) =>
  v == null ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-muted-foreground";
const signed = (v: number | null | undefined, d = 2) => v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const pct0 = (v: number | null | undefined) => v == null ? "—" : `${(v * 100).toFixed(0)}%`;
const msgOf = (e: unknown) => e instanceof ApiError || e instanceof Error ? e.message : String(e);

/** 北京时间（不受本机时区影响）：分钟数 + HH:MM */
function cnClock(at = new Date()): { minutes: number; hhmm: string } {
  const s = at.toLocaleTimeString("en-GB", { timeZone: "Asia/Shanghai", hour12: false });
  const [h, m] = s.split(":").map(Number);
  return { minutes: (h ?? 0) * 60 + (m ?? 0), hhmm: s.slice(0, 5) };
}

const TH = "border-b border-border/50 px-2.5 py-1.5 text-left font-normal text-muted-foreground";
const TR = "border-b border-border/25 last:border-0";

/**
 * 证据强度标记 —— 这一页存在的理由就是把「有统计支撑的」和「只是背景的」分开摆。
 * 红绿已被涨跌占住，所以「实证」用蓝、「背景」用灰。
 */
function Tag({ kind, hint }: { kind: "signal" | "context"; hint?: string }) {
  return (
    <span
      title={hint}
      className={cn("rounded-full border px-2 py-[2px] text-[13px]",
        kind === "signal" ? "border-info/40 bg-info/10 text-info" : "border-border/60 bg-muted/20 text-muted-foreground")}
    >
      {kind === "signal" ? "实证可用" : "只当背景"}
    </span>
  );
}

function Section({ n, title, tag, hint, extra }: {
  n: string; title: string; tag?: "signal" | "context"; hint?: string; extra?: ReactNode;
}) {
  return (
    <div className="mt-4 mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-[14px] tabular-nums text-muted-foreground/70">{n}</span>
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {tag && <Tag kind={tag} hint={hint} />}
      {extra && <span className="text-[14px] text-muted-foreground">{extra}</span>}
    </div>
  );
}

/** 变化量：Δ 为正标红（涨），为负标绿，0 不显示 —— 盘中判断最需要的就是这个 */
function Delta({ v, unit = "", digits = 0 }: { v: number | null | undefined; unit?: string; digits?: number }) {
  if (v == null || v === 0) return null;
  return (
    <span className={cn("ml-1 text-[13px] tabular-nums", v > 0 ? "text-danger" : "text-success")}>
      {v > 0 ? "+" : ""}{v.toFixed(digits)}{unit}
    </span>
  );
}

// ─── ① 现在能不能动：市场状态 × 板块状态 联动 ─────────────────────────────────

/**
 * 联动结论：**只显示当前这一格**。
 *
 * 两个轴都是本页已有的信号：
 *   纵轴 = 能不能开新仓（`can_open_position` = 仓位上限 ≥ 40% 且非极高风险）
 *   横轴 = 板块有没有成规模的启动（≥3 只涨停且有高度的题材）
 *
 * 🔴 纵轴叫「可开新仓 / 暂不开新仓」，**不叫「闸门开 / 未开」** —— 2026-11-06 用户看到
 *    「上证 > MA20 未过」和「闸门开」同屏，直接问这是不是矛盾。不矛盾，但词用错了：
 *    同一个页面里「闸门」另有所指（上面那排灯 = `gate.all_pass`，三道门全过）。
 *    一票未过时上限被压到 40%，而「能开仓」的门槛也是 40%，于是恰好判成「能开」——
 *    两套判据共用一个词，屏幕上就成了自相矛盾。现在与「市场状态」页统一叫「可开新仓」，
 *    并把上限数字摆在坐标里，让「能开、但只能轻仓」这件事一眼看得出来。
 *
 * 🔴 四格全摆出来是「查表」，盘中要的是「现在这一句」—— 摆四格还把字号挤没了。
 *    所以只留当前格，坐标用一行小字交代（可开新仓/暂不开 × 题材有/没规模），判据不丢。
 * 🔴 `known === false` 时不给任何一格：null 是「不知道」，不是「暂不开新仓」。
 */
const JOINT_CELLS = {
  "on-on": {
    title: "顺势做",
    body: "可开新仓、板块也有规模 —— 按仓位上限分配到具体题材与龙头。",
    tone: "border-info/50 bg-info/[0.08]",
    ink: "text-info",
  },
  "on-off": {
    title: "只有指数在涨",
    body: "可开新仓，但没有题材成规模 —— 别在个股上追，等题材接力。",
    tone: "border-warning/45 bg-warning/[0.07]",
    ink: "text-warning",
  },
  "off-on": {
    title: "逆势启动",
    body: "暂不开新仓，但局部有题材 —— 先当反抽看，只观察第一波、不参与。",
    tone: "border-warning/45 bg-warning/[0.07]",
    ink: "text-warning",
  },
  "off-off": {
    title: "空档",
    body: "暂不开新仓、板块也没起来 —— 今天不动，是最省钱的判断。",
    tone: "border-border/60 bg-muted/[0.12]",
    ink: "text-muted-foreground",
  },
} as const;

function JointVerdict({ offense, hasSector, phase, known, cap }: {
  offense: boolean; hasSector: boolean; phase: string | null; known: boolean;
  /** 仓位上限（%）—— 摆在坐标里，免得「可开新仓」被读成「可以随便买」 */
  cap: number | null;
}) {
  const key = !known ? null
    : offense ? (hasSector ? "on-on" : "on-off")
      : (hasSector ? "off-on" : "off-off");
  const cell = key ? JOINT_CELLS[key] : null;
  const openLabel = offense ? `可开新仓${cap != null ? `（上限 ${cap}%）` : ""}` : "暂不开新仓";

  return (
    <div className="flex h-full flex-col">
      <h3 className="mb-2 text-[14px] font-medium text-muted-foreground">
        市场状态 × 板块状态{phase ? ` · 当前 ${phase}` : ""}
      </h3>
      {cell ? (
        <div
          title={"四种情形：\n顺势做 = 可开新仓 + 题材有规模\n只有指数在涨 = 可开新仓 + 题材没规模\n逆势启动 = 暂不开新仓 + 题材有规模\n空档 = 暂不开新仓 + 题材没规模"}
          className={cn("flex flex-1 flex-col justify-center rounded-lg border px-4 py-4", cell.tone)}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={cn("text-[22px] font-semibold leading-tight", cell.ink)}>{cell.title}</span>
            <span className="text-[13px] tabular-nums text-muted-foreground">
              {openLabel} × 题材{hasSector ? "有规模" : "没规模"}
            </span>
          </div>
          <p className="mt-2 text-[16px] leading-relaxed text-foreground/80">{cell.body}</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col justify-center rounded-lg border border-border/60 bg-muted/[0.1] px-4 py-4">
          <span className="text-[22px] font-semibold leading-tight text-warning">判断不了</span>
          <p className="mt-2 text-[16px] leading-relaxed text-foreground/80">
            市场状态没算出来 —— 没有仓位结论就谈不上联动，此时一律只观察。
          </p>
        </div>
      )}
    </div>
  );
}

/** 三道闸门：广度 / 量能 / MA20。state 由后端给（pass|fail|unknown），不靠文案猜 */
function GateLights({ mkt }: { mkt: MarketStateResult | null }) {
  const items = mkt?.signal.gate_items ?? mkt?.gate?.items ?? [];
  if (!items.length) {
    const blockers = mkt?.signal.gate_blockers ?? [];
    if (!blockers.length) return null;
    return <p className="text-[13px] text-warning">闸门未过：{blockers.join("；")}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] text-muted-foreground">闸门</span>
      {items.map((g) => (
        <span key={g.key} title={g.detail}
          className={cn("rounded border px-2 py-[2px] text-[13px]",
            g.state === "pass" ? "border-info/40 bg-info/10 text-info"
              : g.state === "fail" ? "border-warning/40 bg-warning/10 text-warning"
                : "border-border/50 bg-muted/15 text-muted-foreground")}>
          {g.label} {g.state === "pass" ? "过" : g.state === "fail" ? "未过" : "缺数"}
        </span>
      ))}
    </div>
  );
}

/**
 * 这一页的核心卡：左边市场状态，右边联动矩阵，底下盘口读数（带 Δ）。
 * 🔴 Δ 是相比**上一次刷新**，不是相比昨天 —— 盘中判断看的是「刚刚发生了什么」。
 */
function DecisionPanel({ chain, mkt, delta, staleNote }: {
  chain: OpportunityResult | null;
  mkt: MarketStateResult | null;
  delta: MapDelta | null;
  staleNote: string | null;
}) {
  const sig = mkt?.signal ?? null;
  const m = chain?.market ?? null;
  const live = chain?.live ?? null;

  const canOpen = sig?.can_open_position ?? m?.can_open_position ?? null;
  const offense = canOpen === true;
  const phase = sig?.phase ?? m?.phase ?? null;
  const cap = sig?.position_cap_pct ?? m?.position_cap_pct ?? null;
  const composite = sig?.composite ?? m?.composite ?? null;
  const hasSector = chain?.sectors.some((s) => s.has_sector_effect && s.today >= 3) ?? false;

  const reads: { label: string; value: ReactNode; hint: string }[] = [
    {
      label: "涨停",
      value: <>{live?.limit_up ?? "—"}<Delta v={delta?.limit_up} /></>,
      hint: "东财 push2ex 口径，与涨跌分布端点会差几只",
    },
    {
      label: "炸板",
      value: <>{live?.broken ?? "—"}<Delta v={delta?.broken} /></>,
      hint: "封板后又打开的家数",
    },
    {
      label: "封板率",
      value: <>{pct0(live?.seal_rate)}<Delta v={delta?.seal_rate} unit="pp" digits={1} /></>,
      hint: "涨停 ÷（涨停 + 炸板）",
    },
    {
      label: "赚钱效应",
      value: <span className={upDown(live?.money_effect)}>
        {live?.money_effect == null ? "—" : `${signed(live.money_effect)}%`}
        <Delta v={delta?.money_effect} unit="pp" digits={2} />
      </span>,
      hint: "昨日涨停股今日的中位涨幅：负数就是打板在亏钱",
    },
    {
      label: "最高板",
      value: live?.highest_board == null ? "—" : `${live.highest_board} 板`,
      hint: "只作背景，不做择时（按日配对仅 41% 天成立）",
    },
    {
      label: "跌超5%",
      value: live?.deep_loss ?? "—",
      hint: "昨日涨停股里今天跌超 5% 的只数 —— 打错了要付多少钱",
    },
  ];

  return (
    <GlassCard className={cn("p-4", offense ? "border-info/35" : "border-warning/30")}>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-medium">市场状态</span>
            {sig || m ? (
              <>
                <span className={cn("rounded-full border px-2 py-0.5 text-[14px]",
                  offense ? "border-info/40 bg-info/10 text-info" : "border-warning/40 bg-warning/10 text-warning")}>
                  {phase ?? "—"}
                </span>
                <span className="text-[14px] tabular-nums text-muted-foreground">
                  {composite ?? "—"} 分 · 上限 {cap == null ? "不设" : `${cap}%`}
                </span>
              </>
            ) : (
              <span className="text-[14px] text-warning">市场状态没算出来 → 一律只观察</span>
            )}
          </div>
          <div className="mt-1.5"><GateLights mkt={mkt} /></div>
          {staleNote && <p className="mt-1 text-[13px] text-warning">{staleNote}</p>}

          <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5 border-t border-border/40 pt-2.5">
            {reads.map((r) => (
              <div key={r.label} title={r.hint}>
                <p className="text-[13px] text-muted-foreground">{r.label}</p>
                <p className="text-[16px] font-medium tabular-nums leading-tight">{r.value}</p>
              </div>
            ))}
          </div>
          {live?.as_of && (
            <p className="mt-1 text-[13px] text-muted-foreground">
              盘口读数时间 {live.as_of}{live.sample != null ? ` · 样本 ${live.sample} 只` : ""}
            </p>
          )}
        </div>

        <JointVerdict offense={offense} hasSector={hasSector} phase={phase} known={canOpen != null} cap={cap} />
      </div>
    </GlassCard>
  );
}

// ─── ② 哪里在动：板块宽度 ──────────────────────────────────────────────────────

/** 近 N 日宽度小柱：历史灰、今日按档位着色。只画上涨占比，不拆涨/平/跌（没有平盘只数） */
function WidthSpark({ b }: { b: BoardBreadth }) {
  const pts = [...b.history.map((h) => h.up_rate), b.up_rate];
  return (
    <div className="flex items-end gap-[2px]" title={`近 ${pts.length} 日上涨占比：${pts.map((r) => pct0(r)).join(" / ")}`}>
      {pts.map((r, i) => (
        <div key={i}
          className={cn("w-[4px] rounded-[1px]", i === pts.length - 1 ? widthTone(r) : "bg-muted-foreground/30")}
          style={{ height: `${Math.max(4, r * 18)}px` }} />
      ))}
    </div>
  );
}

function BreadthRow({ b, baseRate }: { b: BoardBreadth; baseRate: number | null }) {
  const meta = BREADTH_META[b.state];
  const ex = b.rel_width_delta_pp;
  // 裸差为正但超额为负 = 被大盘抬上去的，不是板块变强
  const fake = b.width_delta_pp != null && b.width_delta_pp > 3 && ex != null && ex < 0;
  return (
    <tr className={TR}>
      <td className="px-2.5 py-2">
        <span className="font-medium">{b.name}</span>
        {b.truncated && <span className="ml-1 text-[13px] text-warning" title="只拿到前 30 只成分，广度不可信">仅30只</span>}
      </td>
      <td className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative h-2.5 w-16 overflow-hidden rounded-sm bg-muted/40"
            title={`${b.quoted} 只有行情，其中 ${b.up} 只上涨；同日基准 ${baseRate == null ? "—" : pct0(baseRate)}`}>
            <div className={cn("h-full", meta.bar)} style={{ width: `${Math.min(100, b.up_rate * 100)}%` }} />
          </div>
          <span className="w-10 tabular-nums text-[14px]">{pct0(b.up_rate)}</span>
        </div>
      </td>
      <td className="px-2.5 py-2"><WidthSpark b={b} /></td>
      <td className={cn("px-2.5 py-2 tabular-nums", ex == null ? "text-muted-foreground" : ex > 0 ? "text-danger" : "text-success")}
        title="超额宽度变化 =（今日上涨占比 − 基准）−（昨日上涨占比 − 基准）">
        {ex == null ? "—" : `${signed(ex, 1)}pp`}
        {fake && <span className="ml-1 text-[13px] text-warning" title="裸差为正、扣掉大盘后为负">裸正超负</span>}
      </td>
      <td className={cn("px-2.5 py-2 text-right tabular-nums", upDown(b.median))}>{signed(b.median)}%</td>
      <td className={cn("px-2.5 py-2 text-right tabular-nums", upDown(b.rel_median))}>{signed(b.rel_median, 1)}pp</td>
      <td className="px-2.5 py-2 text-right tabular-nums">
        <span className="text-danger">{b.over5}</span><span className="text-muted-foreground">/</span><span className="text-success">{b.deep_loss}</span>
      </td>
      <td className="px-2.5 py-2">
        <span className={cn("rounded-full border px-2 py-[2px] text-[13px]", meta.color)} title={meta.hint}>{b.state}</span>
      </td>
    </tr>
  );
}

function BreadthTable({ day }: { day: DayOpportunityResult }) {
  const base = day.universe?.up_rate ?? null;
  const u = day.universe;
  return (
    <GlassCard className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr>
              <th className={TH}>行业</th>
              <th className={TH}>今日上涨占比</th>
              <th className={TH} title="近几个交易日 + 今天（今天按档位着色）">近 5 日</th>
              <th className={TH} title="扣掉同日大盘基准后的相对变化">超额变化</th>
              <th className={cn(TH, "text-right")}>中位涨幅</th>
              <th className={cn(TH, "text-right")} title="本板块中位涨幅 − 全市场样本中位涨幅">相对强度</th>
              <th className={cn(TH, "text-right")} title="涨超5% / 跌超5% 只数">涨5/跌5</th>
              <th className={TH}>状态</th>
            </tr>
          </thead>
          <tbody>
            {day.boards.map((b) => <BreadthRow key={b.index_code || b.name} b={b} baseRate={base} />)}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/40 px-2.5 py-2 text-[13px] text-muted-foreground">
        {u && (
          <span>
            全市场样本 {u.quoted} 只：上涨 <b className="text-danger">{pct0(u.up_rate)}</b>、
            中位 <b className={upDown(u.median)}>{signed(u.median)}%</b>、
            涨超5% <b className="text-danger">{u.over5}</b>、跌超5% <b className="text-success">{u.deep_loss}</b>
          </span>
        )}
        <span>「超额」必须减掉大盘 —— 实测裸差有 44% 的情况下符号是错的</span>
      </div>
    </GlassCard>
  );
}

// ─── ③ 哪只封得死：题材 → 龙头 ─────────────────────────────────────────────────

function SealCell({ l }: { l: LeaderPick }) {
  if (l.seal_ratio == null) return <span className="text-muted-foreground" title="没拿到封单数据 —— 这不是「软」">—</span>;
  const hard = l.seal_ratio >= 3;
  const mid = l.seal_ratio >= 1.5;
  return (
    <span className={cn("tabular-nums", hard ? "text-danger" : mid ? "text-foreground/85" : "text-muted-foreground")}
      title={hard ? "封单 ≥3% 流通市值：回溯次日再涨停 57%"
        : mid ? "封单 1.5~3%：回溯次日再涨停 42%"
          : "封单 <1.5%：回溯次日再涨停只有 15%，最软的一档"}>
      {l.seal_ratio}%{l.seal_grade && <span className="ml-0.5 text-[13px] opacity-70">{l.seal_grade}</span>}
    </span>
  );
}

function LeaderCell({ l }: { l: LeaderPick }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium">{l.name}</span>
      <span className="ml-1 tabular-nums text-muted-foreground">{l.code}</span>
      <span className={cn("ml-1 rounded border px-1.5 py-[2px] text-[13px]", ROLE_META[l.role].color)} title={ROLE_META[l.role].hint}>
        {l.role}
      </span>
    </span>
  );
}

function SectorRows({ s, prevToday }: { s: OpportunityResult["sectors"][number]; prevToday: Map<string, number> | undefined }) {
  const meta = IGNITION_META[s.state];
  const lead = s.leaders.find((l) => l.role === "龙头") ?? s.leaders[0] ?? null;
  const rest = s.leaders.filter((l) => l !== lead);
  const c = s.continuation;
  const max = seriesMax(s.series);
  const prev = prevToday?.get(s.tag);
  const dToday = prev == null ? null : s.today - prev;

  return (
    <tbody className="border-b border-border/40 last:border-0">
      <tr>
        <td className="px-2.5 py-2 align-top">
          <div className="flex flex-wrap items-center gap-1">
            <span className="font-medium">{s.tag}</span>
            <span className={cn("rounded-full border px-2 py-[2px] text-[13px]", meta.color)} title={meta.desc}>{s.state}</span>
            {!s.has_sector_effect && (
              <span className="rounded border border-dashed border-border/60 px-1 text-[13px] text-muted-foreground"
                title="≥3 只涨停且高度 ≥2 才算板块效应；不满足时里面的票只能算个股行为">无板块效应</span>
            )}
          </div>
        </td>
        <td className="px-2.5 py-2 align-top">
          <div className="flex items-center gap-1">
            <span className="w-7 text-right font-medium tabular-nums">{s.today}</span>
            <Delta v={dToday} />
            <div className="flex items-end gap-[2px]" title={`近 ${s.series.length} 日涨停只数：${s.series.map((v) => v ?? "缺").join(" / ")}`}>
              {s.series.map((v, i) => (
                <div key={i}
                  className={cn("w-[4px] rounded-[1px]", v == null ? "border border-dashed border-border/60" : v === 0 ? "bg-muted-foreground/20" : "bg-danger/60")}
                  style={{ height: `${Math.max(4, ((v ?? 0) / max) * 18)}px` }} />
              ))}
            </div>
          </div>
        </td>
        <td className="px-2.5 py-2 align-top tabular-nums">
          {s.highest}<span className="text-muted-foreground"> 板</span>
          <span className="ml-1 text-[13px] text-muted-foreground">首{s.first_boards}/连{s.consec_boards}</span>
        </td>
        <td className="px-2.5 py-2 align-top tabular-nums">
          {c.rate == null ? (
            c.prev_limit_up === 0
              ? <span className="text-[13px] text-danger" title="昨日这个题材一只涨停都没有 —— 全新方向">全新</span>
              : <span className="text-muted-foreground" title="延续率没取到">—</span>
          ) : (
            <span className={c.rate >= 0.5 ? "text-danger" : c.rate >= 0.2 ? "text-foreground/85" : "text-success"}
              title={`昨日 ${c.prev_limit_up} 只涨停，今天 ${c.still_up} 只仍涨停`}>
              {pct0(c.rate)}<span className="ml-0.5 text-[13px] text-muted-foreground">{c.still_up}/{c.prev_limit_up}</span>
            </span>
          )}
        </td>
        <td className="px-2.5 py-2 align-top">{lead ? <LeaderCell l={lead} /> : <span className="text-muted-foreground">无成员明细</span>}</td>
        <td className="px-2.5 py-2 align-top">{lead ? <SealCell l={lead} /> : "—"}</td>
        <td className="px-2.5 py-2 align-top tabular-nums text-muted-foreground" title="最后封板时间（不是首封）">{lead?.last_seal ?? "—"}</td>
        <td className={cn("px-2.5 py-2 align-top text-right tabular-nums", upDown(lead?.quote?.change_pct))}>
          {lead?.quote?.change_pct == null ? "—" : `${signed(lead.quote.change_pct)}%`}
        </td>
      </tr>
      {rest.length > 0 && (
        <tr>
          <td colSpan={8} className="px-2 pb-1.5 pt-0">
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-1 text-[13px] text-muted-foreground">
              <span>其余 {rest.length} 只：</span>
              {rest.map((l) => (
                <span key={l.code} className="whitespace-nowrap">
                  {l.name}<span className="ml-0.5 opacity-60">{l.role}</span>
                  <span className={cn("ml-1 tabular-nums", l.seal_ratio != null && l.seal_ratio >= 1.5 && "text-foreground/70")}>
                    {l.seal_ratio == null ? "—" : `${l.seal_ratio}%`}
                  </span>
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </tbody>
  );
}

function SectorTable({ chain, prevToday }: { chain: OpportunityResult; prevToday: Map<string, number> | undefined }) {
  const shown = chain.sectors.slice(0, 8);
  return (
    <GlassCard className="overflow-hidden p-0">
      {shown.length === 0 ? (
        <p className="p-4 text-center text-[14px] text-muted-foreground">
          今天没有取到有涨停的题材 —— 不是「没有机会」，是题材结构端点没给数据（见下方缺口）。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr>
                <th className={TH}>题材</th>
                <th className={TH} title="今日涨停只数 + 相比上一拍的变化 + 近 5 日序列">涨停</th>
                <th className={TH}>高度</th>
                <th className={TH} title="昨日该题材涨停股今天仍涨停的比例">延续</th>
                <th className={TH}>龙头</th>
                <th className={TH} title="封单 ÷ 流通市值：两只都封板时，这个数才是「哪只更硬」">封单</th>
                <th className={TH} title="最后封板时间（不是首封）">末封</th>
                <th className={cn(TH, "text-right")}>今日</th>
              </tr>
            </thead>
            {shown.map((s) => <SectorRows key={s.tag} s={s} prevToday={prevToday} />)}
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/40 px-2.5 py-2 text-[13px] text-muted-foreground">
        <span>按今日涨停只数降序，不做加权总分</span>
        {chain.sectors.length > shown.length && <span>另有 {chain.sectors.length - shown.length} 个题材未列出</span>}
        <span>「延续」空白（非 0%）= 昨日没这个题材</span>
      </div>
    </GlassCard>
  );
}

// ─── ④ 凭什么：三套证据 ───────────────────────────────────────────────────────

function FactorRow({ label, n, rate, ret, hint }: {
  label: string; n: number | null; rate: number | null; ret: number | null; hint?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[14px]" title={hint}>
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="relative h-1.5 w-full overflow-hidden rounded-sm bg-muted/30">
        <div className="h-full bg-danger/70" style={{ width: `${Math.min(100, (rate ?? 0) * 100)}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right font-medium tabular-nums text-danger">{rate == null ? "—" : pct0(rate)}</span>
      <span className={cn("w-14 shrink-0 text-right tabular-nums", upDown(ret))}>{ret == null ? "" : `${signed(ret, 1)}%`}</span>
      <span className="w-12 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">{n == null ? "" : `${n}只`}</span>
    </div>
  );
}

/** 封单厚度的回溯基准（常量）：API 只给单票档位，分档统计是离线跑出来的 */
const SEAL_BASELINE = [
  { label: "≥3% 硬", rate: 0.57, ret: 9.97 },
  { label: "1.5~3% 中", rate: 0.42, ret: 3.4 },
  { label: "<1.5% 软", rate: 0.15, ret: -2.1 },
];

function SealTimingBuckets({ t }: { t: SealTiming }) {
  const trend = t.trend && t.trend.days > 0 ? t.trend : null;
  const usable = !!trend && trend.buckets.some((b) => b.n >= 100);
  const buckets: SealBucket[] = usable && trend ? trend.buckets : t.buckets;
  return (
    <>
      <p className="mb-1.5 text-[13px] text-muted-foreground">
        {usable && trend
          ? `近 ${trend.days} 个交易日 · 累计 ${trend.sample} 只`
          : `${t.prev_date ?? "—"} 单日 · ${t.sample} 只 —— 单日样本太薄，只当噪声`}
      </p>
      <div className="space-y-1">
        {buckets.map((b) => (
          <FactorRow key={b.label} label={b.label} n={b.n} rate={b.still_up_rate} ret={b.avg_ret}
            hint={`次日再涨停 ${b.still_up}/${b.n}`} />
        ))}
      </div>
    </>
  );
}

function TierBuckets({ f }: { f: MarketFacts }) {
  return (
    <>
      <p className="mb-1.5 text-[13px] text-muted-foreground">
        昨日 {f.prev_date ?? "—"} 各档涨停股，今天去哪了{f.sample != null ? ` · ${f.sample} 只` : ""}
      </p>
      <div className="space-y-1">
        {f.tiers.slice(0, 4).map((t) => (
          <FactorRow key={t.tier} label={t.tier} n={t.total} rate={t.promotion_rate} ret={null}
            hint={t.buckets.map((b) => `${b.label}${b.count}`).join(" / ")} />
        ))}
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">条长 = 晋级率；悬停看各档去向明细</p>
    </>
  );
}

function Evidence({ chain }: { chain: OpportunityResult }) {
  return (
    <div className="grid gap-2.5 lg:grid-cols-3">
      <GlassCard className="p-3">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[14px] font-medium">封单厚度</span>
          <Tag kind="signal" hint="18 个交易日 631 只，按日配对 14/14 天方向一致" />
        </div>
        <div className="space-y-1">
          {SEAL_BASELINE.map((b) => <FactorRow key={b.label} label={b.label} n={null} rate={b.rate} ret={b.ret} />)}
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
          条长 = 次日再涨停率。流通市值 &gt;200 亿的票基本做不到 1.5% 以上，这一维对大盘股失效。
        </p>
      </GlassCard>

      <GlassCard className="p-3">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[14px] font-medium">末封时点</span>
          <Tag kind="signal" hint="按日配对 13/14 天方向一致" />
        </div>
        {chain.seal_timing ? <SealTimingBuckets t={chain.seal_timing} />
          : <p className="text-[14px] text-muted-foreground">封板时点数据没取到</p>}
        <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
          量的是「最后一次封住」不是「多快涨停」—— 首封早但被砸开的，反而更差。
        </p>
      </GlassCard>

      <GlassCard className="p-3">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[14px] font-medium">昨日高度 → 今日</span>
          <Tag kind="context" hint="每天每档只有 3~14 只，按日配对仅 7/17 天成立" />
        </div>
        {chain.facts ? <TierBuckets f={chain.facts} />
          : <p className="text-[14px] text-muted-foreground">打板反馈没取到</p>}
        <p className="mt-1.5 text-[13px] leading-snug text-warning">
          每日样本太薄，本页不据此排序，也不提示「几板是坑」。
        </p>
      </GlassCard>
    </div>
  );
}

// ─── ⑤ 盯什么：条件式规划（盘中当作触发清单） ─────────────────────────────────

function PlanRow({ p }: { p: PlanDraft }) {
  const meta = ALLOWANCE_META[p.allowance];
  return (
    <div className="border-b border-border/40 px-3 py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("rounded-full border px-2 py-[2px] text-[13px]", meta.color)}>{p.allowance}</span>
        <span className="text-[14px] text-muted-foreground">{p.sector}</span>
        <span className="text-muted-foreground">→</span>
        <span className="text-[16px] font-semibold">{p.name}</span>
        <span className="text-[14px] tabular-nums text-muted-foreground">{p.symbol}</span>
        <span className={cn("rounded border px-1.5 py-[2px] text-[13px]", ROLE_META[p.role].color)}>{p.role}</span>
        <span className="text-[13px] text-muted-foreground">{p.allowance_note}</span>
      </div>
      <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
        {([
          ["看什么", p.watch, "text-muted-foreground"],
          ["算触发", p.trigger, "text-danger"],
          ["算失效", p.invalidate, "text-success"],
        ] as const).map(([label, items, tone]) => (
          <div key={label} className="rounded border border-border/40 bg-muted/[0.08] px-2 py-1">
            <p className={cn("mb-0.5 text-[13px] font-medium", tone)}>{label}</p>
            <ul className="space-y-0.5">
              {items.map((t, i) => <li key={i} className="text-[13.5px] leading-snug">{t}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">{p.sizing}</p>
    </div>
  );
}

// ─── 页面 ─────────────────────────────────────────────────────────────────────

/**
 * 「数据是几秒前取的」—— 只有它自己每秒重渲染。
 * 🔴 别把秒表放在页面级 state 上：三张表会跟着每秒 reconcile 一遍，盘中白烧 CPU。
 */
function Freshness({ at }: { at: number | null }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => bump((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (at == null) return null;
  // 非交易时段不会自动刷新，「387s 前取的」只会一路涨到几千秒，看着像故障。
  // 这个数字只在盘中才有判断价值（够不够新鲜），盘前改成绝对时刻。
  if (!isMarketTrading("CN")) {
    const hm = new Date(at).toLocaleTimeString("en-GB", { timeZone: "Asia/Shanghai", hour12: false }).slice(0, 5);
    return <span title="本页最近一次取数的时间（非交易时段不自动刷新）">数据 {hm} 取的</span>;
  }
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return <span title="本页最近一次取数的时间">数据 {s}s 前取的</span>;
}

/** 相比上一拍的变化（盘中判断只看这个，不看「相比昨天」） */
interface MapDelta {
  limit_up: number | null;
  broken: number | null;
  seal_rate: number | null;
  money_effect: number | null;
  sectors: Map<string, number>;
  at: number;
}

/**
 * `embedded` = 嵌在「盯盘 · 市场实时概况」里，标题与分页由外层给，
 * 这里只留一行紧凑的工具条（自动刷新 + 刷新 + 时效），省掉一层标题。
 */
export function Opportunity({ embedded = false }: { embedded?: boolean } = {}) {
  const [day, setDay] = useState<DayOpportunityResult | null>(null);
  const [chain, setChain] = useState<OpportunityResult | null>(null);
  const [mkt, setMkt] = useState<MarketStateResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [delta, setDelta] = useState<MapDelta | null>(null);
  const [auto, setAuto] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const seq = useRef(0);
  /** 最近一次**跑完整轮**取数的时刻（`fetchedAt` 的 ref 版：给事件回调读，不触发重渲染） */
  const loadedAt = useRef(0);
  const prevRef = useRef<{ live: LiveEmotion | null; today: Map<string, number>; at: number } | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    const errs: string[] = [];
    const push = (label: string, e: unknown) => errs.push(`${label}：${msgOf(e)}`);
    // 三源互不依赖：谁先回来谁先上屏（宽度与涨停链的耗时差得很远）
    await Promise.allSettled([
      backend.dayOpportunity({ refresh }).then((v) => { if (my === seq.current) setDay(v); }).catch((e) => push("板块宽度", e)),
      backend.opportunityChain({ refresh }).then((v) => { if (my === seq.current) setChain(v); }).catch((e) => push("涨停链", e)),
      backend.marketState({ refresh }).then((v) => { if (my === seq.current) setMkt(v); }).catch((e) => push("市场状态", e)),
    ]);
    if (my !== seq.current) return;
    setErrors(errs);
    // 三源全挂时不许记「刚取过」：那会把屏上的旧数说成新的,还会压住「切回前台补刷」——
    // 偏偏这时候最该重试。与 MarketState 页同一个口径:只有真拿到数据才算跑完一轮。
    if (errs.length === 0) {
      loadedAt.current = Date.now();
      setFetchedAt(Date.now());
    }
    setLoading(false);
  }, []);

  // 换了一拍：先记下与上一拍的差，再把这一拍存成「上一拍」
  useEffect(() => {
    if (!chain) return;
    const prev = prevRef.current;
    const today = new Map(chain.sectors.map((s) => [s.tag, s.today] as const));
    if (prev) {
      setDelta({
        limit_up: prev.live?.limit_up != null && chain.live?.limit_up != null ? chain.live.limit_up - prev.live.limit_up : null,
        broken: prev.live?.broken != null && chain.live?.broken != null ? chain.live.broken - prev.live.broken : null,
        seal_rate: prev.live?.seal_rate != null && chain.live?.seal_rate != null
          ? (chain.live.seal_rate - prev.live.seal_rate) * 100 : null,
        money_effect: prev.live?.money_effect != null && chain.live?.money_effect != null
          ? chain.live.money_effect - prev.live.money_effect : null,
        sectors: today,
        at: Date.now(),
      });
    }
    prevRef.current = { live: chain.live, today, at: Date.now() };
  }, [chain]);

  useEffect(() => { void load(false); }, [load]);

  /**
   * 🔴 缺口 / 降级 / 陈旧说明必须在 `useAiPage` **之前**算好。
   *    以前这四行定义在下面渲染区（useAiPage 之后），于是界面上「N 项缺口 / 降级提示」
   *    只给人看，喂给 AI 的上下文一个字都没带 —— 模型拿到的是一份没有任何缺口标注的
   *    「完整」盘中判断，缺口被静默抹平。与「算不出来不许写成不可开新仓」同一条纪律。
   */
  const gaps = [...(day?.gaps ?? []), ...(chain?.gaps ?? [])];
  const notes = [...(day?.notes ?? []), ...(chain?.notes ?? [])];
  const staleDims = mkt?.signal.stale_dimensions ?? [];
  const staleNote = staleDims.length ? `这些维度不是当日数据：${staleDims.join("、")}` : null;

  /**
   * 盘中自动刷新：交易时段每 2 分钟一次 + 切回前台若已过期立刻补。
   * 这两条原来在本文件里手写，`MarketState` / `ShortlineOpportunities` / `TradePlans`
   * 三页则连定时器都没有 —— 收到 `useMarketAutoRefresh` 一处，四页行为对齐。
   */
  useMarketAutoRefresh({
    enabled: auto,
    onTick: () => { void load(false); },
    loadedAt: loadedAt.current,
  });

  useAiPage({
    key: "opportunity",
    title: "机会发现",
    context: (day || chain)
      ? `机会发现（盘中判断 · ${chain?.date ?? day?.date ?? "—"} ${chain?.clock ?? day?.clock ?? ""}，${(chain?.settled ?? day?.settled) ? "已收盘" : "盘中"}）：\n`
        // 🔴 市场状态只有一份：优先 `mkt.signal`（带闸门数据，与「市场状态」页同源），
        //    `chain.market` 是机会链端点顺手算的简版，闸门不全会给出更宽的上限（实测 0% vs 20%）。
        //    两处数字必须同源，否则屏幕上写 0%、喂给 AI 的却是 20%。
        + (() => {
          const s = mkt?.signal ?? null;
          const ph = s?.phase ?? chain?.market?.phase ?? null;
          const cp = s?.position_cap_pct ?? chain?.market?.position_cap_pct ?? null;
          const co = s?.can_open_position ?? chain?.market?.can_open_position ?? null;
          const cb = s?.composite ?? chain?.market?.composite ?? null;
          // 🔴 can_open_position 是三态：null = 算不出来（不给仓位上限），
          //    旧的两态写法把 null 与 false 合并成一句「不可开新仓」，会把「不知道」
          //    变成一条禁止性结论；下面统一走三态纯函数，别再复制旧的模板字符串。
          const canOpen = canOpenLabel(co);
          return ph
            ? `市场状态：${ph} · ${cb} 分 · 仓位上限 ${cp == null ? "不设" : `${cp}%`} · ${canOpen}\n`
            : "市场状态：没算出来\n";
        })()
        + (mkt ? "" : "⚠️ 市场状态这一路本次没取到：下面的读数可能来自机会链的简版（闸门不全、仓位上限偏宽）或干脆缺失，不要当作完整判断。\n")
        + (errors.length ? `本轮取数失败：${errors.join("；")}\n` : "")
        + (gaps.length ? `数据缺口：${gaps.join("；")}\n` : "")
        + (notes.length ? `降级提示：${notes.join("；")}\n` : "")
        + (staleNote ? `${staleNote}\n` : "")
        + `此刻：涨停 ${chain?.live?.limit_up ?? "—"} / 炸板 ${chain?.live?.broken ?? "—"} / 封板率 ${pct0(chain?.live?.seal_rate)}，赚钱效应 ${chain?.live?.money_effect ?? "—"}%\n`
        + (day ? `板块宽度：${day.boards.map((b) => `${b.name}(${b.state}·上涨${pct0(b.up_rate)}·超额${b.rel_width_delta_pp == null ? "—" : signed(b.rel_width_delta_pp, 1) + "pp"})`).join("；")}\n` : "板块宽度没取到\n")
        + (chain ? `题材：${chain.sectors.map((s) => `${s.tag}(${s.state}·${s.today}只·最高${s.highest}板·龙头${s.leaders[0]?.name ?? "—"}·封单${s.leaders[0]?.seal_ratio ?? "—"}%)`).join("；")}\n` : "题材没取到\n")
        + `规划：${chain?.plans.map((p) => `${p.sector}→${p.name}(${p.allowance})`).join("；") || "本轮无"}\n`
        + "注意：宽度是背景不是预测信号；封单厚度与末封时点是仅有两条按日配对站得住的因子；连板高度每日样本太薄，不做择时。"
      : "机会发现：还没取到。",
    suggestions: ["现在这个状态该做什么", "这个封单厚度意味着什么", "为什么不用连板高度判断"],
  });

  if (!day && !chain) {
    return (
      <div>
        {!embedded && <PageHeader title="机会发现" subtitle="盘中判断：现在能不能动 → 哪里在动 → 哪只封得死 → 什么时候算触发。" />}
        {errors.map((e) => (
          <p key={e} role="alert" className="mb-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[14px] text-destructive">{e}</p>
        ))}
        <p role="status" className="py-12 text-center text-[16px] text-muted-foreground">
          正在取数…市场状态 + 中证行业成分与全市场行情 + 宽度回溯 + 题材结构 / 轮动 / 连板天梯 / 盘中情绪，多源并行。
        </p>
      </div>
    );
  }

  // gaps / notes / staleDims / staleNote 已上移到 useAiPage 之前（界面与 AI 上下文共用一份）。
  const trading = isMarketTrading("CN");
  const { minutes } = cnClock();
  const leftMin = trading ? Math.max(0, (minutes <= 11 * 60 + 30 ? 11 * 60 + 30 : 15 * 60) - minutes) : null;

  /**
   * 🔴 `settled=false` 有两种完全不同的情况：**真的在盘中**，以及**还没开盘**。
   *    2026-11-06 08:40 实测：盘前这一屏标着「盘中 · 实时」，而内容全是上一交易日收盘的
   *    （涨停 / 炸板 / 封板率一律「—」，闸门三项是 11-05 的数）—— 等于把昨收冒充成今天实时。
   *    盘前物理上没有当日数据，所以这里不是「去取实时」，而是**不许自称实时**。
   */
  const settledNow = chain?.settled ?? day?.settled ?? null;
  const preOpen = !trading && minutes < 9 * 60 + 15;
  const statusChip = settledNow === true
    ? { text: "已收盘（定格）", cls: "border-border/60" }
    : trading
      ? { text: "盘中 · 实时", cls: "border-danger/40 bg-danger/10 text-danger" }
      : preOpen
        ? { text: "盘前 · 读数为上一交易日收盘", cls: "border-warning/40 bg-warning/[0.07] text-warning" }
        : { text: "非交易时段 · 读数为上一交易日收盘", cls: "border-border/60" };

  const meta: ReactNode = (
    <>
      <span className="tabular-nums">{chain?.date ?? day?.date} {chain?.clock ?? day?.clock}</span>
      <span className={cn("rounded-full border px-2 py-[2px]", statusChip.cls)}>
        {statusChip.text}
      </span>
      {trading && leftMin != null && <span className="text-warning">距本段收盘 {leftMin} 分钟</span>}
      {staleNote && <span className="text-warning">{staleNote}</span>}
      <Freshness at={fetchedAt} />
      {delta && (
        <span className="text-info">Δ = 相比上一拍（{new Date(delta.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Shanghai", hour12: false })}）</span>
      )}
    </>
  );

  const buttons = (
    <>
      <button type="button" className={auto ? BTN_ON : BTN} onClick={() => setAuto((v) => !v)}
        title={auto
          ? (trading ? "已开启：每 2 分钟自动取一次" : "已开启：开盘（09:15）后每 2 分钟取一次；现在是盘前，没有当日数据可刷")
          : "已暂停自动刷新"}>
        {auto ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        {/* 🔴 只说「开」不够：定时器每 2 分钟都触发，但非交易时段一律跳过 —— 用户看到
            「自动刷新 开」+「数据 387s 前取的」会以为坏了。2026-11-06 09:02 实测就是这个情形
            （isMarketTrading 从 09:15 起才为 true）。把「开盘后才生效」写在按钮上。 */}
        {auto ? (trading ? "自动刷新 开" : "自动刷新 开（开盘后生效）") : "自动刷新 关"}
      </button>
      <button type="button" className={BTN} onClick={() => void load(true)} disabled={loading}>
        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />{loading ? "取数中…" : "刷新"}
      </button>
    </>
  );

  return (
    <div>
      {embedded ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">{meta}</div>
          <div className="flex items-center gap-2">{buttons}</div>
        </div>
      ) : (
        <>
          <PageHeader
            title="机会发现"
            subtitle="盘中判断：现在能不能动 → 哪里在动 → 哪只封得死 → 什么时候算触发。只给判据和条件，不给买卖建议。"
            actions={buttons}
          />
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">{meta}</div>
        </>
      )}

      {errors.map((e) => (
        <p key={e} role="alert" className="mb-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[14px] text-destructive">{e}</p>
      ))}

      <DecisionPanel chain={chain} mkt={mkt} delta={delta} staleNote={staleNote} />

      {day ? (
        <>
          <Section n="①" title="哪里在动" tag="context"
            hint="宽度告诉你今天钱在哪个板块、参与面在扩还是缩；它不预测明天（扣掉大盘后与次日涨幅的秩相关 ≈ 0）"
            extra={`${day.boards.length} 个中证一级行业 · 回溯 ${day.breadth_history.days} 个交易日`} />
          <BreadthTable day={day} />
        </>
      ) : (
        <p className="mt-3 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[14px] text-warning">
          板块宽度没取到 —— 只剩涨停链，「哪只封得死」仍然有效，但判断不了「早不早」。
        </p>
      )}

      {chain ? (
        <>
          <Section n="②" title="哪只封得死" tag="signal"
            hint="题材状态是背景；封单与末封两列才有统计支撑"
            extra="按今日涨停只数降序 · 龙头下的灰字是其余成员及封单%" />
          <SectorTable chain={chain} prevToday={delta?.sectors} />
        </>
      ) : (
        <p className="mt-3 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[14px] text-warning">
          涨停链没取到 —— 只有宽度时能判断「早」，判断不了「能不能打」。
        </p>
      )}

      {chain && (
        <>
          <Section n="③" title="凭什么" extra="三条证据按可信度排：封单厚度 > 末封时点 > 连板高度 · 条长 = 次日再涨停率" />
          <Evidence chain={chain} />
        </>
      )}

      {chain && (
        <>
          <Section n="④" title="盯什么" extra="盘中当作触发清单：等哪一条出现才算数，出现哪一条就算失效" />
          <GlassCard className="overflow-hidden p-0">
            {chain.plans.length === 0 ? (
              <p className="p-4 text-center text-[14px] text-muted-foreground">
                这一轮没有「板块效应 + 龙头」的组合，所以没有规划 —— 独苗连板不算板块机会。
              </p>
            ) : chain.plans.map((p) => <PlanRow key={`${p.sector}-${p.symbol}`} p={p} />)}
          </GlassCard>
        </>
      )}

      <details className="mt-4 rounded-lg border border-border/50 bg-muted/[0.06] px-3 py-2">
        <summary className="cursor-pointer text-[14px] text-muted-foreground hover:text-foreground">
          口径、缺口与免责（点开）
          {gaps.length > 0 && <span className="ml-2 text-warning">{gaps.length} 项缺口</span>}
        </summary>
        <div className="mt-2 space-y-2 text-[13.5px] leading-snug text-muted-foreground">
          {gaps.length > 0 && (
            <div>
              <p className="mb-0.5 flex items-center gap-1 font-medium text-warning"><AlertTriangle className="h-3 w-3" />这一轮缺了什么</p>
              <ul className="space-y-0.5">{gaps.map((g, i) => <li key={i}>· {g}</li>)}</ul>
            </div>
          )}
          <ul className="space-y-1">
            <li>
              · <b className="text-foreground/80">联动矩阵</b>的纵轴是市场状态算出来的「能不能开新仓」，不是本页自己判断的；
              横轴是「≥3 只涨停且有高度」的题材是否存在。两轴都缺数据时矩阵不显示当前格，只显示中性态。
            </li>
            <li>
              · <b className="text-foreground/80">宽度</b>是成分股广度（上涨只数占比），来自中证一级行业成分；
              历史来自通达信盘后包回溯，不是一天天攒 —— 第一天打开就有 5 根柱子。但它用今日成分清单回看历史，成分调整会让老日子有偏差；
              今日是实时、历史是收盘定格，盘中那根会偏高估。
            </li>
            <li>
              · <b className="text-foreground/80">超额宽度</b>一定要减基准。8 个交易日里全市场上涨占比在 9.6%~81.2% 之间摆，
              大盘 81% 上涨那天十个板块九个都在 60% 以上；实测裸差有 44% 的情况下符号是错的。
            </li>
            <li>
              · <b className="text-foreground/80">宽度不是预测信号。</b>10 个板块 × 7 个相邻日（n=70）：裸宽度对次日超额涨幅秩相关 +0.27，
              扣掉大盘后只剩 +0.03。它的用途是确认今天钱在哪，不是明天买什么 —— 所以它标「只当背景」。
            </li>
            <li>
              · <b className="text-foreground/80">封单厚度</b>（封单 ÷ 流通市值）来自 18 个交易日 631 只的回溯：
              &gt;3% 次日再涨停 57%、1.5~3% 42%、&lt;1.5% 仅 15%；同市值层内仍有效，按日配对 14/14 天方向一致。
              卡片上的分档数值是离线回溯的<b className="text-foreground/80">基准值</b>，不随当日数据更新。
            </li>
            <li>
              · <b className="text-foreground/80">末封时点</b>指「最后一次封住的时间」，不是首封。首封 &lt;10:00 只有 29% / −0.05%，
              末封 &lt;10:00 却有 38% / +2.74%；10:00~11:30 那档最差（15% / −1.71%）。
            </li>
            <li>
              · <b className="text-warning">连板高度不能做择时。</b>「2 板比其余差」整体中位 −2.03% 很漂亮，
              但按日配对只有 7/17 天（41%）成立 —— 每天 2 板只有 3~14 只，单日中位数被一两只极端票决定。
            </li>
            <li>
              · 龙头排序按「连板高度 → 开板次数 → 首封时间」，封单占比只作硬度读数、不参与排序。
              连板天梯的晋级率统计的是上一个档位（N−1 → N），不能当龙头明天的晋级概率。
            </li>
            <li>
              · 行业资金流为新浪口径（流入−流出，非东财主力净额），只有当日一档；
              题材名（固态电池）与行业名（有色金属）不是一套命名，无法 join，只作旁证。
            </li>
            {notes.map((n, i) => <li key={i}>· {n}</li>)}
            <li>· 以上全部为客观读数与条件记录，<b>不构成投资建议，不替你做决定</b>。</li>
          </ul>
        </div>
      </details>
    </div>
  );
}
