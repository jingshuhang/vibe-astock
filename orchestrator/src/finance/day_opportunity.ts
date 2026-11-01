/**
 * 当日机会发现 —— **宽度优先**：哪些板块今天整体在动，但还没有成涨停潮。
 *
 * 和 `opportunity.ts`（板块机会链）的分工：
 *   - 机会链是**涨停池视角**：题材 → 龙头 → 次日条件式规划。起点是「已经涨停」。
 *   - 这里是**成分股视角**：板块指数成分 → 今天有多少只在涨 → 广度 / 中位涨幅 / 相对强度。
 *     **完全不依赖涨停池**，所以「一只涨停都没有」的时候也能看到板块在动。
 *   ⇒ 时间上：这里更早（甚至早于第一个涨停），机会链更晚（确认涨停成潮）。两段接力，不重复。
 *
 * 🔴 为什么必须用「指数成分」而不是「题材」：
 *    题材（「三季报增长」「"羊"字辈」）没有成分清单，只有**当天涨停的成员** ——
 *    所以题材口径天生看不到没涨停的票，永远算不出广度。
 *    中证/国证指数有官方成分文件（全表），这是能算广度的唯一基础。
 *
 * ⚠️ 四条硬限制，页面上必须写出来：
 *   ① 中证一级行业指数是**大中盘选样**，涨得最凶的小盘妖股大多不在成分里。
 *      10/30 实测：10 个行业里 **8 个涨停数为 0**，只有主要消费 / 医药卫生各 2 只。
 *      → 所以这里**不判「涨停成潮」**，那个交给机会链的题材口径，两段各管一段。
 *   ② 只覆盖中证/国证**有指数产品**的板块；申万一/二/三级行业指数不在其中。
 *   ③ `index_constituents` 的 evidence 只给**前 30 只**，全表在 raw json 里 ——
 *      必须读 raw，否则 196 只的「工业」只看 30 只会得出相反的结论。读不到时降级并标注。
 *   ④ 判定阈值（上涨 60%、中位 0 等）是**经验值**，不是统计出来的，可调。
 *
 * 数据来源与实测成本（2026-10-30）：
 *   - `index_constituents`（中证官网，provider=csi）：10 个行业并行 ~2.9s，成分 24~196 只，缓存 24h
 *   - `tx_quotes_batch`（腾讯，50 只/批）：去重 712 只 → 15 批并行 ~2.0s，**712/712 全部拿到**
 *   - `sina_board_flow`（新浪行业资金流，当日）：~0.7s，只做旁证
 *   整页约 6 秒，比机会链（48s）轻得多。
 */
import fs from "node:fs";
import path from "node:path";
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../service.ts";
import { clockOf } from "./shortline/intraday.ts";
import { packageHistory, marketBreadthOf, type PackageDay } from "./tdx_package.ts";

// ─── 板块清单 ───────────────────────────────────────────────────────────────────

/**
 * 中证一级行业指数（官方 10 个）。
 *
 * 为什么停在一级行业：二级/三级行业指数（如中证白酒 399997，17 只）粒度更像「板块」，
 * 但**没有官方全量清单**，只能一个个手填代码 —— 手填就有错的风险，且维护成本高。
 * 一级行业 10 个是官方标准、代码稳定、覆盖面完整，先用这个把链路跑通。
 * 想加细分板块（白酒 / 半导体 / 军工…），往这个数组里加 `{ code, name }` 即可，
 * 拉不到会自动进 gaps，不会崩。
 */
const BOARDS: { code: string; name: string }[] = [
  { code: "000928", name: "能源" },
  { code: "000929", name: "材料" },
  { code: "000930", name: "工业" },
  { code: "000931", name: "可选消费" },
  { code: "000932", name: "主要消费" },
  { code: "000933", name: "医药卫生" },
  { code: "000934", name: "金融地产" },
  { code: "000935", name: "信息技术" },
  { code: "000936", name: "电信业务" },
  { code: "000937", name: "公用事业" },
];

/** 单批行情只数（腾讯接口按 50 只一批，与机会链一致） */
const QUOTE_CHUNK = 50;

/**
 * 行情并发上限。
 *
 * 🔴 这里是**踩过的坑**：16 批全部并行时腾讯会偶发限频（实测两次里有一次失败 2 批），
 *    失败的那批票直接被排除在广度之外 → 主要消费只算到 24/36、医药卫生 33/71，
 *    广度被系统性低估，而且**看不出来是漏了数据还是真的弱**。
 *    所以限制到 6 批并发（总耗时从 2s 变 4s 左右，可接受）+ 失败重试。
 */
