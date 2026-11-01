/**
 * 把交易标注(`journal_tag`)挂到「一笔交易」上,得到交易日志的一行;没有成交明细的补记单独成行。
 *
 * - 标注填的是这一轮里任意一笔流水的 id,挂到包含它的那一轮。
 * - 一轮有多条标注:取最后修改的那条,其余列成「重复标注」让用户删。
 * - 挂不上的(流水删了、那笔不参与计算、代码对不上、不是 A 股)列成「挂不上的标注」,不丢。
 * - 补记(没填 trade_id):只有日期和盈亏 %,金额类统计不算它(VA 同口径:只填 % 的不进金额)。
 *
 * 纯函数。
 */
import type { LedgerRecord } from "../../ledger.ts";
import { PLAYBOOKS } from "./defs.ts";
import { isJournalSymbol, type Episode } from "./episodes.ts";
import { realDay } from "./num.ts";

export interface Tag {
  id: string; symbol: string; name: string; trade_id: string; date: string;
  playbook: string | null; as_planned: boolean | null;
  /** 这笔出自哪条计划(trade_plan 的 id);判定「按计划 / 计划外」用 */
  plan_id: string | null;
  planned_stop: number | null; planned_target: number | null; pnl_pct: number | null;
  note: string; planned_at: string; migrated_from: string;
  created_at: string; updated_at: string;
}

/** 计划用 `round_ref` 认领那一轮时,顺带带过来的东西 */
export interface PlanLink {
  planned_stop: number | null;
  planned_target: number | null;
  /** 计划写下时间(ISO),用来判「止损是不是事后补的」—— 认领那一轮不会改它 */
  created_at: string;
  /** 同一轮被多条计划认领时取最后修改的那条(和标注同口径) */
  updated_at: string;
}

/**
 * 计划 ↔ 成交的关联情况,判定「按计划 / 计划外」的**唯一依据**。
 * 两条路都算:计划自己写 `round_ref` 认领那一轮,或标注写 `plan_id` 指回计划。
 */

export interface PlanLinks {
  /** 计划用 `round_ref` 认领的那一轮 key */
  rounds: ReadonlySet<string>;
  /** 现存的计划 id;`plan_id` 指向不在里面的 id = 那条计划已删,等于没关联 */
  planIds: ReadonlySet<string>;
  /** round_ref → 那条计划。只有这种关联才带得回价位(标注侧的 plan_id 不带,它没有价位字段) */
  byRound: ReadonlyMap<string, PlanLink>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function tagOf(r: LedgerRecord): Tag {
  const pb = str(r.playbook);
  return {
    id: r.id, symbol: str(r.symbol), name: str(r.name), trade_id: str(r.trade_id), date: str(r.date),
    playbook: (PLAYBOOKS as readonly string[]).includes(pb) ? pb : null,
    as_planned: typeof r.as_planned === "boolean" ? r.as_planned : null,
    plan_id: str(r.plan_id) || null,
    planned_stop: num(r.planned_stop), planned_target: num(r.planned_target), pnl_pct: num(r.pnl_pct),
    note: str(r.note), planned_at: str(r.planned_at), migrated_from: str(r.migrated_from),
    created_at: str(r.created_at), updated_at: str(r.updated_at),
  };
}

/** 台账时间戳(ISO)对应的北京时间日期;读不出返回 null */
export function cnDay(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000).toISOString().slice(0, 10) : null;
}

export interface JournalRow {
  /** 一轮 = 开这一轮的流水 id;补记 = 标注 id */
  key: string;
  kind: "episode" | "manual";
  symbol: string;
  name: string;
  /** 入场日:一轮 = 第一笔买入(或期初持仓)那天;补记 = 用户填的日期 */
  date: string;
  /** 录入时间:一轮 = 开这一轮那笔流水的;补记 = 标注的。同日入场按它排先后(VA 同) */
  created_at: string;
  episode: Episode | null;
  tag_id: string | null;
  playbook: string | null;
  as_planned: boolean | null;
  planned_stop: number | null;
  planned_target: number | null;
  /** 止损 / 目标是在买入日之后才写下的(在险资金口径会失真,页面标出来) */
  plan_late: boolean;
  note: string;
  /** 一轮 = 按流水算的已实现 %(还没卖过是 null);补记 = 用户填的 */
  pnl_pct: number | null;
  realized_pnl: number | null;
  hold_days: number | null;
}

export interface TagProblem { id: string; symbol: string; why: string }

export interface RowsResult {
  rows: JournalRow[];
  /** 挂不上的标注 */
  orphans: TagProblem[];
  /** 同一轮的多余标注(只认最后修改的那条) */
  conflicts: TagProblem[];
}

const newer = (a: Tag, b: Tag) => (a.updated_at !== b.updated_at ? a.updated_at > b.updated_at : a.id > b.id);

/**
 * @param skippedTradeIds 不参与计算的流水 id → 原因(交易日志里列出的那些)
 * @param knownTradeIds 台账里现有的全部流水 id(区分「流水删了」和「那笔不参与计算」)
 */
/**
 * 「按计划 / 计划外」的判定(Simon 2026-10-30 定的强约束)。
 *
 * 🔴 **不再是用户在标注里勾的布尔** —— 有没有挂着的计划说了算:
 *     关联到计划 = 按计划;没有 = **一律计划外**,勾了「按计划」也不算。
 *    过去那句只能靠用户自己勾,于是「当初到底算不算计划内」本身就是勾出来的答案,
 *    事后既无法核对,`inbox` 也只能在亏损之后才问一句。
 *
 * `links` 不传(老调用方 / 直接构造的场景)时退回标注自己的勾法,行为不变。
 */
