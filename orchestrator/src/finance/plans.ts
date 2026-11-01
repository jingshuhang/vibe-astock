/**
 * 「交易计划」视图 —— 补上闭环缺的前半球。
 *
 * 过去这条链只有后半截:`journal_tag` 是**成交之后**才补写的,`as_planned` 是用户自己勾的一个布尔,
 * 没有任何东西能核对;于是交易日志只能在持仓之后抱怨一句「没写计划止损」。
 * 有了先于成交存在的 `trade_plan`,同一句提醒可以放到**买入之前**说。
 *
 * 这一屏只做三件事,全是**客观计算**,不做价值判断:
 *   1. 到点顶出来:今天到期 / 已到检查点 / 过了有效期还没成交的计划
 *   2. 指出缺项:止损、目标、仓位、理由写了没有(买入前应问的话)
 *   3. 成交后对照:计划价 vs 实际成交价、按尘的东西还在不在
 *
 * 🔴 排序**只按下单写下顺序**,不按「我们觉得哪条重要」—— 那是替用户判断(沿用交易日志收件箱的口径)。
 *    需要分组时由页面按 `lifecycle` 这类**客观状态**归类,同样不是由这里替他排序。
 * 🔴 个人下单价位不进 AI:`trade_plan` 已在台账登记为 hiddenFromAssistant,这里也不做任何建议生成。
 */
import type { LedgerIssue, LedgerRecord } from "../ledger.ts";
import { localClock } from "../notify.ts";
import { ledgerSnapshot, type ServiceContext } from "../service.ts";
import { DEFAULT_FEES } from "./journal/fees.ts";
import type { JournalRow } from "./journal/rows.ts";
import { computeJournal, loadJournalData } from "./journal/view.ts";
import { PLAYBOOKS } from "./journal/defs.ts";
import { SCHEDULE_TZ } from "./schedule.ts";

export const PLAN_KIND = "trade_plan";