const QUOTE_CONCURRENCY = 6;

/** 单批最多尝试次数（含首次） */
const QUOTE_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 广度档位。
 *
 * 🔴 这是**经验阈值**，不是统计出来的分位。写死在这里是为了可审、可调 ——
 *    换成「回测出来的阈值」之前，不许在页面上说成「历史最优」。
 */
export const WIDTH = {
  /** 上涨占比 ≥ 这个数才算「广度起来了」 */
  up_strong: 0.6,
  /** 上涨占比 ≤ 这个数算「整体走弱」 */
  up_weak: 0.3,
  /** 拿到行情的只数少于此值 → 数据不足，不判 */
  min_quoted: 5,
};

/**
 * 宽度回溯几个交易日。
 *
 * 5 天够看出「在扩张 / 在收缩 / 一直平」，又不至于把首屏拖太久
 * （冷缓存下一份包约 11s，5 天并发 3 约 22s；热缓存后读本地 json 约 20ms/天）。
 */
export const BREADTH_HISTORY_DAYS = 5;

/** 回溯并发：每个包是一次 2.7MB HTTP 下载 + 5.2 万行二进制解析，别一次全打出去 */
const HISTORY_CONCURRENCY = 3;

// ─── 类型 ───────────────────────────────────────────────────────────────────────

export type BreadthState = "在动" | "分化" | "平淡" | "走弱" | "数据不足";

/**
 * 某一天的板块宽度（回溯出来的历史点）。
 *
 * 🔴 **历史是回溯，不是「攒」。** 来源是 `tdx_daily_package` —— 它带 `date` 参数，
 *    官网从 2022 年起都留着包，所以第一天打开就能把近 5 天全算出来。
 *    缓存（`repoRoot/.local/cache/tdx_daily/`）只是把第二天的成本降到「新增 1 天」。
 */
export interface BreadthHistoryPoint {
  date: string;
  /** 当日上涨占比（成分里拿到价的那部分） */
  up_rate: number;
  /** 当日中位涨幅（%） */
  median: number;
  /** 当日真正拿到价的成分只数 —— 停牌多的日子这个数会明显小 */
  quoted: number;
  /**
   * 当日**同一批成分**的上涨占比（即基准）。
   *
   * 🔴 用它而不是「全市场 5570 只」做基准，是为了**同口径**：
   *    今日宽度来自腾讯实时行情（只有 800 只成分），真全市场只有收盘后才从盘后包拿到。
   *    拿 800 只的分子去比 5570 只的分母，盘中会凭空多出几个 pp。
   *    真全市场的数另外放在 `breadth_history.market` 里，只作参考，不参与相对宽度。
   */
  base_up_rate: number;
}

/** 一个板块今天的成分股广度 */
export interface BoardBreadth {
  index_code: string;
  name: string;
  /** 成分全表只数（来自 raw，不是 evidence 的 30 条） */
  members: number;
  /** 真正拿到行情的只数 */
  quoted: number;
  /** 成分清单是否只拿到前 30 条（raw 读失败时的降级标记） */
  truncated: boolean;
  up: number;
  up_rate: number;
  /** 涨 ≥ 5% 的只数 */
  over5: number;
  over5_rate: number;
  /** 跌 ≤ -5% 的只数 */
  deep_loss: number;
  deep_loss_rate: number;
  /** 中位涨幅（比均值抗极端值，主排序用它） */
  median: number;
  mean: number;
  /** 成分股成交额合计（亿元） */
  amount_yi: number | null;
  best: { name: string; ret: number } | null;
  worst: { name: string; ret: number } | null;
  /** 相对强度 = 本板块中位涨幅 − 全市场（样本内）中位涨幅，单位 pp */
  rel_median: number;
  state: BreadthState;
  /**
   * 回溯出来的宽度序列（不含今日，按日期升序）。
   * 空数组 = 一个历史交易日都没拿到 —— 那时 `width_delta_pp` 只能是 null，
   * **不能拿今日自己跟自己比**。
   */
  history: BreadthHistoryPoint[];
  /** 上一交易日上涨占比；null = 没回溯到 */
  prev_up_rate: number | null;
  /** 今日上涨占比 − 昨日（pp）。正 = 宽度在扩张，负 = 在收缩 */
  width_delta_pp: number | null;
  /**
   * 相对宽度 = 今日上涨占比 − **同一批成分**的上涨占比（pp）。
   * 剔除「今天大盘普涨/普跌」这一层：全市场 81% 上涨那天，十个板块九个都在 60% 以上，那是大盘不是板块。
   */
  rel_width_pp: number | null;
  /**
   * 超额宽度变化 = 今日相对宽度 − 上一交易日相对宽度（pp）。
   *
   * 🔴 这才是可以横向读的「参与面在扩张」。
   *    裸差（`width_delta_pp`）实测有 **44% 的情况下符号是错的** ——
   *    大盘涨 70pp 的时候，任何板块的裸差都是正的，但它在市场上其实变弱了。
   */
  rel_width_delta_pp: number | null;
  /** 判成这个档位的依据，逐条写出来 */
  evidence: string[];
}