export function plannedFrom(links: PlanLinks | undefined, rowKey: string, tag: Tag | null): boolean | null {
  if (!links) return tag?.as_planned ?? null;
  const byRound = links.rounds.has(rowKey);
  const byTag = tag !== null && tag.plan_id !== null && links.planIds.has(tag.plan_id);
  return byRound || byTag;
}

/**
 * 这一行的计划止损 / 目标**从哪来**。
 *
 * 计划用 `round_ref` 认领了这一轮时,价位取**计划的**:那是买入之前写下的,正是 `planned_*` 要的语义;
 * 计划没写(或没认领)才退回标注里写的。不这么做的话 —— 计划明明写了止损,
 * 交易日志照样报「没写计划止损」,明明有却说没有。
 *
 * `late`:价位是在入场日之后才写下的。计划侧看计划**写下**的时间(认领那一轮是事后改的 `round_ref`,
 * 不改 `created_at`,所以拿它比对得住);标注侧看 `planned_at`。
 *
 * @param entryDay 入场日(一轮 = 第一笔买入那天;补记 = 用户填的日期)
 */
export function plannedLevelsFrom(
  links: PlanLinks | undefined, rowKey: string, tag: Tag | null, entryDay: string,
): { stop: number | null; target: number | null; late: boolean } {
  const p = links?.byRound.get(rowKey) ?? null;
  const stop = p?.planned_stop ?? tag?.planned_stop ?? null;
  const target = p?.planned_target ?? tag?.planned_target ?? null;
  if (stop === null && target === null) return { stop, target, late: false };
  const fromPlan = p !== null && (p.planned_stop !== null || p.planned_target !== null);
  const written = fromPlan ? p!.created_at : tag?.planned_at ?? "";
  const day = cnDay(written);
  return { stop, target, late: day !== null && day > entryDay };
}

export function buildRows(
  episodes: readonly Episode[], tags: readonly Tag[],
  skippedTradeIds: ReadonlyMap<string, string>, knownTradeIds: ReadonlySet<string>,
  links?: PlanLinks,
): RowsResult {
  const byTrade = new Map<string, Episode>();
  for (const ep of episodes) for (const id of ep.trade_ids) byTrade.set(id, ep);
  const orphans: TagProblem[] = [];
  const conflicts: TagProblem[] = [];
  const winner = new Map<string, Tag>();
  const manual: JournalRow[] = [];

  for (const t of tags) {
    if (!isJournalSymbol(t.symbol)) { orphans.push({ id: t.id, symbol: t.symbol, why: "交易日志只管 A 股股票(ETF、基金、债券不记)" }); continue; }
    if (!t.trade_id) {
      if (!realDay(t.date)) { orphans.push({ id: t.id, symbol: t.symbol, why: "没有成交明细的补记要写日期" }); continue; }
      const lv = plannedLevelsFrom(links, t.id, t, t.date);
      manual.push({
        key: t.id, kind: "manual", symbol: t.symbol, name: t.name, date: t.date, created_at: t.created_at, episode: null, tag_id: t.id,
        playbook: t.playbook, as_planned: plannedFrom(links, t.id, t),
        planned_stop: lv.stop, planned_target: lv.target, plan_late: lv.late,
        note: t.note, pnl_pct: t.pnl_pct, realized_pnl: null, hold_days: null,
      });
      continue;
    }
    const ep = byTrade.get(t.trade_id);
    if (!ep) {
      const why = skippedTradeIds.get(t.trade_id);
      orphans.push({
        id: t.id, symbol: t.symbol,
        why: why !== undefined ? `对应的那笔流水不参与计算(${why})` : knownTradeIds.has(t.trade_id) ? "对应的流水不是 A 股买卖" : "对应的流水已经删了",
      });
      continue;
    }
    if (ep.symbol !== t.symbol) { orphans.push({ id: t.id, symbol: t.symbol, why: `代码和对应流水(${ep.symbol})对不上` }); continue; }
    const cur = winner.get(ep.id);
    if (!cur) { winner.set(ep.id, t); continue; }
    const [keep, drop] = newer(t, cur) ? [t, cur] : [cur, t];
    winner.set(ep.id, keep);
    conflicts.push({ id: drop.id, symbol: drop.symbol, why: "同一笔交易有多条标注,只认最后修改的那条" });
  }

  const rows: JournalRow[] = episodes.map((ep) => {
    const t = winner.get(ep.id) ?? null;
    const lv = plannedLevelsFrom(links, ep.id, t, ep.first_buy);
    return {
      key: ep.id, kind: "episode", symbol: ep.symbol, name: ep.name || t?.name || "", date: ep.first_buy, created_at: ep.created_at, episode: ep,
      tag_id: t?.id ?? null, playbook: t?.playbook ?? null, as_planned: plannedFrom(links, ep.id, t),
      planned_stop: lv.stop, planned_target: lv.target,
      // 没记标注时间(旧数据)不算事后:不知道就不指控
      plan_late: lv.late,
      note: t?.note ?? "",
      // 有明细的只按流水算:标注里的 pnl_pct 只给补记用(标注接口对有明细的拒收)
      pnl_pct: ep.realized_pct,
      realized_pnl: ep.realized_pnl, hold_days: ep.hold_days,
    };
  });
  rows.push(...manual);
  // VA 的列表顺序:入场日新的在前,同一天后录的在前(风险计算按这个顺序累加,见 risk.ts vaOrder)
  rows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1)
    : a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1)
      : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { rows, orphans, conflicts };
}
