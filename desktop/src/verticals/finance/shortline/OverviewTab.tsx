/**
 * 盯盘 · 市场实时概况:指数实时、全市场涨跌分布、短线盘中情绪、行业涨跌排名、板块资金流,拼一张全景。
 * 后端把每个端点抽成干净的结构化摘要(见 orchestrator/src/finance/shortline/overview.ts),这里按形状分类渲染;
 * 某一项取不到就降级成一行「没取到」。真机上跑过、确认字段后,这里的卡可继续打磨样式。
 */
import { Activity, Banknote, BarChart3, BrainCircuit, Hash, Layers, LayoutDashboard, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { Section } from "./FactsPanels";
import { countColor, finite, pctColor, rate, signed } from "./format";
import { GapsAndSource } from "./ViewBits";
import { useOverviewPoll } from "./useOverviewPoll";
import { CompositeBadge, ScoreRing } from "../pages/MarketState";
import { Opportunity } from "../pages/Opportunity";
import type { MarketStateResult } from "@/lib/marketState";
import type { BoardFlowRow, BreadthSummary, IndexRow, OverviewBlock, OverviewView, ResonanceRow, SectorRow, EventTrend } from "./watchTypes";

function StatTile({ label, value, cls, sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-lg font-semibold tabular-nums", cls ?? "text-foreground")}>{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground/80">{sub}</div> : null}
    </div>
  );
}

function IndexTable({ rows }: { rows: IndexRow[] }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">无数据</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-t border-border/40 first:border-0">
              <td className="py-1 pr-3 font-medium">{r.name}</td>
              <td className={cn("py-1 pr-3 text-right font-mono font-semibold tabular-nums", pctColor(r.change_pct))}>{signed(r.change_pct)}</td>
              <td className="py-1 text-right font-mono text-muted-foreground tabular-nums">{r.price == null ? "—" : r.price.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BreadthBody({ d }: { d: BreadthSummary }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <StatTile label="涨停" value={String(d.limit_up)} cls={countColor("up")} />
        <StatTile label="跌停" value={String(d.limit_down)} cls={countColor("down")} />
        <StatTile label="上涨" value={String(d.up)} cls={countColor("up")} />
        <StatTile label="下跌" value={String(d.down)} cls={countColor("down")} />
        <StatTile label="平盘" value={String(d.flat)} />
        <StatTile label="成交额" value={d.turnover_yi == null ? "—" : `${d.turnover_yi.toFixed(0)} 亿`} />
      </div>
      <p className="text-[11px] text-muted-foreground">{d.scope}</p>
    </div>
  );
}

const SHORTLINE_ITEMS: { key: string; label: string; kind: "count" | "rate" | "x"; color?: "up" | "down" }[] = [
  { key: "limit_up", label: "涨停", kind: "count", color: "up" },
  { key: "broken", label: "炸板", kind: "count" },
  { key: "limit_down", label: "跌停", kind: "count", color: "down" },
  { key: "seal_rate", label: "封板率", kind: "rate" },
  { key: "highest_board", label: "最高连板", kind: "count" },
  { key: "consec_count", label: "连板家数", kind: "count" },
  { key: "promotion_1to2", label: "1→2 晋级率", kind: "rate" },
  { key: "promotion_all", label: "整体晋级率", kind: "rate" },
  { key: "money_effect", label: "资金效应", kind: "x" },
  { key: "deep_loss", label: "深水", kind: "count", color: "down" },
];

function ShortlineBody({ d }: { d: Record<string, unknown> }) {
  const tiles = SHORTLINE_ITEMS.map((it) => {
    const raw = finite(d[it.key]);
    let value = "—";
    if (raw != null) {
      if (it.kind === "rate") value = rate(raw);
      else if (it.kind === "x") value = `${raw.toFixed(2)}×`;
      else value = String(Math.round(raw));
    }
    const cls = it.color === "up" ? countColor("up") : it.color === "down" ? countColor("down") : it.kind === "rate" ? pctColor(raw) : undefined;
    return <StatTile key={it.key} label={it.label} value={value} cls={cls} />;
  });
  const sample = finite(d.sample);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{tiles}</div>
      {sample != null && <p className="text-[11px] text-muted-foreground">样本:{Math.round(sample)} 只（昨日涨停池）</p>}
    </div>
  );
}

