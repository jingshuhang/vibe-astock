/**
 * 本地数据维护:回收 `raw/` 里的原始报文。
 *
 * 为什么要管:截至 2026-11-02,`.local/mcp` 已经 **970MB / 32,072 个 raw 文件**,
 * 七天的增长是 1,075 → 2,649 → 4,590 → 6,934 → 12,387(10-30 那天最多)。
 * 按这个速度一个月就是几个 GB —— 磁盘写满之后取数会静默失败,那才是真的丢数据。
 *
 * 三条规矩:
 *   1. **还被引用的不删**。fetch/*.json 里的 `extra.raw_files` 与 `evidence[].raw_ref`
 *      指向的原始报文,是「这个数从哪来的」的凭据,删了整条证据链就断了。
 *   2. **窗口内的不删**。默认保留 **14 天**(`VRA_RAW_KEEP_DAYS` 可改),不因为「看着没用」提前删。
 *      为什么不是 30 天:按 2026-11-02 的实测,七天就攒了 970MB / 3.2 万个文件,
 *      30 天窗口意味着稳态要压 3GB 上下 —— 笔记本上这个代价偏大。14 天约 1.5GB。
 *      窗口只影响**原始报文**,解析后的 fetch/*.json 和 snapshots 不受影响,一直在。
 *   3. **只动 raw 目录**。路径必须落在 `mcp/<session>/raw/` 下,别的一律不碰。
 *
 * 不做自动删除的兜底:`dryRun` 只统计不删,先看数再决定。
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_RAW_KEEP_DAYS = 14;

export interface PruneRawResult {
  /** 扫过的 raw 文件数 */
  scanned: number;
  /** 认定还被引用的文件数(按文件名) */
  referenced: number;
  deleted: number;
  freedBytes: number;
  /** 在保留窗口内、不删 */
  keptRecent: number;
  /** 超出窗口但还被引用、不删 */
  keptReferenced: number;
  /** 删不掉的(被占用/权限),如实计数 */
  failed: number;
  /** 被删掉的最老文件属于哪天(看看窗口实际切在哪,别只看「删了多少」) */
  oldestDeleted: string | null;
  skipped?: string;
}

/** 从 fetch 结果里收出所有被引用的 raw 文件名。按**文件名**匹配(跨 session 宁可多留) */
export function collectRawRefs(mcpDir: string): Set<string> {
  const refs = new Set<string>();
  let sessions: string[];
  try { sessions = fs.readdirSync(mcpDir); } catch { return refs; }
  for (const session of sessions) {
    const fetchDir = path.join(mcpDir, session, "fetch");
    let files: string[];
    try { files = fs.readdirSync(fetchDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(fetchDir, f), "utf8"); } catch { continue; }
      for (const m of text.matchAll(/raw\/[^"\\\s]+/g)) refs.add(path.basename(m[0]));
    }
  }
  return refs;
}

export function pruneRawArchive(
  dataRoot: string,
  opts: { keepDays?: number; now?: Date; dryRun?: boolean } = {},
): PruneRawResult {
  const keepDays = opts.keepDays ?? DEFAULT_RAW_KEEP_DAYS;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const mcpDir = path.join(dataRoot, "mcp");
  const out: PruneRawResult = {
    scanned: 0, referenced: 0, deleted: 0, freedBytes: 0,
    keptRecent: 0, keptReferenced: 0, failed: 0, oldestDeleted: null,
  };
  if (!fs.existsSync(mcpDir)) return { ...out, skipped: "没有 mcp 目录" };

  const refs = collectRawRefs(mcpDir);
  out.referenced = refs.size;
  const cutoff = now.getTime() - Math.max(0, keepDays) * 86_400_000;
  let sessions: string[];
  try { sessions = fs.readdirSync(mcpDir); } catch { return { ...out, skipped: "读不到 mcp 目录" }; }

  for (const session of sessions) {
    const rawDir = path.join(mcpDir, session, "raw");
    let files: string[];
    try { files = fs.readdirSync(rawDir); } catch { continue; }
    for (const name of files) {
      const full = path.join(rawDir, name);
      // 只认「mcp/<session>/raw/<file>」这一层,别的一律不碰
      if (path.dirname(full) !== rawDir) continue;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      out.scanned++;
      if (st.mtimeMs >= cutoff) { out.keptRecent++; continue; }
      if (refs.has(name)) { out.keptReferenced++; continue; }
      const day = new Date(st.mtimeMs).toISOString().slice(0, 10);
      if (out.oldestDeleted === null || day < out.oldestDeleted) out.oldestDeleted = day;
      if (dryRun) { out.deleted++; out.freedBytes += st.size; continue; }
      try {
        fs.rmSync(full, { force: true });
        out.deleted++;
        out.freedBytes += st.size;
      } catch {
        out.failed++;
      }
    }
  }
  return out;
}

/** 每天最多跑一次(进程内记账;重启后允许再跑一次,反正是幂等的) */
let lastPruneDay = "";
export function pruneRawOncePerDay(dataRoot: string, now = new Date()): PruneRawResult | null {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (lastPruneDay === day) return null;
  lastPruneDay = day;
  const raw = process.env.VRA_RAW_KEEP_DAYS;
  const keepDays = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_RAW_KEEP_DAYS;
  try {
    return pruneRawArchive(dataRoot, { keepDays, now });
  } catch {
    return null; // 维护失败绝不能影响主流程
  }
}

/** 只给测试用:重置「今天跑过没」的记账 */
export function resetPruneMemo(): void { lastPruneDay = ""; }
