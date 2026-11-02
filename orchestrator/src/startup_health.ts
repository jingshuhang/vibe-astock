/** Check the UI and its authenticated API proxy without exposing the bearer token. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { API_PORT, UI_PORT } from "./brand.ts";
import { readConfiguredDataRoot, resolveDataRoot } from "./data_root.ts";

export async function productUiReady(baseUrl = `http://127.0.0.1:${UI_PORT}`, timeoutMs = 1_000): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const [ui, api] = await Promise.all([
      fetch(`${baseUrl}/`, { signal }), fetch(`${baseUrl}/api/health`, { signal }),
    ]);
    if (!ui.ok || !api.ok || !ui.headers.get("content-type")?.includes("text/html")) return false;
    const [html, health] = await Promise.all([ui.text(), api.json()]);
    return /<div\b[^>]*\bid=["']root["']/.test(html) && health?.ok === true &&
      typeof health.version === "string" && health.version.length > 0;
  } catch {
    return false;
  }
}

/**
 * 只验后端(没有界面可走代理时用,比如 `start.ps1 -Headless`)。
 *
 * `/health` 和其它路由一样要鉴权(见 api.ts:未带正确 Bearer 一律 401),所以这里必须真带着令牌去问 ——
 * **不能用「连得上端口」当就绪**:那样连的是一个还没加载完产品的半成品进程。
 * 令牌只在本机读、只发给 127.0.0.1,不上屏也不进命令行参数。
 */
export async function productApiReady(baseUrl = `http://127.0.0.1:${API_PORT}`, token = "", timeoutMs = 1_000): Promise<boolean> {
  if (!token) return false;
  try {
    const r = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return false;
    const health = await r.json();
    return health?.ok === true && typeof health.version === "string" && health.version.length > 0;
  } catch {
    return false;
  }
}

/** 令牌:环境变量优先,否则读 <数据根>/api.token(与 api.ts 的写入位置同一个口径) */
export function readApiToken(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.VRA_API_TOKEN) return env.VRA_API_TOKEN.trim();
  try {
    const dataRoot = resolveDataRoot(repoRoot, readConfiguredDataRoot(repoRoot), env);
    return fs.readFileSync(path.join(dataRoot, "api.token"), "utf8").trim();
  } catch {
    return "";
  }
}

// Windows 启动器用:页面端口由它选好后经 VRA_UI_PORT 传进来(默认 UI_PORT)。
// 按真实路径比:仓库在符号链接 / 目录联接 / subst 盘符下时两边写法不同,比不上就什么都不做、退出码 0,启动器会误以为已就绪
const realPath = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (process.argv.includes("--api")) {
    const port = /^\d{1,5}$/.test(process.env.VRA_API_PORT ?? "") ? process.env.VRA_API_PORT : String(API_PORT);
    const token = readApiToken(repoRoot);
    if (!token) console.error("[startup] 读不到 API 令牌(环境变量 VRA_API_TOKEN 或 <数据根>/api.token),无法验证后端是否就绪");
    process.exitCode = await productApiReady(`http://127.0.0.1:${port}`, token) ? 0 : 2;
  } else {
    const port = /^\d{1,5}$/.test(process.env.VRA_UI_PORT ?? "") ? process.env.VRA_UI_PORT : String(UI_PORT);
    process.exitCode = await productUiReady(`http://127.0.0.1:${port}`) ? 0 : 2;
  }
}