function SectorTable({ rows }: { rows: SectorRow[] }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">无数据</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="py-1 pr-3 font-normal">行业</th>
            <th className="py-1 pr-3 text-right font-normal">涨跌幅</th>
            <th className="py-1 pr-3 text-right font-normal">涨/跌家数</th>
            <th className="py-1 text-right font-normal">排名</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.name}-${i}`} className="border-t border-border/40">
              <td className="py-1 pr-3 font-medium">{r.name}</td>
              <td className={cn("py-1 pr-3 text-right font-mono font-semibold tabular-nums", pctColor(r.change_pct))}>{signed(r.change_pct)}</td>
              <td className="py-1 pr-3 text-right font-mono text-muted-foreground tabular-nums">
                {r.up_count == null && r.down_count == null ? "—" : `${r.up_count ?? "—"}/${r.down_count ?? "—"}`}
              </td>
              <td className="py-1 text-right font-mono text-muted-foreground tabular-nums">{r.rank ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BoardFlowTable({ rows }: { rows: BoardFlowRow[] }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">无数据</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="py-1 pr-3 font-normal">板块</th>
            <th className="py-1 pr-3 text-right font-normal">净流入</th>
            <th className="py-1 pr-3 text-right font-normal">涨跌幅</th>
            <th className="py-1 pr-3 font-normal">领涨</th>
            <th className="py-1 text-right font-normal">排名</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.name}-${i}`} className="border-t border-border/40">
              <td className="py-1 pr-3 font-medium">{r.name}</td>
              <td className={cn("py-1 pr-3 text-right font-mono font-semibold tabular-nums", pctColor(r.net_yi))}>{r.net_yi == null ? "—" : `${r.net_yi.toFixed(1)} 亿`}</td>
              <td className={cn("py-1 pr-3 text-right font-mono tabular-nums", pctColor(r.change_pct))}>{signed(r.change_pct)}</td>
              <td className="py-1 pr-3 text-muted-foreground">{r.leader ?? "—"}</td>
              <td className="py-1 text-right font-mono text-muted-foreground tabular-nums">{r.rank ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


/** 市场状态信号(盯盘页内嵌版):复用「市场状态信号」独立页的 CompositeBadge / ScoreRing 渲染,与独立页同一套信号与容错 */
function MarketStateOverviewPanel({ d }: { d: MarketStateResult }) {
  const { signal, dimensions, recommendation } = d;
  const stale = new Set(signal.stale_dimensions ?? []);
  return (
    <div className="space-y-3">
      <CompositeBadge signal={signal} />
      <div className="grid grid-cols-5 gap-2">
        <ScoreRing value={dimensions.emotion.score} color="#6366f1" label="情绪" weight={dimensions.emotion.weight} asOf={dimensions.emotion.as_of} stale={stale.has("emotion")} />
        <ScoreRing value={dimensions.dragon.score} color="#f59e0b" label="龙头" weight={dimensions.dragon.weight} asOf={dimensions.dragon.as_of} stale={stale.has("dragon")} />
        <ScoreRing value={dimensions.risk.score} color="#22c55e" label="风险" weight={dimensions.risk.weight} asOf={dimensions.risk.as_of} stale={stale.has("risk")} />
        <ScoreRing value={dimensions.earning.score} color="#3b82f6" label="赚钱效应" weight={dimensions.earning.weight} asOf={dimensions.earning.as_of} stale={stale.has("earning")} />
        <ScoreRing value={dimensions.event.score} color="#8b5cf6" label="事件" weight={dimensions.event.weight} asOf={dimensions.event.as_of} stale={dimensions.event.stale ?? stale.has("event")} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>建议:<b className="text-foreground">{recommendation.action}</b></span>
        <span>仓位上限:{recommendation.position_range}</span>
        <span>置信 {Math.round(recommendation.confidence * 100)}%</span>
      </div>
      {(signal.gate_blockers?.length ?? 0) > 0 && (
        <p className="text-[11px] text-red-600">闸门未过:{signal.gate_blockers!.join("；")}</p>
      )}
      {/* 没评估的门单独说 —— 它既不是通过也不是未过；全过时要能看出「还差两道没数据」 */}
      {(signal.gate_unknown?.length ?? 0) > 0 && (
        <p className="text-[11px] text-amber-600">
          闸门未评估:{signal.gate_unknown!.join("；")}（没数据不算通过，最多给到轻仓）
        </p>
      )}
      {/**
       * 🔴 这里**不显示完整的 recommendation.reason**：它把「上涨家数 / 涨停跌停 / 综合分与五维 /
       *    三道门明细 / 极高风险·0%」全抄了一遍，而这些东西在同一张卡上已经逐项摆着了
       *    （五维环、闸门行、风险徽标、仓位上限），一整句 70 字只有一个字是新的。
       *    改说「为什么不是更高阶段」—— 这是页面上任何地方都没写的，才是真正的依据。
       *    完整原文留在 title 里，需要时悬停可看。
       */}
      {(() => {
        const why = (signal.phase_reasons ?? []).filter(
          (r) => !r.includes("闸门") && !r.includes("够主升期"),
        );
        if (!why.length) return null;
        return (
          <p className="text-[11px] text-muted-foreground/80" title={recommendation.reason}>
            为什么不是更高阶段:{why.join("；")}
          </p>
        );
      })()}
      {signal.event_detail && (
        <p className="text-[11px] text-muted-foreground/80">
          事件面:{signal.event_detail.note} · 新闻联播标题词频，权重封顶 8%，别单独拿它推仓位
        </p>
      )}
      {d.notes.length > 0 && <p className="text-[11px] text-warning">{d.notes.join(";")}</p>}
    </div>
  );
}







/** 事件热词:财联社电报关键词词频 Top(本机聚合)。trend 当前恒为 null,这里只展示词与次数 */
function EventTrendPanel({ d }: { d: EventTrend }) {
  if (!d?.topics?.length) return <p className="text-[13px] text-muted-foreground">无数据</p>;
  return (
    <div className="space-y-1">
      {d.topics.map((t, i) => (
        <div key={`${t.keyword}-${i}`} className="flex items-center justify-between gap-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-medium">{t.keyword}</span>
          <span className="w-20 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
            {t.count == null ? "—" : t.count.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 板块多股共振表格 */
function ResonanceTable({ rows, scope }: { rows: ResonanceRow[]; scope: string }) {
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">无数据</p>;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <th className="py-1 pr-3 font-normal">板块</th>
              <th className="py-1 pr-3 text-right font-normal">共振率</th>
              <th className="py-1 pr-3 text-right font-normal">涨/跌</th>
              <th className="py-1 pr-3 text-right font-normal">涨跌幅</th>
              <th className="py-1 pr-3 font-normal">信号</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.name}-${i}`} className="border-t border-border/40">
                <td className="py-1 pr-3 font-medium">{r.name}</td>
                <td className={cn("py-1 pr-3 text-right font-mono font-semibold tabular-nums", r.resonance_rate !== null && r.resonance_rate >= 60 ? "text-danger" : r.resonance_rate !== null && r.resonance_rate >= 45 ? "text-warning" : "")}>
                  {r.resonance_rate == null ? "—" : `${r.resonance_rate.toFixed(0)}%`}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-muted-foreground tabular-nums">
                  {r.up_count == null && r.down_count == null ? "—" : `${r.up_count ?? "—"}/${r.down_count ?? "—"}`}
                </td>
                <td className={cn("py-1 pr-3 text-right font-mono tabular-nums", pctColor(r.change_pct))}>{signed(r.change_pct)}</td>
                <td className="py-1 pr-3">
                  {r.signal === "共振" && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold text-danger">共振</span>}
                  {r.signal === "强动" && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-bold text-warning">强动</span>}
                  {r.signal === "一般" && <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">{scope}</p>
    </div>
  );
}

function BlockBody({ kind, block }: { kind: keyof OverviewView; block: OverviewBlock<unknown> }) {
  if (block.status === "failed" || block.status === "empty") {
    return <p className="text-[13px] text-muted-foreground">{block.note || "这一项没取到"}</p>;
  }
  const d = block.data;
  if (kind === "indices" && d && Array.isArray((d as { rows?: IndexRow[] }).rows)) return <IndexTable rows={(d as { rows: IndexRow[] }).rows} />;
  if (kind === "breadth" && d) return <BreadthBody d={d as BreadthSummary} />;
  if (kind === "shortline" && d && typeof d === "object") return <ShortlineBody d={d as Record<string, unknown>} />;
  if (kind === "sectors" && d && Array.isArray((d as { rows?: SectorRow[] }).rows)) return <SectorTable rows={(d as { rows: SectorRow[] }).rows} />;
  if (kind === "resonance" && d && Array.isArray((d as { rows?: ResonanceRow[] }).rows)) return <ResonanceTable rows={(d as { rows: ResonanceRow[] }).rows} scope={(d as { scope: string }).scope} />;
  if (kind === "boardFlow" && d && Array.isArray((d as { rows?: BoardFlowRow[] }).rows)) return <BoardFlowTable rows={(d as { rows: BoardFlowRow[] }).rows} />;
  if (kind === "marketState" && d) return <MarketStateOverviewPanel d={d as MarketStateResult} />;
  if (kind === "marketEventTrend" && d) return <EventTrendPanel d={d as EventTrend} />;
  return <p className="text-[13px] text-muted-foreground">无数据</p>;
}

function BlockSection({ icon: Icon, title, hint, kind, block }: { icon: typeof LayoutDashboard; title: string; hint?: string; kind: keyof OverviewView; block: OverviewBlock<unknown> }) {
  return (
    <Section icon={Icon} title={title} hint={hint}>
      <BlockBody kind={kind} block={block} />
    </Section>
  );
}

export function OverviewPanel({ v, error, paused = false }: { v: OverviewView; error: string | null; paused?: boolean }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5", paused ? "border-border/60 text-muted-foreground" : "border-danger/50 bg-danger/10 text-danger")}>
          <Activity className={cn("h-3.5 w-3.5", !paused && "animate-pulse")} />
          {paused ? "页面在后台,已暂停刷新" : v.phase_label}
        </span>
        {paused
          ? <span role="status" className="text-warning">切回来就接着取(北京时间 {v.clock} 的读数)</span>
          : <span className="text-muted-foreground">北京时间 <b className="font-mono text-foreground">{v.clock}</b> · 每 {Math.round(v.poll_ms / 1000)} 秒刷新;实际时效以行情时间为准</span>}
        {error && <span role="alert" className="text-warning">这次没取到:{error}。先显示上一次的内容,稍后自动重试</span>}
      </div>

      <BlockSection icon={BrainCircuit} title="市场状态信号(本机测算)" hint="五维加权健康分:情绪 / 龙头 / 风险 / 赚钱效应 / 事件。事件面只取央视《新闻联播》标题做宏观词典扫描(不接大模型、权重封顶 8%);涨跌分布没取到时明确说「算不出来」,不给分数、不设仓位上限;东财断连时由新浪备源接住。" kind="marketState" block={v.marketState} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BlockSection icon={LayoutDashboard} title="指数实时(腾讯)" hint="A 股主要指数的实时涨跌(腾讯源)。" kind="indices" block={v.indices} />
        <BlockSection icon={BarChart3} title="全市场涨跌分布(东财)" hint="全市场按涨跌幅分档的家数 + 成交额(东财源,本机通常正常)。" kind="breadth" block={v.breadth} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BlockSection icon={Radio} title="短线盘中情绪(东财)" hint="涨停 / 炸板 / 跌停家数、封板率、晋级率(东财源,本机通常正常)。" kind="shortline" block={v.shortline} />
        <BlockSection icon={Layers} title="行业板块涨跌排名(东财)" hint="行业板块按涨跌幅排名(东财源,本机通常正常)。" kind="sectors" block={v.sectors} />
      </div>

      <BlockSection icon={Activity} title="板块多股共振(东财)" hint="同板块内上涨家数占比 ≥60% 记为「共振」,≥45% 记为「强动」,反映板块资金集中方向。" kind="resonance" block={v.resonance} />

      <BlockSection icon={Banknote} title="板块资金流(新浪)" hint="板块主力资金净流入,按净流入排序;新浪源,作东财的备源。" kind="boardFlow" block={v.boardFlow} />

      <BlockSection icon={Hash} title="事件热词(财联社)" hint="财联社电报关键词词频 Top;本机只做词频聚合,不判热度方向。" kind="marketEventTrend" block={v.marketEventTrend} />

      <GapsAndSource gaps={v.notes} source={v.source} />
    </div>
  );
}

export function OverviewTab() {
  const { data, error, live } = useOverviewPoll();
  return (
    <div className="space-y-4">
      {/* 判断在前、全景在后：盘中打开这一页，先要的是「现在能不能动、动哪个」，
          指数涨跌这些是背景，收进折叠区，需要时再展开。 */}
      <Opportunity embedded />
      {!data ? (
        <div className="glass p-4">
          <p role="status" className="text-sm text-muted-foreground">
            {!live
              ? "页面在后台，先不取全景行情；切回来就开始取。"
              : error
                ? `全景数据这次没取到：${error}。稍后自动重试。`
                : "全景数据加载中…（指数 / 涨跌分布 / 短线情绪 / 行业排名 / 资金流，第一次要取几个端点，稍等几秒）"}
          </p>
        </div>
      ) : (
        <details className="glass px-4 py-3">
          <summary className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">
            全景数据：市场状态五维分 / 指数 / 涨跌分布 / 短线情绪 / 行业排名 / 板块资金流 / 事件热词（点开）
            {!live && <span className="ml-2 text-warning">页面在后台，已暂停刷新</span>}
          </summary>
          <div className="mt-3"><OverviewPanel v={data} error={error} paused={!live} /></div>
        </details>
      )}
    </div>
  );
}