/** 记录里的 `status`;空值按「待执行」处理(和 `journal_tag.as_planned` 一样,空 = 未标注) */
export const PLAN_STATUSES = ["planned", "executed", "abandoned"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
/** 加上**推导**出来的 `expired`:过了有效期还没成交 */
export type PlanLifecycle = PlanStatus | "expired";

export interface TradePlan {
  id: string;
  symbol: string;
  name: string;
  playbook: string | null;
  thesis: string;
  planned_entry: number | null;
  planned_stop: number | null;
  planned_target: number | null;
  position_pct: number | null;
  watch: string[];
  next_check: string;
  due: string;
  valid_until: string;
  status: PlanStatus;
  /** 成交的那一轮(交易日志那行的 key);有了它才有事后对照 */
  round_ref: string;
  note: string;
  created_at: string;
  updated_at: string;
}

/** 买入之前该问的话 —— 缺哪项就在计划上标哪项 */
export interface PlanGap { key: string; text: string }

/** 关联成交的实际执行情况(数字全部来自交易流水,不估不猜) */
export interface PlanExecution {
  round_key: string;
  /** 入场日 */
  date: string;
  /** 第一笔买入成交价 */
  first_price: number | null;
  /** 这一轮的成本均价 */
  avg_cost: number | null;
  closed: boolean;
  realized_pnl_pct: number | null;
  hold_days: number | null;
  /** 实际比计划高买 / 低买了百分之几(正 = 追高) */
  entry_gap_pct: number | null;
}

/** 可能是这笔交易、但还没认领的一轮(让用户自己挂 plan_id) */
export interface CandidateRound {
  round_key: string;
  symbol: string;
  date: string;
  first_price: number | null;
}

export interface PlanView {
  plan: TradePlan;
  lifecycle: PlanLifecycle;
  /** 今天到期(复核日 = 今天) */
  due_today: boolean;
  /** 今天的检查点已到 */
  check_arrived: boolean;
  gaps: PlanGap[];
  execution: PlanExecution | null;
  candidates: CandidateRound[];
}

export interface PlansResult {
  available: boolean;
  reason: string;
  day: string;
  hm: string;
  plans: PlanView[];
  open_count: number;
  due_count: number;
  expired_count: number;
  linked_count: number;
  issues: { id: string; symbol: string; why: string }[];
  notes: string[];
  source: string;
}

// ─── 取值 ──────────────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round1 = (v: number): number => Number(v.toFixed(1));

export function planOf(r: LedgerRecord): TradePlan {
  const st = str(r.status);
  return {
    id: str(r.id),
    symbol: str(r.symbol),
    name: str(r.name),
    playbook: (PLAYBOOKS as readonly string[]).includes(str(r.playbook)) ? str(r.playbook) : null,
    thesis: str(r.thesis),
    planned_entry: num(r.planned_entry),
    planned_stop: num(r.planned_stop),
    planned_target: num(r.planned_target),
    position_pct: num(r.position_pct),
    watch: Array.isArray(r.watch)
      ? (r.watch as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
      : [],
    next_check: str(r.next_check),
    due: str(r.due),
    valid_until: str(r.valid_until),
    status: (PLAN_STATUSES as readonly string[]).includes(st) ? (st as PlanStatus) : "planned",
    round_ref: str(r.round_ref),
    note: str(r.note),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

/**
 * 生命周期。`expired` 只在这里推,**不入库** ——
 * 存成实打实的状态会越攒越多,且今天过期、明天又把日期改回来的那条永远变不回「待执行」。
 */
export function lifecycleOf(p: TradePlan, day: string): PlanLifecycle {
  if (p.status !== "planned") return p.status;
  if (p.valid_until && p.valid_until < day) return "expired";
  return "planned";
}

/**
 * 买入之前该问的几句话。
 * 挑这四项是因为它们**事后补已经晚了**:止损晚了在险资金口径失真,理由晚了没法检验"逻辑还在不在"。
 */
export function gapsOf(p: TradePlan): PlanGap[] {
  const gaps: PlanGap[] = [];
  if (p.planned_stop === null) gaps.push({ key: "no_stop", text: "没写计划止损 —— 最坏情况无从估计" });
  if (p.planned_entry === null && p.planned_target === null) gaps.push({ key: "no_levels", text: "入场价和目标价都没写" });
  if (p.position_pct === null) gaps.push({ key: "no_size", text: "没写计划占仓 %" });
  if (!p.thesis) gaps.push({ key: "no_thesis", text: "没写为什么做这笔 —— 事后无法检验理由是否还在" });
  return gaps;
}

const pctGap = (actual: number | null, planned: number | null): number | null =>
  actual === null || planned === null || planned <= 0 ? null : round1(((actual - planned) / planned) * 100);

function executionOf(row: JournalRow, planned_entry: number | null): PlanExecution {
  const e = row.episode;
  const first = e?.fills[0] ?? null;
  const firstPrice = first ? first.price : null;
  return {
    round_key: row.key,
    date: row.date,
    first_price: firstPrice,
    avg_cost: e ? e.avg_cost : null,
    closed: e ? e.closed : false,
    realized_pnl_pct: row.pnl_pct,
    hold_days: row.hold_days,
    entry_gap_pct: pctGap(firstPrice, planned_entry),
  };
}

function candidateOf(row: JournalRow): CandidateRound {
  return {
    round_key: row.key,
    symbol: row.symbol,
    date: row.date,
    first_price: row.episode?.fills[0]?.price ?? null,
  };
}

// ─── 视图 ──────────────────────────────────────────────────────────────────────

const byWritten = (a: TradePlan, b: TradePlan) =>
  a.created_at !== b.created_at ? (a.created_at < b.created_at ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * 读台账与交易日志做整理。**只读**:不做任何写盘。
 * 交易账本算不出来(比如流水坏得厉害)时不整屏失败 —— 计划照出,退化原因写进 `notes`。
 */
export function computePlans(ctx: ServiceContext, now: Date): PlansResult {
  const { day, hm } = localClock(now, SCHEDULE_TZ);
  const snap = ledgerSnapshot(ctx);
  const planIssues = new Set((snap.issues[PLAN_KIND] ?? []).map((i) => i.id));
  const rawPlans: TradePlan[] = (snap.records[PLAN_KIND] ?? []).filter((r) => !planIssues.has(r.id)).map(planOf);

  // 交易账本:算不出来就退化,不让它拖垮计划这一屏
  let rows: JournalRow[] = [];
  let planIdByTag = new Map<string, string>();
  const notes: string[] = [];
  try {
    const d = loadJournalData(ctx);
    const c = computeJournal(d, d.settings.fees ?? DEFAULT_FEES);
    rows = c.rows;
    // tag.id → plan_id:成交 ←→ 计划的那个接缝(台账层新增的字段就在这里用上)
    for (const r of snap.records.journal_tag ?? []) {
      const pid = str(r.plan_id);
      if (pid) planIdByTag.set(str(r.id), pid);
    }
  } catch (e) {
    notes.push(`交易账本这次没能算出来，暂时不显示成交对照：${e instanceof Error ? e.message : String(e)}`);
  }

  /** tag_id → 那一轮;tag_id → 关联计划 */
  const rowByTag = new Map<string, JournalRow>();
  for (const r of rows) if (r.tag_id) rowByTag.set(r.tag_id, r);
  const rowByKey = new Map(rows.map((r) => [r.key, r] as const));
  const claimedTags = new Set(planIdByTag.keys());
  /** 已经被某条计划认领过的那一轮(避免同一轮在几条计划里反复冒出来当候选) */
  const claimedKeys = new Set(rawPlans.map((p) => p.round_ref).filter((k) => k !== ""));

  const plans: PlanView[] = rawPlans.map((plan) => {
    const lifecycle = lifecycleOf(plan, day);
    /**
     * 关联的那一轮。**两条路都认**(任一条命中就算合上):
     *   1. 计划自己写了 `round_ref`(计划页「关联这笔交易」写的,主力)
     *   2. 交易标注写了 `plan_id`(另一个朝向:成交 → 计划)
     */
    const linkedTagId = [...planIdByTag.entries()].find(([, pid]) => pid === plan.id)?.[0] ?? null;
    const linkedRow = plan.round_ref
      ? rowByKey.get(plan.round_ref) ?? null
      : linkedTagId
        ? rowByTag.get(linkedTagId) ?? null
        : null;
    return {
      plan,
      lifecycle,
      due_today: plan.due === day,
      check_arrived: plan.next_check !== "" && hm >= plan.next_check,
      gaps: gapsOf(plan),
      execution: linkedRow ? executionOf(linkedRow, plan.planned_entry) : null,
      // 还没认领的候选:同代码、未经任何这几条计划认领过的那一轮
      candidates: linkedRow ? [] : rows
        .filter((r) => r.symbol === plan.symbol && r.tag_id && !claimedTags.has(r.tag_id) && !claimedKeys.has(r.key))
        .map(candidateOf),
    };
  }).sort((a, b) => byWritten(a.plan, b.plan));

  const open = plans.filter((p) => p.lifecycle === "planned");
  return {
    available: true,
    reason: "",
    day,
    hm,
    plans,
    open_count: open.length,
    due_count: plans.filter((p) => p.due_today && p.lifecycle === "planned").length,
    expired_count: plans.filter((p) => p.lifecycle === "expired").length,
    linked_count: plans.filter((p) => p.execution !== null).length,
    issues: (snap.issues[PLAN_KIND] ?? []).map((i: LedgerIssue) => ({
      id: i.id,
      symbol: str((snap.records[PLAN_KIND] ?? []).find((r) => r.id === i.id)?.symbol),
      why: i.why ?? "这条计划不合台账规则",
    })),
    notes,
    source: "台账 trade_plan + journal_tag（都在本机，不联网）",
  };
}

export async function tradePlansViewAct(ctx: ServiceContext): Promise<PlansResult> {
  return computePlans(ctx, new Date());
}
