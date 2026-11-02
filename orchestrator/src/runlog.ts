/**
 * 运行日志:把控制台上的东西**同时**留一份到 `.local/logs/`。
 *
 * 为什么需要:2026-11-02 那天后端在 14:01 之后凭空消失,盘上没有任何痕迹 ——
 * 分不清是「窗口被关掉」还是「进程自己挂了」。盘上证据只到 14:01:04,
 * 之后到 17:50 重启之间一个字都没有,15:00 那一拍因此永久缺失。
 * 日志只打在 start.cmd 的控制台窗口里,窗口一关就没了 —— 等于**没有日志**。
 *
 * 三条纪律:
 *   1. **不改变原有输出**:控制台上照旧打印,这里只是多写一份(不是重定向)。
 *   2. **写日志绝不能反过来搞坏主流程**:磁盘满、权限、路径被占用,一律吞掉。
 *   3. **崩溃必须留最后一行**:未捕获异常 / 未处理的 Promise 拒绝 / 各种退出方式,
 *      都要先把原因落到盘上再退出,否则又是一次「什么都没留下」。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_KEEP_DAYS = 14;

/** 日志文件名按**本地日期**切(和调度器、快照同一套口径,不按 UTC 免得跨零点错位) */
export function logFileName(day: string): string {
  return `api-${day}.log`;
}

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 一行日志:本地时间 + 级别 + 正文。多行(栈)原样接在后面,不逐行加前缀免得栈读散 */
export function formatLine(level: string, args: unknown[], now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const at = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  const text = args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : safeJson(a)))
    .join(" ");
  return `${at} [${level}] ${text}\n`;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

export interface PruneResult { removed: string[]; kept: number }

/** 删掉超过保留天数的日志文件。只认本模块生成的名字(`api-YYYY-MM-DD.log`),别的文件不碰 */
export function pruneLogs(dir: string, keepDays: number, now: Date): PruneResult {
  const removed: string[] = [];
  let kept = 0;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return { removed, kept }; }
  const cutoff = now.getTime() - Math.max(0, keepDays) * 86_400_000;
  for (const name of names) {
    const m = /^api-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (!m) continue;
    const day = Date.parse(`${m[1]}T00:00:00`);
    if (!Number.isFinite(day)) continue;
    if (day < cutoff) {
      try { fs.rmSync(path.join(dir, name), { force: true }); removed.push(name); } catch { /* 删不掉就算了 */ }
    } else kept++;
  }
  return { removed, kept };
}

export interface RunLogHandle { dir: string; /** 当前正在写的文件(跨零点会自动换) */ file: () => string; restore: () => void }

export interface Heartbeat { at: string; pid: number; day: string; hm: string }

/**
 * 心跳:每拍钩子跑完就写一次,证明「调度器这一刻是活的」。
 *
 * 它回答的是一个光看日志答不出的问题:某个时点没采到时,到底是
 * **进程已经不在了**,还是**进程活着但那一拍自己没成**。心跳停在 14:01 而快照缺 15:00
 * ⇒ 进程没了;心跳一直在 15:00 之后而快照仍缺 ⇒ 活着但拍没成(该查取数)。
 */
export function writeHeartbeat(dataRoot: string, info: Heartbeat): void {
  try {
    const dir = path.join(dataRoot, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify(info, null, 1), "utf8");
  } catch { /* 心跳写不进去不能影响调度 */ }
}

export function readHeartbeat(dataRoot: string): Heartbeat | null {
  try {
    const raw = fs.readFileSync(path.join(dataRoot, "logs", "heartbeat.json"), "utf8");
    const o = JSON.parse(raw) as Heartbeat;
    return typeof o?.at === "string" ? o : null;
  } catch {
    return null;
  }
}

/**
 * 装上日志镜像。**只该在真正的入口(main)里调**,不要在模块加载时执行 ——
 * 测试会 import api.ts,那样会把测试输出也写进用户的数据目录。
 */
export function installRunLog(dataRoot: string, opts: { keepDays?: number; now?: () => Date } = {}): RunLogHandle {
  const now = opts.now ?? (() => new Date());
  const keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS;
  const dir = path.join(dataRoot, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录建不出来就退化成不写 */ }

  let currentDay = "";
  let file = "";
  const target = (): string => {
    const day = localDay(now());
    if (day !== currentDay) {
      currentDay = day;
      file = path.join(dir, logFileName(day));
      // 一天一次顺手清旧的,不另设清理任务
      pruneLogs(dir, keepDays, now());
    }
    return file;
  };

  const write = (level: string, args: unknown[]): void => {
    try { fs.appendFileSync(target(), formatLine(level, args, now())); } catch { /* 写不进去不能影响主流程 */ }
  };

  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { orig.log(...a); write("info", a); };
  console.warn = (...a: unknown[]) => { orig.warn(...a); write("warn", a); };
  console.error = (...a: unknown[]) => { orig.error(...a); write("error", a); };

  const restore = () => {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    // 监听器也要摘掉:否则测试里装一次就永久挂在这个进程上,还会在别人崩的时候抢着 exit
    process.removeListener("uncaughtException", fatalUncaught);
    process.removeListener("unhandledRejection", fatalReject);
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };

  // 崩溃:先把原因落盘,再按 Node 的默认行为退出(加了监听器就不会自动退了,得自己退)
  const onFatal = (kind: string) => (e: unknown) => {
    write("fatal", [`${kind}:`, e instanceof Error ? e : String(e)]);
    try { orig.error(`[api] ${kind}:`, e); } catch { /* 控制台也没了 */ }
    process.exit(1);
  };
  const fatalUncaught = onFatal("未捕获异常");
  const fatalReject = onFatal("未处理的 Promise 拒绝");
  process.on("uncaughtException", fatalUncaught);
  process.on("unhandledRejection", fatalReject);

  // 正常/被要求退出:留一行「谁让我退的」,这是分辨「关窗口」与「自己挂」的关键
  const onExit = (code: number) => { write("exit", [`进程退出 code=${code}`]); };
  process.on("exit", onExit);
  // 不在这里 process.exit:让 main 的收尾(关服务器、解锁)照常走,exit 事件会再补一行
  const onSigint = () => { write("exit", ["收到 SIGINT,准备退出"]); process.exitCode = 0; };
  const onSigterm = () => { write("exit", ["收到 SIGTERM,准备退出"]); process.exitCode = 0; };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  target();
  return { dir, file: () => target(), restore };
}