/** 新浪行业资金流（当日，仅旁证） */
export interface IndustryFlow {
  name: string;
  change_pct: number | null;
  net_yi: number | null;
  note: string | null;
}

export interface DayOpportunityResult {
  date: string;
  clock: string;
  settled: boolean;
  boards: BoardBreadth[];
  /** 全市场参照：所有板块成分去重后的样本 */
  universe: {
    quoted: number;
    median: number;
    up_rate: number;
    over5: number;
    deep_loss: number;
  } | null;
  /** 行业资金流（新浪口径，当日；只有当日，没有 5/10 日） */
  flows: IndustryFlow[];
  /** 宽度回溯的覆盖情况（历史来自通达信盘后包，不是「攒」出来的） */
  breadth_history: {
    /** 实际拿到几个交易日 */
    days: number;
    from: string | null;
    to: string | null;
    /** 最近一份包里解出多少条有价记录（全市场，含基金债券，不是股票只数） */
    priced: number | null;
    /**
     * 真·全市场（仅 A 股）逐日宽度，**只作参考，不参与相对宽度计算**。
     * 它与「成分样本」是两个池子：成分是大中盘选样，市值分布偏高，
     * 两者差多少本身就是风格信息（10/30：样本 30.4% vs 全市场 16.0% → 大中盘明显强于小盘）。
     */
    market: { date: string; up_rate: number; median: number; n: number }[];
  };
  gaps: string[];
  notes: string[];
  sources: string[];
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** 代码 → 腾讯行情代码（6/9 开头沪市、4/8 开头北交所，其余深市） */
function quoteCodeOf(code: string): string {
  if (/^(6|9)/.test(code)) return `sh${code}`;
  if (/^(4|8)/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

const envelopeOf = (r: FetchResult | null): Record<string, unknown> | null =>
  (r?.envelope ?? null) as Record<string, unknown> | null;

const evidenceOf = (r: FetchResult | null): Record<string, unknown>[] => {
  const ev = envelopeOf(r)?.evidence;
  return Array.isArray(ev) ? (ev as Record<string, unknown>[]) : [];
};

/** 中位数。空数组返回 null —— 不拿 0 冒充 */
export function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── 成分清单：必须读 raw 全表 ───────────────────────────────────────────────────

/**
 * 取一个板块指数的全部成分股代码。
 *
 * 🔴 `evidence` 只给前 30 条（registry notes：「证据按权重取前 30，全表在 raw」）。
 *    196 只的「工业」如果只按前 30 只（权重最大的 30 只）算广度，结论会整个反过来 ——
 *    大权重股和小票当天的走势经常是两个方向。所以**必须读 raw json 的 rows 全表**。
 *
 * 返回 `truncated: true` 表示 raw 读失败、退回 evidence 的 30 条；
 * 页面必须把这个标记显示出来，否则用户会把「前 30 只的广度」当成「整个板块的广度」。
 */
function membersOf(ctx: ServiceContext, r: FetchResult): { codes: string[]; truncated: boolean } {
  const rawFiles = envelopeOf(r)?.extra as Record<string, unknown> | undefined;
  const files = Array.isArray(rawFiles?.raw_files) ? (rawFiles!.raw_files as string[]) : [];
  const json = files.find((f) => f.endsWith(".json") && f.includes("extracted"));
  if (json) {
    try {
      const full = path.join(ctx.dataRoot, r.out_dir, json);
      if (fs.existsSync(full)) {
        const doc = JSON.parse(fs.readFileSync(full, "utf8")) as { rows?: Record<string, unknown>[] };
        const codes = (doc.rows ?? []).map((x) => String(x.code ?? "")).filter((c) => /^\d{6}$/.test(c));
        if (codes.length) return { codes: [...new Set(codes)], truncated: false };
      }
    } catch {
      // 落到 evidence 降级，不抛 —— 一个板块读不到全表不该拖垮整页
    }
  }
  // 降级：evidence 里 record_key 形如 "000932:000568"（指数:成分）
  const codes = evidenceOf(r)
    .map((e) => String(e.record_key ?? ""))
    .filter((k) => k.includes(":"))
    .map((k) => k.split(":")[1])
    .filter((c) => /^\d{6}$/.test(c));
  return { codes: [...new Set(codes)], truncated: true };
}

// ─── 行情 ───────────────────────────────────────────────────────────────────────

interface QuoteLite {
  name: string | null;
  change_pct: number | null;
  price: number | null;
  limit_up_price: number | null;
  amount_yi: number | null;
}

/**
 * 批量取行情：按 50 只一批，**限并发 + 失败重试**。
 *
 * 🔴 不做限流时实测会出现「16 批里 2 批失败」→ 那些票被静默排除，广度整体偏低。
 *    所以：① 同时最多 6 批在飞；② 单批最多尝试 3 次；③ 数据用 `into` 累积（重试只补缺的）。
 *    真正补不回来的批会进 gaps，绝不让它悄悄消失。
 */
async function quotesOf(
  ctx: ServiceContext,
  codes: string[],
  signal: AbortSignal,
  gaps: string[],
): Promise<Map<string, QuoteLite>> {
  const out = new Map<string, QuoteLite>();
  if (!codes.length) return out;
  const chunks: string[][] = [];
  for (let i = 0; i < codes.length; i += QUOTE_CHUNK) chunks.push(codes.slice(i, i + QUOTE_CHUNK));

  const fetchChunk = async (chunk: string[]): Promise<void> => {
    for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt++) {
      if (signal.aborted) return;
      try {
        const r = await fetchEndpoint(ctx, {
          endpoint: "tx_quotes_batch",
          args: { codes: chunk.map(quoteCodeOf) },
          signal,
          timeout_ms: 30_000,
        });
        const byCode = new Map<string, Record<string, unknown>>();
        for (const e of evidenceOf(r)) {
          const key = String(e.record_key ?? "").replace(/^(sh|sz|bj)/, "");
          if (!key) continue;
          const m = byCode.get(key) ?? {};
          m[String(e.field ?? "")] = e.value;
          byCode.set(key, m);
        }
        for (const [code, m] of byCode) {
          const ta = num(m.turnover_amount);
          out.set(code, {
            name: typeof m.security_name === "string" ? m.security_name : null,
            change_pct: num(m.change_pct),
            price: num(m.price),
            limit_up_price: num(m.limit_up_price),
            // 腾讯口径：成交额单位「万元」→ 亿元
            amount_yi: ta == null ? null : round(ta / 1e4, 2),
          });
        }
        // 这一批拿到的够不够：只要有一个有效涨跌幅就算这批通了
        if (chunk.some((c) => out.get(c)?.change_pct != null)) return;
      } catch {
        // 落到重试
      }
      if (attempt < QUOTE_ATTEMPTS) await sleep(250 * attempt);
    }
    gaps.push(`有一批 ${chunk.length} 只的行情连续 ${QUOTE_ATTEMPTS} 次没拿到 → 这些票不计入广度`);
  };

  // 限并发：一次只让 QUOTE_CONCURRENCY 批在飞
  let cursor = 0;
  const workers = Array.from({ length: Math.min(QUOTE_CONCURRENCY, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const i = cursor++;
      await fetchChunk(chunks[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── 广度计算 ───────────────────────────────────────────────────────────────────

/** 每只票的涨跌幅，按代码索引 */
function returnsOf(quotes: Map<string, QuoteLite>, codes: string[]): { code: string; q: QuoteLite; ret: number }[] {
  const out: { code: string; q: QuoteLite; ret: number }[] = [];
  for (const c of codes) {
    const q = quotes.get(c);
    if (!q || q.change_pct == null) continue;
    out.push({ code: c, q, ret: q.change_pct });
  }
  return out;
}

/**
 * 从一份盘后包算出某个板块当日的宽度。
 *
 * 🔴 用**今日的成分清单**去套历史包 —— 成分会调整，用今天的名单回看历史是**近似**，
 *    但对「这几天宽度在扩张还是收缩」这个用途足够了；而且反过来（用历史成分）拿不到历史名单。
 *    这一点必须写在页面说明里，不能假装是严格口径。
 *
 * 包里键是 `sh600519` 这种带前缀的，和 `tx_quotes_batch` 同一套，直接复用 `quoteCodeOf`。
 * `baseUpRate` 是同一天**同一批成分**的上涨占比（基准），由调用方算好传进来。
 */
function widthOn(pkg: PackageDay, codes: string[], baseUpRate: number): BreadthHistoryPoint | null {
  const rets: number[] = [];
  for (const c of codes) {
    const v = pkg.chg.get(quoteCodeOf(c));
    if (v != null && Number.isFinite(v)) rets.push(v);
  }
  if (rets.length < WIDTH.min_quoted) return null;
  return {
    date: pkg.date,
    up_rate: round(rets.filter((x) => x > 0).length / rets.length),
    median: round(medianOf(rets) ?? 0, 2),
    quoted: rets.length,
    base_up_rate: baseUpRate,
  };
}

/** 同一天、**同一批 codes** 的上涨占比（相对宽度的基准）。与 `widthOn` 同口径，可相减 */
function upRateOn(pkg: PackageDay, codes: string[]): number | null {
  let up = 0;
  let n = 0;
  for (const c of codes) {
    const v = pkg.chg.get(quoteCodeOf(c));
    if (v == null || !Number.isFinite(v)) continue;
    n++;
    if (v > 0) up++;
  }
  return n >= WIDTH.min_quoted ? round(up / n) : null;
}

/**
 * 判档位。
 *
 * 刻意**不做「爆发」档**：中证一级行业是大中盘选样，10/30 十个行业里八个涨停数为 0，
 * 在这个口径下「有没有涨停潮」根本测不出来。爆发交给机会链的题材口径。
 * 这里只回答一件事：**这个板块今天整体在不在涨**。
 */
export function stateOf(upRate: number, median: number, quoted: number): { state: BreadthState; why: string[] } {
  const why: string[] = [];
  if (quoted < WIDTH.min_quoted) {
    return { state: "数据不足", why: [`只拿到 ${quoted} 只行情（少于 ${WIDTH.min_quoted} 只），不判广度`] };
  }
  const upPct = Math.round(upRate * 1000) / 10;
  const med = `${median > 0 ? "+" : ""}${median.toFixed(2)}%`;
  if (upRate <= WIDTH.up_weak) {
    why.push(`上涨只有 ${upPct}%（≤ ${WIDTH.up_weak * 100}%）`);
    why.push(`中位涨幅 ${med}`);
    return { state: "走弱", why };
  }
  if (upRate >= WIDTH.up_strong && median > 0) {
    why.push(`上涨 ${upPct}%（≥ ${WIDTH.up_strong * 100}%）`);
    why.push(`中位涨幅 ${med}，价格和广度同向`);
    return { state: "在动", why };
  }
  if (upRate >= WIDTH.up_strong && median <= 0) {
    why.push(`上涨 ${upPct}% 但中位涨幅只有 ${med}`);
    why.push("涨的多是微涨、拖累的是大票 → 这不叫板块在涨");
    return { state: "分化", why };
  }
  why.push(`上涨 ${upPct}%，在 ${WIDTH.up_weak * 100}%~${WIDTH.up_strong * 100}% 之间`);
  why.push(`中位涨幅 ${med}`);
  return { state: "平淡", why };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────────

export async function dayOpportunityAct(
  ctx: ServiceContext,
  _body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<DayOpportunityResult> {
  const { day, hms } = clockOf(new Date());
  const gaps: string[] = [];
  const notes: string[] = [];

  // ① 成分清单：10 个行业并行（缓存 24h，成分一天不变）
  const memberMap = new Map<string, { name: string; codes: string[]; truncated: boolean }>();
  await Promise.all(BOARDS.map(async (b) => {
    try {
      const r = await fetchEndpoint(ctx, {
        endpoint: "index_constituents",
        symbol: b.code,
        args: { provider: "csi" },
        signal,
        timeout_ms: 60_000,
      });
      const env = envelopeOf(r);
      if (env?.status === "failed") {
        const errs = (env.errors as { error?: string }[] | undefined) ?? [];
        gaps.push(`${b.name}（${b.code}）成分取不到：${errs[0]?.error ?? "上游 failed"}`);
        return;
      }
      const { codes, truncated } = membersOf(ctx, r);
      if (!codes.length) {
        gaps.push(`${b.name}（${b.code}）成分为空 → 这个板块今天不参与广度计算`);
        return;
      }
      memberMap.set(b.code, { name: b.name, codes, truncated });
    } catch (e) {
      gaps.push(`${b.name}（${b.code}）成分取不到：${e instanceof Error ? e.message : String(e)}`);
    }
  }));

  if (!memberMap.size) {
    gaps.push("所有板块的成分都取不到 → 今天没有广度可算，这不是「没有机会」，是没数据");
  }

  // ② 全部成分去重后一次性取行情；③ 同时回溯近 N 个交易日的全市场涨跌幅
  const allCodes = new Set<string>();
  for (const m of memberMap.values()) for (const c of m.codes) allCodes.add(c);
  const histPromise = packageHistory(ctx, BREADTH_HISTORY_DAYS, signal, { concurrency: HISTORY_CONCURRENCY })
    .catch(() => [] as PackageDay[]);
  const quoteMap = await quotesOf(ctx, [...allCodes], signal, gaps);
  const pkgs = await histPromise;
  if (!pkgs.length) {
    gaps.push(
      "宽度回溯没取到任何一个历史交易日的通达信盘后包 → 只能看今日单点，"
      + "比不了「在扩张还是在收缩」（这已经是历史回溯，不是要攒；拿不到是包缺失或网络问题）",
    );
  } else if (pkgs.length < BREADTH_HISTORY_DAYS) {
    notes.push(`宽度只回溯到 ${pkgs.length}/${BREADTH_HISTORY_DAYS} 个交易日（节假日 / 包未发布会落空，不用前一交易日顶替）`);
  }

  // ②' 每日基准：同一批成分的上涨占比（算相对宽度用）+ 真全市场（仅参考）
  const pkgBase = new Map<string, number>();
  const pkgMarket = new Map<string, { up_rate: number; median: number; n: number }>();
  for (const p of pkgs) {
    const b = upRateOn(p, [...allCodes]);
    if (b != null) pkgBase.set(p.date, b);
    const mk = marketBreadthOf(p);
    if (mk) pkgMarket.set(p.date, mk);
  }

  // ④ 全市场参照（所有板块成分的并集去重后的样本）
  const universeRows = returnsOf(quoteMap, [...allCodes]);
  const universe = universeRows.length
    ? {
      quoted: universeRows.length,
      median: round(medianOf(universeRows.map((x) => x.ret)) ?? 0, 2),
      up_rate: round(universeRows.filter((x) => x.ret > 0).length / universeRows.length),
      over5: universeRows.filter((x) => x.ret >= 5).length,
      deep_loss: universeRows.filter((x) => x.ret <= -5).length,
    }
    : null;
  const uniMedian = universe?.median ?? 0;

  // ⑤ 逐板块算广度
  const boards: BoardBreadth[] = [];
  for (const [indexCode, m] of memberMap) {
    const rows = returnsOf(quoteMap, m.codes);
    const rets = rows.map((x) => x.ret);
    const n = rets.length;
    if (!n) {
      boards.push({
        index_code: indexCode,
        name: m.name, members: m.codes.length, quoted: 0, truncated: m.truncated,
        up: 0, up_rate: 0, over5: 0, over5_rate: 0, deep_loss: 0, deep_loss_rate: 0,
        median: 0, mean: 0, amount_yi: null, best: null, worst: null,
        rel_median: 0, state: "数据不足", evidence: ["一只行情都没拿到"],
        history: pkgs.filter((p) => pkgBase.has(p.date))
          .map((p) => widthOn(p, m.codes, pkgBase.get(p.date)!))
          .filter((x): x is BreadthHistoryPoint => x !== null),
        prev_up_rate: null, width_delta_pp: null,
        rel_width_pp: null, rel_width_delta_pp: null,
      });
      continue;
    }
    const up = rows.filter((x) => x.ret > 0).length;
    const over5 = rows.filter((x) => x.ret >= 5).length;
    const deep = rows.filter((x) => x.ret <= -5).length;
    const med = round(medianOf(rets) ?? 0, 2);
    const mean = round(rets.reduce((a, b) => a + b, 0) / n, 2);
    const amount = rows.reduce((a, x) => (x.q.amount_yi == null ? a : a + x.q.amount_yi), 0);
    const sorted = [...rows].sort((a, b) => b.ret - a.ret);
    const { state, why } = stateOf(up / n, med, n);
    const rel = round(med - uniMedian, 2);

    const history = pkgs.filter((p) => pkgBase.has(p.date))
      .map((p) => widthOn(p, m.codes, pkgBase.get(p.date)!))
      .filter((x): x is BreadthHistoryPoint => x !== null);
    const prev = history.length ? history[history.length - 1] : null;
    const delta = prev ? round((up / n - prev.up_rate) * 100, 1) : null;

    // 相对宽度：今日基准用**样本内**（800 只成分并集），历史基准用同日同批成分 —— 同口径才可相减
    const relWidth = universe ? round((up / n - universe.up_rate) * 100, 1) : null;
    const prevRel = prev ? round((prev.up_rate - prev.base_up_rate) * 100, 1) : null;
    const relDelta = relWidth != null && prevRel != null ? round(relWidth - prevRel, 1) : null;

    const evidence = [...why];
    if (universe) {
      evidence.push(`中位涨幅比全市场样本（${uniMedian > 0 ? "+" : ""}${uniMedian}%）${rel >= 0 ? "高" : "低"} ${Math.abs(rel).toFixed(2)}pp`);
    }
    if (delta != null && prev) {
      evidence.push(
        `上涨占比 ${delta >= 0 ? "比" : "低于"}上一交易日（${prev.date}）${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`
        + `（${Math.round(prev.up_rate * 100)}% → ${Math.round((up / n) * 1000) / 10}%）`,
      );
    }
    if (relDelta != null) {
      evidence.push(
        `扣掉同日基准后 ${relDelta >= 0 ? "扩张" : "收缩"} ${Math.abs(relDelta).toFixed(1)}pp`
        + `（相对宽度 ${prevRel! >= 0 ? "+" : ""}${prevRel!.toFixed(1)} → ${relWidth! >= 0 ? "+" : ""}${relWidth!.toFixed(1)}pp）`
        + (delta != null && Math.sign(delta) !== Math.sign(relDelta) && Math.abs(delta) > 3
          ? " ⚠️ 裸差与超额差方向相反：这一档变化主要是大盘带来的"
          : ""),
      );
    }
    if (m.truncated) evidence.push(`⚠️ 只拿到前 ${m.codes.length} 只成分（raw 全表读取失败），这不是全板块广度`);
    if (n < m.codes.length) evidence.push(`${m.codes.length} 只成分里有 ${m.codes.length - n} 只没拿到行情，已排除`);

    boards.push({
      index_code: indexCode,
      name: m.name,
      members: m.codes.length,
      quoted: n,
      truncated: m.truncated,
      up,
      up_rate: round(up / n),
      over5,
      over5_rate: round(over5 / n),
      deep_loss: deep,
      deep_loss_rate: round(deep / n),
      median: med,
      mean,
      amount_yi: amount > 0 ? round(amount, 1) : null,
      best: sorted[0] ? { name: sorted[0].q.name ?? sorted[0].code, ret: round(sorted[0].ret, 2) } : null,
      worst: sorted.length > 1 ? { name: sorted[sorted.length - 1].q.name ?? sorted[sorted.length - 1].code, ret: round(sorted[sorted.length - 1].ret, 2) } : null,
      rel_median: rel,
      state,
      history,
      prev_up_rate: prev ? prev.up_rate : null,
      width_delta_pp: delta,
      rel_width_pp: relWidth,
      rel_width_delta_pp: relDelta,
      evidence,
    });
  }
  // 排序：先按「在动」优先，再按相对强度降序 —— 目的是把「整体在涨」的板块顶到最上面
  const order: Record<BreadthState, number> = { "在动": 0, "分化": 1, "平淡": 2, "走弱": 3, "数据不足": 4 };
  boards.sort((a, b) => (order[a.state] - order[b.state]) || (b.rel_median - a.rel_median));

  // ⑤ 行业资金流：只做旁证（新浪口径、只有当日、行业名与中证指数名不是一套）
  const flows: IndustryFlow[] = [];
  try {
    const r = await fetchEndpoint(ctx, {
      endpoint: "sina_board_flow",
      args: { board_type: "industry" },
      signal,
      timeout_ms: 25_000,
    });
    const byKey = new Map<string, { name: string; chg: number | null; net: number | null; note: string | null }>();
    for (const e of evidenceOf(r)) {
      const key = String(e.record_key ?? "").replace(/^industry\|/, "");
      if (!key) continue;
      const cur = byKey.get(key) ?? { name: key, chg: null, net: null, note: null };
      const field = String(e.field ?? "");
      if (field === "board_change_pct_sina") cur.chg = num(e.value);
      if (field === "board_net_sina") {
        const v = num(e.value);
        cur.net = v == null ? null : round(v / 1e8, 2);
      }
      if (typeof e.note === "string" && !cur.note) {
        // note 形如「酿酒行业 排名 1;领涨 皇台酒业 10.0078%;新浪口径…」→ 取中文行业名
        const m = /^(.+?)\s*排名/.exec(e.note);
        if (m) cur.name = m[1].trim();
        cur.note = e.note;
      }
      byKey.set(key, cur);
    }
    flows.push(...[...byKey.values()].map((x) => ({ name: x.name, change_pct: x.chg, net_yi: x.net, note: x.note })));
  } catch (e) {
    gaps.push(`行业资金流取不到：${e instanceof Error ? e.message : String(e)}`);
  }

  const moving = boards.filter((b) => b.state === "在动");
  if (moving.length) {
    notes.push(
      `${moving.length} 个板块广度在动（${moving.map((b) => b.name).join("、")}）—— `
      + "这是「成分股在涨」，不是「涨停成潮」；中证一级行业是大中盘选样，妖股不在里面，爆发与否看板块机会链的题材口径",
    );
  } else if (boards.length) {
    notes.push("今天没有板块达到「广度在动」的标准（上涨 ≥60% 且中位涨幅 >0）→ 这是结论，不是缺数");
  }
  const expanding = moving.filter((b) => b.rel_width_delta_pp != null && b.rel_width_delta_pp > 0);
  if (expanding.length) {
    notes.push(
      `${expanding.map((b) => `${b.name}（超额 +${b.rel_width_delta_pp!.toFixed(1)}pp）`).join("、")} 的宽度比上一交易日在扩张 —— `
      + "这里用的是**扣掉同日基准后**的变化；「在涨 + 参与面在扩大」和「在涨但参与面在缩」是两回事，后者只有少数大票扛",
    );
  }
  // 裸差为正但超额为负 = 只是被大盘抬上去的，这不是板块变强
  const fakeUp = boards.filter((b) => b.width_delta_pp != null && b.width_delta_pp > 3
    && b.rel_width_delta_pp != null && b.rel_width_delta_pp < 0);
  if (fakeUp.length) {
    notes.push(
      `${fakeUp.map((b) => b.name).join("、")} 的裸差是正的，但扣掉大盘后是负的 —— `
      + "「比昨天多涨了一批票」不等于「比市场上其他板块更强」，这类不要当成扩张",
    );
  }
  if (boards.some((b) => b.truncated)) {
    notes.push("有板块只拿到前 30 只成分（raw 全表读取失败）→ 那些板块的广度不可信，已在行内标注");
  }
  notes.push("行业资金流是新浪口径（流入−流出，不是东财主力净额），只有当日、没有 5/10 日，且它与中证指数名不是一套命名 → 只做旁证，不与广度合并");
  if (pkgs.length) {
    notes.push(
      `宽度历史来自通达信盘后包（回溯 ${pkgs.length} 个交易日，最新一天 ${pkgs[pkgs.length - 1]!.priced} 条全市场有价记录）——`
      + "**用今日的成分清单回看历史**，成分调整会让老日子有偏差；且今日是盘中实时、历史是收盘定格，盘中对比偏高估",
    );
    const mk = [...pkgMarket.values()];
    if (mk.length >= 2) {
      const lo = Math.min(...mk.map((m) => m.up_rate));
      const hi = Math.max(...mk.map((m) => m.up_rate));
      notes.push(
        `同期真·全市场（仅 A 股，${mk[mk.length - 1]!.n} 只）上涨占比在 ${(lo * 100).toFixed(0)}%~${(hi * 100).toFixed(0)}% 之间摆动 —— `
        + `这就是为什么绝对宽度没有信息量：全市场 ${(hi * 100).toFixed(0)}% 上涨的那天，十个板块里九个的上涨占比都在 60% 以上，那是大盘不是板块`,
      );
    }
  }
  if (universe) {
    notes.push(
      `今日「全市场参照」是 ${universe.quoted} 只成分去重后的样本（中证一级行业＝大中盘选样），`
      + "不是 5570 只真全市场 —— 两个池子不混用，所以相对宽度一律拿**同一批成分**做基准",
    );
  }

  return {
    date: day,
    clock: hms.slice(0, 5),
    settled: hms >= "15:00",
    boards,
    universe,
    flows,
    breadth_history: {
      days: pkgs.length,
      from: pkgs[0]?.date ?? null,
      to: pkgs.length ? pkgs[pkgs.length - 1]!.date : null,
      priced: pkgs.length ? pkgs[pkgs.length - 1]!.priced : null,
      market: [...pkgMarket.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, m]) => ({ date, ...m })),
    },
    gaps,
    notes,
    sources: [
      "中证指数官网成分文件（index_constituents，provider=csi；读 raw 全表，不用 evidence 的前 30 条）",
      "腾讯批量行情（tx_quotes_batch，50 只/批，含涨停价与成交额）",
      "通达信盘后包（tdx_daily_package，按 date 回溯全市场日线，自解 raw zip；宽度历史唯一来源）",
      "新浪行业资金流（sina_board_flow，当日、仅旁证）",
    ],
  };
}
