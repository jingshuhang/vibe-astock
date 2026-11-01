/**
 * 通达信盘后包**二进制解析** —— 不依赖 Python mapper 的 `extracted_*.json`。
 *
 * 为什么要自己解：
 *   `tdx_daily_package` 的 mapper 只从全市场表里**挑出请求的 codes** 写进 extracted json，
 *   而全市场 4~5 万行的原表只在 `raw/*.zip` 里。要算「历史宽度」就得拿全表，
 *   所以这里直接读 zip 原文，只取「昨收 / 收盘」两个数。
 *
 * 格式（权威来源：`.agents/skills/data-access/scripts/sources/astock_ported.py`
 * 的 `_tdx_parse_package`，注释写明「已用 600519/000001/920000 与腾讯收盘价对拍」）：
 *   - `<market><YYMMDD>.cod` —— 代码表，**150 字节/条**；前 6 字节 ASCII 代码，
 *     偏移 32 起 2 字节 = 行情块序号 seq，偏移 40 起 32 字节 = GBK 简称
 *   - `<market><YYMMDD>.md1` —— 行情块，**512 字节/块**，按 .cod 里的 seq 定位：
 *     偏移 4 起 double = 昨收，偏移 12/20/28/36 = 开/高/低/收，偏移 72 = 成交额
 *   🔴 价格是 **double**，不是 32 位定点 —— 按 uint32 读会得到一堆 f32 乱码。
 *     （踩过：先按 32 字节/条的老式 .day 格式试，怎么都对不上。）
 *
 * ⚠️ 两个必须知道的事：
 *   ① 一份包覆盖**全市场所有证券**（股票 / 基金 / 债券 / 指数…），不是只有股票，
 *      5.2 万行里绝大多数不是股票。所以下游必须按代码白名单筛。
 *   ② `close <= 0` 的块是当日无价的（880/881 自编指数、停牌），直接跳过。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../service.ts";

const COD_RECORD = 150;
const MD1_BLOCK = 512;

/** 单个市场「有价记录」下限（与 Python 侧 TDX_MIN_PRICED 同口径，防半截文件被当成全市场） */
const MIN_PRICED: Record<string, number> = { sh: 1000, sz: 1000, bj: 100 };

/**
 * 解 zip 中央目录。只用 Node 自带 `zlib`，**不引第三方包**。
 *
 * 只支持 store(0) / deflate(8) 两种压缩方式 —— 通达信盘后包用的是这两种，
 * 遇到别的直接抛错，不猜。
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // EOCD 在文件末尾，注释最长 64KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip：找不到中央目录结尾");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`zip 中央目录第 ${k} 条签名不对，文件可能被截断`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip 条目 ${name} 的本地头签名不对`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
    else throw new Error(`zip 条目 ${name} 用了不支持的压缩方式 ${method}`);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 代码 → 带市场前缀的键（`sh600519`），与 `tx_quotes_batch` 的写法一致 */
function keyOf(market: string, code: string): string {
  return `${market}${code}`;
}

export interface PackageDay {
  /** `YYYY-MM-DD` */
  date: string;
  /** key = `sh600519` → 涨跌幅（%），保留 3 位小数 */
  chg: Map<string, number>;
  /** 有价记录总数（全市场，含基金/债券） */
  priced: number;
}

/**
 * 解一份盘后包 → `{ 键: 涨跌幅% }`。
 *
 * 只保留 `close > 0 && prev_close > 0` 的记录；涨跌幅在这里就算好（3 位小数），
 * 因为下游只需要这一个数，多存原始价只是把缓存文件撑大。
 */
