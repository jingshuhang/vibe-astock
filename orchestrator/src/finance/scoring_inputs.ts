/**
 * 「评分输入」的解析 —— 全仓唯一一份。
 *
 * 为什么要有这个文件：
 *   `/view/market_state_view`（市场状态页、机会发现页）和 `/view/shortline_overview`
 *   （盯盘 · 市场实时概况里内嵌的那张卡）都要把同一批端点压成 `scoreMarket` 的输入。
 *   早先两处各写一份解析，于是**同一个收盘、同一批上游数据，两个页面给出 37 分和 39 分**。
 *
 * 实测差异（2026-10-30 收盘后）：
 *   其余四维完全一致（情绪 46 / 龙头 55 / 风险 15 / 事件 58），只有赚钱效应 22 vs 28。
 *   原因：概况页喂进去的是**展示用的净流入 Top 12**（12 行全为正 → inflowRate = 100%），
 *        独立页喂的是一份**没按 field 过滤的混装数组**（净流入 / 流入 / 涨跌幅 / 净占比
 *        各 48 条混在一起 → 157/240 = 65.4%，看着像「全量 240 个板块」，其实没有意义）。
 *   `(1.00 − 0.654) × 20 = 6.9 分` × 权重 0.2706 ≈ 1.9 分 —— 正好是 39 与 37 的差。
 *   ✅ 两条都不对。正确口径是 48 个板块里 26 个净流入 = 54.2%（见 `boardFlowNetRows`）。
 *
 * 🔴 两条铁律（都是踩过的坑）：
 *   1. **聚合必须在截断之前算**。展示用的 Top10 / Top12 是「挑出来最好的那些」，
 *      拿它们的均值或占比当输入，这一维必然常年贴顶、看不出变化。
 *   2. **展示截断的数组一律不进评分**。要评分就重新从信封里取全量。
 *      这一条跟 `gateDataFrom` 是同一个道理：一份解析、两个入口共用，不许各写一遍。
 *   3. **长表必须按 field 过滤**。一个板块出多条证据的端点，不筛字段等于换了个分母。
 */

/** 端点信封里的长表记录（一个字段一行，靠 `record_key` 透视成「一行一个对象」） */
export interface EvRec {
  field?: string;
  value?: unknown;
  record_key?: string;
  note?: string;
  period?: string;
  unit?: string;
}

export const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** 取信封本体：既接受 `{envelope:{...}}`（FetchResult），也接受信封本身 */
export function envelopeOf(x: unknown): Record<string, unknown> | null {
  if (!x || typeof x !== "object") return null;
  const inner = (x as { envelope?: unknown }).envelope;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  if (Array.isArray((x as { evidence?: unknown }).evidence)) return x as Record<string, unknown>;
  return null;
}

/** 长表 → 按 record_key 透视成「一行一个对象」。和前端 backend.ts 的 rows() 同口径（取资料期最新） */
export function groupByKey(env: Record<string, unknown>): Map<string, { note: string; fields: Map<string, EvRec> }> {
  const ev = Array.isArray(env.evidence) ? (env.evidence as EvRec[]) : [];
  const m = new Map<string, { note: string; fields: Map<string, EvRec> }>();
  const pk = (s?: string) => (s ?? "").replace(/\d+/g, (d) => d.padStart(8, "0"));
  for (const e of ev) {
    const rk = e.record_key;
    if (!rk) continue;
    let row = m.get(rk);
    if (!row) {
      row = { note: e.note ?? "", fields: new Map() };
      m.set(rk, row);
    }
    const prev = row.fields.get(e.field ?? "");
    if (!prev || pk(e.period) > pk(prev.period)) row.fields.set(e.field ?? "", e);
    if (!row.note && e.note) row.note = e.note;
  }
  return m;
}

/** 一个板块的共振读数（东财行业对比端点） */
export interface ResonanceRow {
  name: string;
  change_pct: number | null;
  up_count: number;
  down_count: number;
  total: number | null;
  /** 上涨家数 ÷（上涨 + 下跌）× 100，0~100 */
  resonance_rate: number | null;
  rank: number | null;
  signal: "共振" | "强动" | "一般";
}

