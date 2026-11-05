/**
 * 大盘判断台账:WorkBuddy「大盘全景」收盘档的交易倾向,落账 + 次日对账。
 *
 * 全景 skill 跑在 WorkBuddy 会话里(通达信/腾讯/iFinD 等多源),产出是给人看的 HTML 报告;
 * 这里接的是它**机器可比对**的那一小份结论(§5.1 四档口径:加仓/持有/减仓/观望 + 依据 + 触发条件)。
 * 交接通道是文件,不是 HTTP —— 全景侧把结构化结论写成
 *   `<dataRoot>/inbox/market_call/YYYY-MM-DD.json`
 * 本模块的定时任务(16:05)扫描落账,次日收盘后对账触发条件。三条纪律:
 *   1. 🔴 只存全景产出的判断,**本系统不生成任何大盘建议** —— 台账种类标 managedWrites,通用接口写不进。
 *   2. 幂等:同一份 JSON 重扫、同日再写,`ledgerReplace` 正文没变就不动(updated_at 不变)。
 *   3. 触发条件尽量结构化(读数 + 比较 + 阈值),机器判命中;判不了的(trigger_hit 缺省)如实留白,
 *      原文(trigger)一直留着供人复核。对账读数取**本系统端点**(东财涨跌分布/指数趋势),
 *      与全景侧的通达信口径可能有小差异 —— 命中判定只用同一份本系统读数的前后两天,不混源。
 *
 * 对账时点:次一交易日收盘后的 16:05。广度端点只给最新一天,所以**错过时点的广度补不回来**
 * (成交额/涨停/跌停可回查日线);这种日子照样对账,只把判不了的读数留空并写进缺口。
 */
import fs from "node:fs";
import path from "node:path";
import { fetchEndpoint, ledgerList, ledgerReplace, type ServiceContext } from "../service.ts";
import type { FetchResult } from "../service.ts";
import { klineBars } from "./abnormal.ts";
import { localClock } from "../notify.ts";
import { SCHEDULE_TZ, failedNote } from "./schedule.ts";
import { consistencyFor, retentionFloor } from "./shortline/history.ts";
import { extractBreadth } from "./market_state.ts";

export const MARKET_CALL_KIND = "market_call";
/** 交接目录:`<dataRoot>/inbox/market_call/`;全景侧落 JSON,本模块扫完挪进 processed/ */
export const INBOX_SUBDIR = path.join("inbox", "market_call");
const PROCESSED_SUBDIR = "processed";
const KLINE_MAX_AGE_MS = 10 * 60 * 100;
/**
 * 当天这笔对账最早几点可以做。15:00 收盘,留 30 分钟给各家源把当日数字落定。
 * 早于这个时刻,拿到的都是盘中读数,写进去就等于把「当时的走势」当成「当天的结果」。
 */
const SETTLE_AFTER_HM = "15:30";
/** 广度/趋势是当日盘后读数,收盘后 15 分钟内的缓存都算新鲜 */
const FRESH_MAX_AGE_MS = 15 * 60 * 1000;
const CALL_ENUM = ["加仓", "持有", "减仓", "观望"] as const;
const DIR_ENUM = ["偏多", "中性", "偏空"] as const;
const METRIC_ENUM = ["breadth_pct", "limit_up", "limit_down", "amount_yi"] as const;
const OP_ENUM = ["above", "below"] as const;
type TriggerMetric = (typeof METRIC_ENUM)[number];

/** 口径文案:视图与给 AI 的上下文都用这一份 */
export const MARKET_CALL_CAVEAT =
  "交易倾向四档(加仓/持有/减仓/观望)与触发条件由 WorkBuddy 大盘全景收盘档产出,本台账只存档与对账,不生成任何大盘建议;"
  + "触发命中按结构化阈值机器判(≥/≤ 含等于),触发条件原文一直留档供人工复核;"
  + "对账读数取本系统端点(东财涨跌分布/指数趋势),与全景侧通达信口径可能有小差异。不构成投资建议。";

// ─── 交接件(JSON)校验 ─────────────────────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * 真实存在的日历日。只写正则不够:`2026-11-99`、`2026-02-31` 都能过格式校验,
 * 进台账后永远等不到「次一交易日」—— 和 Core 的 `format:"date"` 同一个坑,这里提前拦。
 */
const realDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export interface CallIngest {
  date: string;
  call: string;
  direction: string;
  basis: string | null;
  trigger: string | null;
  trigger_metric: TriggerMetric | null;
  trigger_op: "above" | "below" | null;
  trigger_value: number | null;
  breadth_pct: number | null;
  amount_yi: number | null;
  limit_up: number | null;
  limit_down: number | null;
  html_path: string | null;
}

/** 校验一份交接 JSON。不合法返回原因(给人看的,写进缺口),合法给出归一化后的字段 */
export function parseCallJson(raw: unknown): { ok: true; call: CallIngest } | { ok: false; why: string } {
  if (!isObj(raw)) return { ok: false, why: "不是 JSON 对象" };
  const date = str(raw.date);
  if (!date || !DATE_RE.test(date) || !realDate(date)) return { ok: false, why: "date 缺失或不是 YYYY-MM-DD" };
  const call = str(raw.call);
  if (!call || !(CALL_ENUM as readonly string[]).includes(call)) return { ok: false, why: `call 不是四档之一(${CALL_ENUM.join("/")})` };
  const direction = str(raw.direction);
  if (!direction || !(DIR_ENUM as readonly string[]).includes(direction)) return { ok: false, why: `direction 不是三档之一(${DIR_ENUM.join("/")})` };
  const metric = str(raw.trigger_metric);
  const op = str(raw.trigger_op);
  const th = num(raw.trigger_value);
  // 结构化触发条件要么三项齐、要么全缺;齐一半的算不齐,如实说
  const have = [metric, op, th].filter((x) => x != null).length;
  if (have !== 0 && have !== 3) return { ok: false, why: "trigger_metric/trigger_op/trigger_value 要么都给、要么都不给" };
  if (metric && !(METRIC_ENUM as readonly string[]).includes(metric)) return { ok: false, why: `trigger_metric 不在可对账清单(${METRIC_ENUM.join("/")})` };
  if (op && !(OP_ENUM as readonly string[]).includes(op)) return { ok: false, why: "trigger_op 只能是 above/below" };
  return {
    ok: true,
    call: {
      date, call, direction,
      basis: raw.basis == null ? null : String(raw.basis).slice(0, 120),
      trigger: raw.trigger == null ? null : String(raw.trigger).slice(0, 120),
      trigger_metric: (metric as TriggerMetric) ?? null,
      trigger_op: (op as "above" | "below") ?? null,
      trigger_value: th,
      breadth_pct: num(raw.breadth_pct),
      amount_yi: num(raw.amount_yi),
      limit_up: num(raw.limit_up),
      limit_down: num(raw.limit_down),
      html_path: raw.html_path == null ? null : String(raw.html_path).slice(0, 500),
    },
  };
}

/** 归一化后的交接件 → 台账记录体(null 字段不写,台账里就没有这个键) */
function bodyOf(c: CallIngest): Record<string, unknown> {
  const body: Record<string, unknown> = { date: c.date, call: c.call, direction: c.direction, settled: false };
  for (const [k, v] of Object.entries(c)) {
    if (k === "date" || k === "call" || k === "direction") continue;
    if (v !== null && v !== undefined) body[k] = v;
  }
  return body;
}

// ─── 扫描 inbox ────────────────────────────────────────────────────────────────

export interface ScanOutcome {
  ingested: number;
  dates: string[];
  gaps: string[];
  /** 有几份落件是「补过漏转义的反斜杠」才解析出来的 —— 报出来,别让修过的痕迹消失 */
  repaired?: number;
}

/**
 * 把 JSON 文本里**漏转义的反斜杠**补成 `\\` —— 只动这一种,别的什么都不碰。
 *
 * 为什么要它:全景侧写档时把 Windows 路径直接拼进了 JSON,`"C:\Users\..."` 里的 `\U`
 * 是非法转义,`JSON.parse` 整份拒收,文件就躺在 inbox 里没人管 —— 台账「少一天」,
 * 看着像上游没出数,实际是**一份本来能救回来的文件**(2026-11-04 真实踩到,查了半天才发现)。
 *
 * 只处理字符串内部;合法转义(`\" \\ \/ \b \f \n \r \t \uXXXX`)一律原样保留 ——
 * 把一份本来就合法的 JSON 丢进来,输出与输入逐字节相同(有测试守着)。
 * 结构性的坏(缺引号、括号不配对)不在这里修:修不了就老实报缺口,不假装能修。
 */