export function parsePackageZip(buf: Buffer, date: string): PackageDay {
  const entries = readZipEntries(buf);
  const names = [...entries.keys()];
  const ymd = date.replace(/-/g, "").slice(2);
  const chg = new Map<string, number>();
  let priced = 0;

  for (const market of ["sh", "sz", "bj"]) {
    const codName = names.find((n) => n === `${market}${ymd}.cod`);
    const md1Name = names.find((n) => n === `${market}${ymd}.md1`);
    if (!codName || !md1Name) {
      // 北交所在 2022-05 之前的包里没有，不是错误；沪深缺就是格式变了
      if (market === "bj") continue;
      throw new Error(`盘后包缺 ${market}${ymd}.cod/md1，格式可能已变`);
    }
    const cod = entries.get(codName)!;
    const md1 = entries.get(md1Name)!;
    if (cod.length % COD_RECORD || md1.length % MD1_BLOCK) {
      throw new Error(`${market} 代码表或行情块长度不是整块，文件可能被截断`);
    }
    let marketPriced = 0;
    for (let o = 0; o < cod.length; o += COD_RECORD) {
      const code = cod.toString("ascii", o, o + 6).replace(/\0/g, "").trim();
      if (!/^\d{6}$/.test(code)) continue;
      const seq = cod.readUInt16LE(o + 32);
      const base = seq * MD1_BLOCK;
      if (base + MD1_BLOCK > md1.length) continue;
      const prevClose = md1.readDoubleLE(base + 4);
      const close = md1.readDoubleLE(base + 36);
      if (!Number.isFinite(prevClose) || !Number.isFinite(close)) continue;
      if (close <= 0 || prevClose <= 0) continue;
      priced++;
      marketPriced++;
      chg.set(keyOf(market, code), Math.round((close / prevClose - 1) * 100_000) / 1000);
    }
    if (marketPriced < (MIN_PRICED[market] ?? 0)) {
      throw new Error(`${market} 只有 ${marketPriced} 条有价记录（下限 ${MIN_PRICED[market]}），文件可能残缺`);
    }
  }
  return { date, chg, priced };
}

// ─── 落地缓存 ───────────────────────────────────────────────────────────────────

/**
 * 缓存放 `repoRoot/.local/cache/tdx_daily/<YYYYMMDD>.json`。
 *
 * 🔴 为什么不放 `ctx.dataRoot`：那是**按会话**切的（`.local/mcp/<chat-id>`），
 *    换一个会话缓存就没了，等于每次都要重新下载 2.7MB×5。
 *    历史包的内容**永不改变**，所以这份缓存是真正的「一次下载、永久复用」。
 */
export function cacheDirOf(ctx: ServiceContext): string {
  return path.join(ctx.repoRoot, ".local", "cache", "tdx_daily");
}

function readCache(ctx: ServiceContext, date: string): PackageDay | null {
  try {
    const f = path.join(cacheDirOf(ctx), `${date.replace(/-/g, "")}.json`);
    if (!fs.existsSync(f)) return null;
    const doc = JSON.parse(fs.readFileSync(f, "utf8")) as { date?: string; priced?: number; chg?: Record<string, number> };
    if (!doc.chg || typeof doc.chg !== "object") return null;
    const chg = new Map(Object.entries(doc.chg));
    return { date: doc.date ?? date, chg, priced: typeof doc.priced === "number" ? doc.priced : chg.size };
  } catch {
    return null;   // 缓存坏了当没有，重下即可，不抛
  }
}

function writeCache(ctx: ServiceContext, day: PackageDay): void {
  try {
    const dir = cacheDirOf(ctx);
    fs.mkdirSync(dir, { recursive: true });
    const doc = { date: day.date, priced: day.priced, chg: Object.fromEntries(day.chg) };
    fs.writeFileSync(path.join(dir, `${day.date.replace(/-/g, "")}.json`), JSON.stringify(doc));
  } catch {
    // 写不进去只影响下次速度，不影响本次正确性
  }
}

/** 从 dataRoot 里找这次取数落下的 raw zip */
function zipPathOf(ctx: ServiceContext, r: FetchResult): string | null {
  const extra = (r.envelope as { extra?: Record<string, unknown> } | null)?.extra;
  const files = Array.isArray(extra?.raw_files) ? (extra!.raw_files as string[]) : [];
  const zip = files.find((f) => f.endsWith(".zip"));
  if (!zip) return null;
  const full = path.join(ctx.dataRoot, r.out_dir, zip);
  return fs.existsSync(full) ? full : null;
}

/**
 * 取某个交易日的全市场涨跌幅。
 *
 * 顺序：磁盘缓存 → `fetchEndpoint`（mapper 管下载 + 快照缓存）→ 读 raw zip 自己解。
 * 返回 null = 这天拿不到（非交易日 / 官网还没发布 / 网络失败），**不伪造空表**。
 */
export async function packageDayOf(
  ctx: ServiceContext,
  date: string,
  signal: AbortSignal,
  opts: { timeoutMs?: number } = {},
): Promise<PackageDay | null> {
  const hit = readCache(ctx, date);
  if (hit) return hit;
  if (signal.aborted) return null;
  try {
    const r = await fetchEndpoint(ctx, {
      endpoint: "tdx_daily_package",
      args: { date },
      signal,
      timeout_ms: opts.timeoutMs ?? 90_000,
    });
    const status = (r.envelope as { status?: string } | null)?.status;
    if (status === "failed") return null;
    const zip = zipPathOf(ctx, r);
    if (!zip) return null;
    const day = parsePackageZip(fs.readFileSync(zip), date);
    if (!day.chg.size) return null;
    writeCache(ctx, day);
    return day;
  } catch {
    return null;
  }
}