export interface ResonanceParse {
  /** 全部板块，按共振率降序（调用方自己决定展示截断到几行） */
  rows: ResonanceRow[];
  /** 全部板块共振率的算术均值（0~100）。⚠️ 只作参考，不要拿它当「赚钱效应」的输入 */
  avg_rate: number | null;
  /** 共振板块（≥60%）占全部板块的比例 0~1 —— 真正反映「有几条线在赚钱」 */
  resonance_share: number | null;
}

/**
 * 行业对比端点 → 各板块共振率 + 全市场聚合。
 *
 * 🔴 共振率是**算出来的**（上涨家数 / 总家数），不是端点直接给的某个字段。
 *    早先 market_state 侧图省事，把 evidence 的 `value` 当成共振率 —— 那是板块涨跌幅，
 *    于是那一路的共振腿永远是 0，和概况页对不上。
 */
export function parseResonance(x: unknown): ResonanceParse {
  const env = envelopeOf(x);
  if (!env) return { rows: [], avg_rate: null, resonance_share: null };
  const rows: ResonanceRow[] = [];
  for (const [rk, row] of groupByKey(env)) {
    const note = row.note ?? "";
    const name = note.split("排名")[0]?.trim() || rk;
    const pct = num(row.fields.get("industry_board_change_pct")?.value);
    const upCount = num(row.fields.get("industry_board_up_count")?.value) ?? 0;
    const downCount = num(row.fields.get("industry_board_down_count")?.value) ?? 0;
    if (pct === null) continue;
    const total = upCount + downCount;
    const resonanceRate = total > 0 ? (upCount / total) * 100 : null;
    let signal: ResonanceRow["signal"] = "一般";
    if (resonanceRate !== null) {
      if (resonanceRate >= 60) signal = "共振";
      else if (resonanceRate >= 45) signal = "强动";
    }
    rows.push({
      name,
      change_pct: pct,
      up_count: upCount,
      down_count: downCount,
      total: total > 0 ? total : null,
      resonance_rate: resonanceRate,
      rank: num(row.fields.get("industry_board_rank")?.value),
      signal,
    });
  }
  // 🔴 聚合必须在排序 / 截断之前算 —— 顺序反了就是「用 Top10 算全市场」
  const rated = rows.filter((r) => r.resonance_rate !== null);
  const avg_rate = rated.length ? rated.reduce((a, c) => a + (c.resonance_rate ?? 0), 0) / rated.length : null;
  const resonance_share = rated.length
    ? rated.filter((r) => (r.resonance_rate ?? 0) >= 60).length / rated.length
    : null;
  rows.sort((a, b) => (b.resonance_rate ?? -Infinity) - (a.resonance_rate ?? -Infinity));
  return { rows, avg_rate, resonance_share };
}

/**
 * 板块资金流 → 每个板块的净流入（元），供 `inflowRate` 使用。
 *
 * 🔴 必须按 `field` 过滤。`sina_board_flow` 一个板块出 **5 条证据**
 *    （board_net / board_inflow / board_outflow / board_change_pct / board_net_ratio），
 *    不筛字段就会把「流入」（恒为正）和「涨跌幅」「净占比」都当成净流入混进来 ——
 *    48 个板块会算成 240 个「板块」，占比既不等于板块级占比、也没有任何含义。
 *    实测 2026-10-30：正确口径 26/48 = 54.2%，不筛字段 157/240 = 65.4%。
 *
 * 🔴 这里刻意不截断、也不排序：评分只看「净流入的板块占全部板块的比例」。
 *    展示层要 Top12 是展示层的事（`overview.extractBoardFlow`），不能拿那份去评分。
 */
export function boardFlowNetRows(x: unknown, field = "board_net_sina"): { net_yi: number; net_yuan: number }[] {
  const env = envelopeOf(x);
  if (!env) return [];
  const ev = Array.isArray(env.evidence) ? (env.evidence as EvRec[]) : [];
  const rows: { net_yi: number; net_yuan: number }[] = [];
  for (const e of ev) {
    if (e.field !== field) continue;
    const v = num(e.value);
    if (v !== null) rows.push({ net_yi: v / 1e8, net_yuan: v });
  }
  return rows;
}