export function repairLoneBackslashes(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;   // 进入字符串(此时还没遇到转义,所以这个引号一定是真的起始引号)
      continue;
    }
    if (ch === '"') { inStr = false; out += ch; continue; }
    if (ch !== "\\") { out += ch; continue; }
    const next = text[i + 1];
    if (next === undefined) { out += "\\\\"; continue; }              // 末尾孤立反斜杠
    if (next === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += `\\u${hex}`; i += 5; continue; } // 合法 \uXXXX
      out += "\\\\u"; i += 1; continue;                               // \Users 这种:当漏转义
    }
    if ('"\\/bfnrt'.includes(next)) { out += `\\${next}`; i += 1; continue; }     // 合法转义,原样
    out += `\\\\${next}`; i += 1;                                     // 其余一律当漏转义
  }
  return out;
}

/**
 * 先按原样解析;不行就补反斜杠再试一次。
 * `repaired` 让调用方知道这份是修过的 —— 修过不等于没发生过,该报还是要报。
 * 报错报的是**原始**错误:修完之后的错误位置更靠后,对排查没帮助。
 */
export function parseCallText(text: string): { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(text), repaired: false }; }
  catch (e) {
    const fixed = repairLoneBackslashes(text);
    if (fixed !== text) {
      try { return { ok: true, value: JSON.parse(fixed), repaired: true }; } catch { /* 修完还是坏 → 落到下面报原始错误 */ }
    }
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 60) : "?" };
  }
}

/**
 * 扫 `<dataRoot>/inbox/market_call/*.json` 落账。成功的挪进 `processed/`(留档不删);
 * 不合法的**留在原地**并写缺口(改好了下次扫还能进)。同日已有记录时整条替换(全景同日第二档 = 增量覆盖判断)。
 */
export function scanInbox(ctx: Pick<ServiceContext, "dataRoot">, now: Date): ScanOutcome {
  const dir = path.join(ctx.dataRoot, INBOX_SUBDIR);
  const gaps: string[] = [];
  let ingested = 0;
  let repaired = 0;
  const dates: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { ingested, dates, gaps, repaired }; // 目录还没建:全景侧第一次落件时才有,不算缺口
  }
  const doneDir = path.join(dir, PROCESSED_SUBDIR);
  for (const f of files) {
    const p = path.join(dir, f);
    const res = parseCallText(fs.readFileSync(p, "utf8"));
    if (!res.ok) {
      gaps.push(`${f}:JSON 解析不了(${res.error}),留在原地`);
      continue;
    }
    if (res.repaired) repaired++;
    const raw = res.value;
    const parsed = parseCallJson(raw);
    if (!parsed.ok) { gaps.push(`${f}:${parsed.why},留在原地`); continue; }
    const c = parsed.call;
    try {
      // 带上同日已有记录的 id:ledgerReplace 只有带 id 才走「正文没变原样返回」的幂等;
      // 不带 id 是整组删掉重建,同日重扫会白白换 id、动时间戳
      const prev = (ledgerList(ctx as ServiceContext, MARKET_CALL_KIND)[MARKET_CALL_KIND] ?? []).find((r) => r.date === c.date);
      const body = bodyOf(c);
      if (prev) body.id = prev.id;
      ledgerReplace(ctx as ServiceContext, {
        kind: MARKET_CALL_KIND,
        match: (r) => r.date === c.date,
        records: [body],
      });
    } catch (e) {
      gaps.push(`${f}:落账被拒(${e instanceof Error ? e.message.slice(0, 80) : "?"}),留在原地`);
      continue;
    }
    try {
      fs.mkdirSync(doneDir, { recursive: true });
      fs.renameSync(p, path.join(doneDir, f));
    } catch {
      gaps.push(`${f}:已落账,但挪不进 processed/(${now ? "文件被占用?" : "?"});下次重扫靠幂等兜住`);
    }
    ingested++;
    dates.push(c.date);
  }
  return { ingested, dates, gaps, repaired };
}