/**
 * 回溯最近 N 个交易日的全市场涨跌幅表。
 *
 * 🔴 **这是回溯，不是「攒」。** `tdx_daily_package` 带 date 参数，官网从 2022 年起都留着，
 *    第一天就能把 N 天全算出来；缓存只是让第二天的成本降到「新增 1 天」。
 *
 * 周六周日直接跳过；法定假日 / 未发布会 404 → 落空，按 `days` 实际拿到几天算，
 * **不拿上一交易日的数顶替**（那会做出假的「昨天」）。
 */
export async function packageHistory(
  ctx: ServiceContext,
  days: number,
  signal: AbortSignal,
  opts: { concurrency?: number; now?: Date } = {},
): Promise<PackageDay[]> {
  const now = opts.now ?? new Date();
  const candidates: string[] = [];
  for (let i = 1; i <= days * 3 + 10 && candidates.length < days + 6; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    candidates.push(ymdOf(d));
  }
  // 先按日期从近到远试，拿到够 days 天就停
  const got: PackageDay[] = [];
  let cursor = 0;
  const conc = Math.max(1, Math.min(opts.concurrency ?? 3, candidates.length));
  await Promise.all(Array.from({ length: conc }, async () => {
    while (cursor < candidates.length) {
      if (signal.aborted || got.length >= days) return;
      const date = candidates[cursor++];
      const day = await packageDayOf(ctx, date, signal);
      if (day) got.push(day);
    }
  }));
  return got.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-days);
}

/** 本地日期串。不用 toISOString —— 那是 UTC，东八区会差一天 */
export function ymdOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ─── 全市场宽度 ─────────────────────────────────────────────────────────────────

/**
 * A 股代码前缀白名单。
 *
 * 🔴 **必须只算股票**。一份包里 5.2 万行，绝大多数是基金 / 债券 / 指数，
 *    它们大量平盘（close == prev_close），把上涨占比硬锚在 50% 附近 ——
 *    混进去算出来的「全市场上涨占比」永远在 45%~55%，看不出任何东西。
 *    实测剃干净后 8 个交易日区间是 9.6%~81.2%（极差 71.6pp），才是真信号。
 */
const SH_PREFIX = ["600", "601", "603", "605", "688", "689"];
const SZ_PREFIX = ["000", "001", "002", "003", "300", "301"];
const BJ_PREFIX = ["43", "83", "87", "88", "92"];

/** 键形如 `sh600519` → 是不是 A 股股票 */
export function isAStock(key: string): boolean {
  const market = key.slice(0, 2);
  const code = key.slice(2);
  if (!/^\d{6}$/.test(code)) return false;
  if (market === "sh") return SH_PREFIX.includes(code.slice(0, 3));
  if (market === "sz") return SZ_PREFIX.includes(code.slice(0, 3));
  if (market === "bj") return BJ_PREFIX.includes(code.slice(0, 2));
  return false;
}

export interface MarketBreadth {
  /** 上涨只数 ÷ 有价 A 股只数 */
  up_rate: number;
  /** 全市场中位涨跌幅（%） */
  median: number;
  /** 参与计算的 A 股只数 */
  n: number;
}

/**
 * 一份盘后包 → 全市场（仅 A 股）的上涨占比与中位涨幅。
 *
 * 这是「板块宽度」的基准：全市场 81% 上涨的那天，十个板块里九个半的上涨占比都在 60% 以上，
 * 那是大盘普涨，不是十个板块同时启动。不减这个基准，绝对宽度基本是在重复说「今天大盘涨还是跌」。
 */
export function marketBreadthOf(pkg: PackageDay): MarketBreadth | null {
  const rets: number[] = [];
  for (const [k, v] of pkg.chg) {
    if (isAStock(k)) rets.push(v);
  }
  if (!rets.length) return null;
  const s = [...rets].sort((a, b) => a - b);
  const m = s.length >> 1;
  const median = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return {
    up_rate: Math.round((rets.filter((x) => x > 0).length / rets.length) * 10_000) / 10_000,
    median: Math.round(median * 100) / 100,
    n: rets.length,
  };
}
