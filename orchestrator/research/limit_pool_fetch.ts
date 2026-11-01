/**
 * 拉取「涨停位置特征 → 次日表现」的回溯样本。
 *
 * 产出 `.local/cache/limit_pool/samples.json`（gitignored），供 `research/position_factor.py` 分析。
 *
 * 两个源按 code 对齐：
 *   cn_shortline_board_ladder(D)  当日涨停股的**位置特征**：首封/末封时间、开板次数、封单额、流通市值、换手、制度
 *   cn_shortline_settled(D)       前一日涨停股在**当日**的实际表现：ret / 是否再涨停 / 前一日板数 / 末封时间
 *
 * 🔴 对齐方式：settled(D) 的每一行讲的是「昨天涨停、今天怎么样」，所以它的特征要在 ladder(D 的前一交易日) 里找。
 *    脚本只负责把两边都拉下来，join 交给分析脚本（日期映射在那儿显式做，避免这里藏一步隐式假设）。
 *
 * 🔴 东财只保留约一个月，所以 N 不宜超过 ~20 个交易日；非交易日 / 未收盘日会返回 partial，直接跳过。
 *
 * 用法：node research/limit_pool_fetch.ts [天数]
 */
import fs from "node:fs";
import path from "node:path";
import { serviceContext, fetchEndpoint } from "../src/service.ts";

const DAYS = Number(process.argv[2] ?? 24);
const ctx = serviceContext();
const sig = new AbortController().signal;
const OUT_DIR = path.join(ctx.repoRoot, ".local", "cache", "limit_pool");
const OUT = path.join(OUT_DIR, "samples.json");

function weekdays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i <= n * 2 && out.length < n; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    const p = (x: number) => String(x).padStart(2, "0");
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  return out;
}

const dates = weekdays(DAYS);
console.log("候选日期", dates.length, dates[0], "~", dates[dates.length - 1]);

const ladders: Record<string, unknown[]> = {};
const settleds: Record<string, unknown[]> = {};

let cursor = 0;
const CONC = 4;   // 涨停原因要多查一次，并发别太高，否则容易被限频
const work = async () => {
  while (cursor < dates.length) {
    const date = dates[cursor++];
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_board_ladder", args: { date }, signal: sig, timeout_ms: 90_000 });
      const extra = (r.envelope as Record<string, unknown>).extra as Record<string, unknown> | undefined;
      const ladder = (extra?.result as Record<string, unknown> | undefined)?.ladder as { levels?: { stocks?: unknown[] }[] } | undefined;
      const out: unknown[] = [];
      for (const lv of ladder?.levels ?? []) for (const s of lv.stocks ?? []) out.push(s);
      if (out.length) ladders[date] = out;
    } catch { /* 单日失败不影响整体 */ }
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "cn_shortline_settled", args: { date }, signal: sig, timeout_ms: 45_000 });
      const extra = (r.envelope as Record<string, unknown>).extra as Record<string, unknown> | undefined;
      const res = extra?.result as { partial?: boolean; rows?: unknown[] } | undefined;
      if (res && !res.partial && Array.isArray(res.rows) && res.rows.length) settleds[date] = res.rows;
    } catch { /* 同上 */ }
    process.stderr.write(`\r${date} 天梯 ${Object.keys(ladders).length} / 明细 ${Object.keys(settleds).length}   `);
  }
};
await Promise.all(Array.from({ length: CONC }, work));
process.stderr.write("\n");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ ladders, settleds }));
console.log("天梯", Object.keys(ladders).length, "天 /", Object.values(ladders).reduce((a, b) => a + b.length, 0), "只");
console.log("明细", Object.keys(settleds).length, "天 /", Object.values(settleds).reduce((a, b) => a + b.length, 0), "行");
console.log("→", OUT);