// ─── 次日对账 ──────────────────────────────────────────────────────────────────

export interface SettleOutcome {
  settled: number;
  dates: string[];
  gaps: string[];
}

/** 对账可注入的取数(测试不碰真实端点)。req/返回值都取 fetchEndpoint 的形状,避免两处签名漂移 */
export interface CallDeps {
  fetch?: (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope" | "out_dir">>;
}

interface NextReadings {
  next: string;
  breadth_pct: number | null;
  amount_yi: number | null;
  limit_up: number | null;
  limit_down: number | null;
  gaps: string[];
}

/** 证据数组 → (field, period) 扁平查值(标量行:record_key 为空的那些) */
function evValue(env: unknown, field: string, period?: string): number | null {
  const e = env && typeof env === "object" ? (env as { evidence?: unknown }).evidence : undefined;
  if (!Array.isArray(e)) return null;
  let hit: number | null = null;
  for (const raw of e) {
    if (!isObj(raw) || raw.field !== field) continue;
    if (period != null && String(raw.period ?? "") !== period) continue;
    const v = num(raw.value);
    if (v !== null) hit = v; // 多条同 field 取最后一条(period 匹配时)
  }
  return hit;
}

/**
 * 取 next 这一天的四项读数。广度端点只给最新一天 —— next 就是今天时才取得到;
 * 成交额从趋势序列按 period 回查;涨跌停从当日盘后读数取(错过时点的也取不到,如实留空)。
 */
async function readingsFor(
  ctx: ServiceContext, next: string, today: string, oldest: string, fetcher: NonNullable<CallDeps["fetch"]>, signal: AbortSignal,
): Promise<NextReadings> {
  const gaps: string[] = [];
  let breadth_pct: number | null = null;
  let amount_yi: number | null = null;
  let limit_up: number | null = null;
  let limit_down: number | null = null;

  if (next === today) {
    try {
      const b = await fetcher(ctx, { endpoint: "em_market_breadth", consistency: { mode: "prefer_cache", max_age_ms: FRESH_MAX_AGE_MS }, signal });
      const env = b.envelope as { status?: string };
      if (env?.status === "failed") gaps.push(`涨跌分布没取到(${failedNote(b.envelope) || "没取到"})`);
      else {
        const br = extractBreadth(b.envelope);
        const up = br.up ?? 0, down = br.down ?? 0, flat = br.flat ?? 0;
        const total = up + down + flat;
        breadth_pct = total > 0 ? Math.round((up / total) * 1000) / 10 : null;
        limit_up = br.limit_up ?? null;
        limit_down = br.limit_down ?? null;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      gaps.push(`涨跌分布没取到(${e instanceof Error ? e.message.slice(0, 60) : "?"})`);
    }
  } else {
    gaps.push(`错过对账时点:${next} 的广度/涨跌停读数端点只给最新一天,补不回来`);
  }

  // 成交额:趋势序列按 period 回查(东财趋势往回查得到)
  try {
    // 🔴 只能要 60 天以上:底层 market_index_trend 硬校验 60~600,传 30 会被直接拒
    //    (`ValueError: days 须在 60~600 之间`),而这里只用到对账那一天的成交额,
    //    曾经写 30 导致每一次对账都「指数趋势没取到」—— 看着像上游坏了,其实是参数越界。
    const t = await fetcher(ctx, { endpoint: "em_market_trend", args: { days: 60 }, consistency: consistencyFor(next, oldest, false), signal });
    const env = t.envelope as { status?: string };
    if (env?.status === "failed") gaps.push(`指数趋势没取到(${failedNote(t.envelope) || "没取到"})`);
    else {
      const v = evValue(t.envelope, "market_amount_total", next);
      amount_yi = v != null ? v / 1e8 : null;
      if (amount_yi == null) gaps.push(`趋势序列里没有 ${next} 的两市成交额`);
    }
  } catch (e) {
    if (signal.aborted) throw e;
    gaps.push(`指数趋势没取到(${e instanceof Error ? e.message.slice(0, 60) : "?"})`);
  }

  return { next, breadth_pct, amount_yi, limit_up, limit_down, gaps };
}

/** 结构化触发条件命中没有。缺阈值、缺读数 → null(判不了,不进分母) */
export function judgeTrigger(
  metric: string | null | undefined, op: string | null | undefined, value: number | null | undefined,
  readings: { breadth_pct: number | null; amount_yi: number | null; limit_up: number | null; limit_down: number | null },
): boolean | null {
  if (!metric || !op || value == null) return null;
  const v = metric === "breadth_pct" ? readings.breadth_pct
    : metric === "amount_yi" ? readings.amount_yi
    : metric === "limit_up" ? readings.limit_up
    : metric === "limit_down" ? readings.limit_down : null;
  if (v == null) return null;
  return op === "above" ? v >= value : v <= value;
}

/**
 * 对账所有到期的判断:未结算的 date × 次一交易日(上证 A 股指数日 K 列交易日)。
 * 次日还没来 / 日 K 列不出 → 静默等待;读数缺 → 照写已有的、缺的留白并进缺口。
 */
export async function settleCalls(
  ctx: ServiceContext, now: Date, signal: AbortSignal, deps: CallDeps = {},
): Promise<SettleOutcome> {
  const all = ledgerList(ctx, MARKET_CALL_KIND)[MARKET_CALL_KIND] ?? [];
  const gaps: string[] = [];
  const pendingDates = [...new Set(all.filter((r) => r.settled !== true).map((r) => String(r.date)))].sort();
  if (!pendingDates.length) return { settled: 0, dates: [], gaps };
  const today = localClock(now, SCHEDULE_TZ).day;
  // 收盘后才允许结算「今天」这一笔。15:00 收盘,留 30 分钟让各家源把当日数落定。
  const nowHm = localClock(now, SCHEDULE_TZ).hm;
  const closedToday = nowHm >= SETTLE_AFTER_HM;
  const oldest = retentionFloor(now);
  const fetcher = deps.fetch ?? fetchEndpoint;

  let bars: string[] = [];
  try {
    const k = await fetcher(ctx, { endpoint: "tx_kline", symbol: "sh000002", args: { count: 100 }, consistency: { mode: "prefer_cache", max_age_ms: KLINE_MAX_AGE_MS }, signal });
    bars = klineBars(ctx, k.envelope, k.out_dir).map((b) => b.date);
  } catch (e) {
    if (signal.aborted) throw e;
    return { settled: 0, dates: [], gaps: ["上证A股指数日 K 没取到,列不出交易日,先不对账"] };
  }

  let settled = 0;
  const dates: string[] = [];
  for (const d of pendingDates) {
    const next = bars.find((x) => x > d);
    if (!next) {
      if (d < today) gaps.push(`${d} 的次一交易日列不出来(日 K 只到 ${bars.at(-1) ?? "空"}),先不对账`);
      continue;
    }
    if (next > today) continue; // 对账日还没来
    // 🔴 对账日就是今天、而今天还没收盘:此刻拿到的是**盘中读数**。
    //    一旦写成 settled,收盘后不会再更新 —— 这条战绩就永久记在错的数上。
    //    定时任务排在 16:05 本来碰不到,但手动运行、重启补跑都会踩到
    //    (2026-11-05 14:21 手动跑,把 11-04 那条用盘中 82.8 结算了,事后才发现)。
    if (next === today && !closedToday) continue;
    const r = await readingsFor(ctx, next, today, oldest, fetcher, signal);
    gaps.push(...r.gaps.map((g) => `${d}:${g}`));
    const group = all.filter((x) => x.date === d && x.settled !== true);
    let n = 0;
    const records = group.map((rec): Record<string, unknown> => {
      n++;
      // 保留 id:这些记录就在 match 组内,带 id = 原位更新(不换 id、created_at 不动);
      // envelope 键(kind/created_at/updated_at)由 ledgerReplace 自己剥
      const body: Record<string, unknown> = { ...rec };
      body.settled = true;
      body.settled_date = next;
      if (r.breadth_pct != null) body.next_breadth_pct = r.breadth_pct;
      if (r.amount_yi != null) body.next_amount_yi = Math.round(r.amount_yi * 100) / 100;
      // 次日涨跌停家数带 _count:裸的 next_limit_up 是 opportunity_track 的「次日再板」(boolean),不共用字段名
      if (r.limit_up != null) body.next_limit_up_count = Math.round(r.limit_up);
      if (r.limit_down != null) body.next_limit_down_count = Math.round(r.limit_down);
      const hit = judgeTrigger(pick(rec, "trigger_metric"), pick(rec, "trigger_op"), pickNum(rec, "trigger_value"), r);
      if (hit != null) body.trigger_hit = hit;
      return body;
    });
    if (!n) continue;
    ledgerReplace(ctx, {
      kind: MARKET_CALL_KIND,
      match: (x) => x.date === d && x.settled !== true,
      records,
    });
    settled += n;
    dates.push(d);
  }
  return { settled, dates, gaps };
}

// ─── 视图 ──────────────────────────────────────────────────────────────────────

export interface CallRow {
  date: string;
  call: string;
  direction: string;
  basis: string | null;
  trigger: string | null;
  trigger_metric: string | null;
  trigger_op: string | null;
  trigger_value: number | null;
  breadth_pct: number | null;
  amount_yi: number | null;
  limit_up: number | null;
  limit_down: number | null;
  settled: boolean;
  settled_date: string | null;
  next_breadth_pct: number | null;
  next_amount_yi: number | null;
  /** 次日涨停/跌停家数(_count 后缀避开 opportunity_track 的 next_limit_up=次日再板) */
  next_limit_up_count: number | null;
  next_limit_down_count: number | null;
  /** null = 判不了(没给结构化条件 / 读数缺) */
  trigger_hit: boolean | null;
  html_path: string | null;
  /**
   * 行来源:ledger=已落账台账;inbox=交接件还在 inbox 没落账(全景侧刚写件、16:05 扫描还没跑)。
   * 视图把两者并排给 —— 当天的判断不用等落账就能被复盘页看到;扫描后该行自动转 ledger。
   */
  source: "ledger" | "inbox";
}

export interface MarketCallResult {
  available: boolean;
  /** 最新一条判断的日期 */
  date: string | null;
  total: number;
  settled_count: number;
  pending_count: number;
  /** 触发条件命中战绩(只统计判得了的;判不了不进分母) */
  judged: number;
  hit: number;
  rows: CallRow[];
  caveat: string;
  generated_at: string;
}

const pick = (r: Record<string, unknown>, k: string): string | null => (typeof r[k] === "string" ? r[k] : null);
const pickNum = (r: Record<string, unknown>, k: string): number | null => num(r[k]);
const pickBool = (r: Record<string, unknown>, k: string): boolean | null => (typeof r[k] === "boolean" ? r[k] : null);

/**
 * inbox 里还没落账的交接件 → 视图行(只读,不挪文件、不落账)。
 * 不合法的 JSON 静默跳过 —— 它的缺口由 16:05 扫描任务负责写,视图只负责把能看的给人看。
 * 同日已有台账行时以台账为准(inbox 里同日的件是尚未扫描的修订,等扫描整条替换,这里不重复出两行)。
 */
function inboxRows(ctx: Pick<ServiceContext, "dataRoot">, ledgerDates: Set<string>): CallRow[] {
  const dir = path.join(ctx.dataRoot, INBOX_SUBDIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    return []; // 目录还没建:全景侧第一次落件时才有
  }
  const out: CallRow[] = [];
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue; // 坏件留给扫描任务报缺口
    }
    const parsed = parseCallJson(raw);
    if (!parsed.ok || ledgerDates.has(parsed.call.date)) continue;
    const c = parsed.call;
    out.push({
      date: c.date, call: c.call, direction: c.direction,
      basis: c.basis, trigger: c.trigger,
      trigger_metric: c.trigger_metric, trigger_op: c.trigger_op, trigger_value: c.trigger_value,
      breadth_pct: c.breadth_pct, amount_yi: c.amount_yi, limit_up: c.limit_up, limit_down: c.limit_down,
      settled: false, settled_date: null,
      next_breadth_pct: null, next_amount_yi: null, next_limit_up_count: null, next_limit_down_count: null,
      trigger_hit: null,
      html_path: c.html_path,
      source: "inbox",
    });
  }
  return out;
}

