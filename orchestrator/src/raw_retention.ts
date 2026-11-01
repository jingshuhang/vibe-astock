/**
 * 原始响应的保留期(MCP 缓存目录 `.local/mcp/<session>/raw/`)。
 *
 * 🔴 只清**取数缓存**这一处,不碰 `.local/runs/<run>/raw/` —— 那是研究运行的证据,
 *    报告的 `raw_ref` 指向它、复算要靠它。删掉等于把已交付的结论变成不可复核。
 *    两者的区别不是"新/旧",而是"缓存 vs 证据"。
 *
 * 为什么需要:盯盘页每 2.5~3 秒轮询一次、端点的 `cache_max_age_sec` 只有 15 秒,
 * 于是报价类端点每几秒就落一份完整原始响应。实测单日 11,723 个文件(约 100MB+),
 * 而此前**没有任何回收机制**,只增不减。
 *
 * 保留期默认 30 天,可用 `VRA_RAW_RETENTION_DAYS` 覆盖(0 = 不清理)。
 */
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 3600 * 1000;
/** 同一目录两次清理的最短间隔:每 3 秒轮询一次也只在整点附近扫一遍目录 */
const DEFAULT_MIN_INTERVAL_MS = 3600 * 1000;

export const DEFAULT_RAW_RETENTION_DAYS = 30;

/** 保留天数;`0` 表示不清理。非法值(负数 / 非数字)按默认处理,不静默变成"全删" */
export function rawRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VRA_RAW_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RAW_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RAW_RETENTION_DAYS;
  return Math.floor(n);
}

export interface RawPruneResult {
  dir: string;
  /** 目录里看到的条目数(含跳过的) */
  scanned: number;
  removed: number;
  bytes: number;
  /** 超过保留期但删不掉的(被占用 / 权限),如实计数,不假装清干净了 */
  failed: number;
}

const lastRunAt = new Map<string, number>();

/** 只清模块状态,给测试用 */
export function resetRawPruneThrottle(): void {
  lastRunAt.clear();
}

/**
 * 按保留期清理一个 raw 目录。返回 null 表示"这次跳过"(没到间隔 / 保留期为 0 / 目录不存在)。
 *
 * 🔴 安全约束(逐条都有理由,不要顺手放宽):
 * - 只删**普通文件**:`lstat` 判 `isFile()`,符号链接一律跳过 —— 跟随链接会删到目录之外;
 * - 只按 `mtime` 判断:文件名里的时间戳格式各来源不统一,解析失败就等于永远不用清;
 * - 单个文件删不掉只计数:一个被占用的文件不该让整轮清理失败,更不该让取数报错;
 * - 目录不存在直接返回:首次运行还没建目录是正常状态。
 */
export function pruneRawResponses(
  rawDir: string,
  opts: { now?: number; force?: boolean; retentionDays?: number; minIntervalMs?: number; env?: NodeJS.ProcessEnv } = {},
): RawPruneResult | null {
  const now = opts.now ?? Date.now();
  const days = opts.retentionDays ?? rawRetentionDays(opts.env ?? process.env);
  if (days <= 0) return null;
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const last = lastRunAt.get(rawDir) ?? 0;
  if (!opts.force && now - last < minInterval) return null;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(rawDir, { withFileTypes: true }); }
  catch { return null; }               // 目录还不存在:EACCES/ENOENT 都不该让取数挂掉
  lastRunAt.set(rawDir, now);

  const cutoff = now - days * DAY_MS;
  const out: RawPruneResult = { dir: rawDir, scanned: entries.length, removed: 0, bytes: 0, failed: 0 };
  for (const e of entries) {
    if (!e.isFile() && !e.isSymbolicLink()) continue;   // 子目录不碰
    if (e.isSymbolicLink()) continue;                    // 链接不碰(不跟随、也不删)
    const file = path.join(rawDir, e.name);
    let size = 0;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) continue;
      if (st.mtimeMs >= cutoff) continue;
      size = st.size;
    } catch { out.failed += 1; continue; }
    try { fs.rmSync(file, { force: true }); out.removed += 1; out.bytes += size; }
    catch { out.failed += 1; }
  }
  return out;
}
