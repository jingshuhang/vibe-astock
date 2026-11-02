/** Check the UI and its authenticated API proxy without exposing the bearer token. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { API_PORT, UI_PORT } from "./brand.ts";
import { readConfiguredDataRoot, resolveDataRoot } from "./data_root.ts";

/**
 * 页面就绪 = 首页 HTML 有挂载点、代理能连上后端、**而且入口模块真能编译出来**。
 *
 * 🔴 最后那一条是 2026-11-02 补的。此前只验 HTML:Vite 对 `/` 是**瞬时**返回的
 * (index.html 直接从磁盘读),那一刻一个模块都还没编译 —— 启动器据此判定「就绪」并打开浏览器,
 * 于是用户看到的是白屏,要等整张模块图编译完才有内容(实测冷 4748ms / 热 542ms)。
 * 现在只有等入口模块真返回 JS,才把浏览器交出去 —— 白屏那段变成「正在启动」的等待。
 *
 * 开发服务器与打包页用**同一段判断**,不必额外传参:看 index.html 自己是引用 `/src/*` 还是 `/assets/*`。
 * 打包页没有 `/src/main.tsx` 这个东西,硬去探它会让 `-Prebuilt` 永远等不到就绪。
 */
export async function productUiReady(baseUrl = `http://127.0.0.1:${UI_PORT}`, timeoutMs = 1_000): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const [ui, api] = await Promise.all([
      fetch(`${baseUrl}/`, { signal }), fetch(`${baseUrl}/api/health`, { signal }),
    ]);
    if (!ui.ok || !api.ok || !ui.headers.get("content-type")?.includes("text/html")) return false;
    const [html, health] = await Promise.all([ui.text(), api.json()]);
    const ok = /<div\b[^>]*\bid=["']root["']/.test(html) && health?.ok === true &&
      typeof health.version === "string" && health.version.length > 0;
    if (!ok) return false;
    const entry = entryModuleOf(html);
    if (!entry) return true; // 打包页:入口是静态产物,页面 200 就已经是最终状态
    return await entryCompiles(`${baseUrl}${entry}`);
  } catch {
    return false;
  }
}

/** 从 index.html 里认出开发服务器的入口模块;打包页(`/assets/*.js`)返回 null */
export function entryModuleOf(html: string): string | null {
  const m = /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i.exec(html) ??
    /<script[^>]+src=["']([^"']+)["'][^>]*>/i.exec(html);
  const src = m?.[1] ?? "";
  return /^\/src\/.+/.test(src) ? src : null;
}

/** 入口模块能不能真的编译出来。超时给得比别处长 —— 冷启动时 Vite 要现场转译整条依赖链 */
async function entryCompiles(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return false;
    // 必须是 JS 模块;Vite 报错时返回的是 HTML 错误页,那不算就绪
    if (!(r.headers.get("content-type") ?? "").includes("javascript")) return false;
    await r.text();
    return true;
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