/**
 * 只读视图:最近 30 条判断 + 各自的对账结果 + 命中战绩。
 * 🔴 台账之外也读 inbox 里**还没落账**的合法交接件(source="inbox")——
 * 全景侧 15:00~16:00 落件、16:05 才扫描,这中间的当天判断要能被复盘页看到(方案 A 的前期工作);
 * 未落账行没有对账结果(settled=false、trigger_hit=null),不进战绩分母。
 */
export async function marketCallViewAct(ctx: ServiceContext, _query: Record<string, string>, _signal: AbortSignal, now = new Date()): Promise<MarketCallResult> {
  const ledger = (ledgerList(ctx, MARKET_CALL_KIND)[MARKET_CALL_KIND] ?? [])
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const ledgerDates = new Set(ledger.map((r) => String(r.date)));
  const rows: CallRow[] = [
    ...ledger.slice(0, 30).map((r) => ({
      date: String(r.date),
      call: String(r.call),
      direction: String(r.direction),
      basis: pick(r, "basis"),
      trigger: pick(r, "trigger"),
      trigger_metric: pick(r, "trigger_metric"),
      trigger_op: pick(r, "trigger_op"),
      trigger_value: pickNum(r, "trigger_value"),
      breadth_pct: pickNum(r, "breadth_pct"),
      amount_yi: pickNum(r, "amount_yi"),
      limit_up: pickNum(r, "limit_up"),
      limit_down: pickNum(r, "limit_down"),
      settled: r.settled === true,
      settled_date: pick(r, "settled_date"),
      next_breadth_pct: pickNum(r, "next_breadth_pct"),
      next_amount_yi: pickNum(r, "next_amount_yi"),
      next_limit_up_count: pickNum(r, "next_limit_up_count"),
      next_limit_down_count: pickNum(r, "next_limit_down_count"),
      trigger_hit: pickBool(r, "trigger_hit"),
      html_path: pick(r, "html_path"),
      source: "ledger" as const,
    })),
    ...inboxRows(ctx, ledgerDates),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);
  const judged = rows.filter((r) => r.trigger_hit != null);
  const settledCount = rows.filter((r) => r.settled).length;
  return {
    available: rows.length > 0,
    date: rows[0]?.date ?? null,
    total: rows.length,
    settled_count: settledCount,
    pending_count: rows.length - settledCount,
    judged: judged.length,
    hit: judged.filter((r) => r.trigger_hit === true).length,
    rows,
    caveat: MARKET_CALL_CAVEAT,
    generated_at: now.toISOString(),
  };
}

// ─── 定时任务 ──────────────────────────────────────────────────────────────────

/** 16:05:先扫 inbox 落账,再对账所有到期的。只列事实,不推送消息 */
export async function marketCallJob(j: { ctx: ServiceContext; now: Date; signal: AbortSignal }, deps: CallDeps = {}): Promise<{ messages: []; note: string }> {
  const scan = scanInbox(j.ctx, j.now);
  const settle = await settleCalls(j.ctx, j.now, j.signal, deps);
  const gaps = [...scan.gaps, ...settle.gaps];
  const parts = [
    `大盘判断台账:落账 ${scan.ingested} 条`,
    settle.settled ? `对账 ${settle.settled} 条(${settle.dates.join(",")})` : "没有到期可对账",
  ];
  // 修过就说出来:这份落件本来会让台账静默缺一天,补齐了也不能当没发生
  if (scan.repaired) parts.push(`其中 ${scan.repaired} 份落件的路径少了反斜杠转义(如 C:\\Users 写成了 C:\Users),已自动补齐`);
  if (gaps.length) parts.push(`缺口 ${gaps.length} 条:${gaps.slice(0, 3).join(";")}${gaps.length > 3 ? " 等" : ""}`);
  return { messages: [], note: parts.join(";") };
}
