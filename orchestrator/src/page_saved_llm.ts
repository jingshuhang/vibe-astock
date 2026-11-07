/**
 * 页面上保存的那份 AI 配置 —— 落一份到数据根，给**定时任务**用。
 *
 * 为什么需要这一层：页面上的模型配置存在浏览器 localStorage(`vr-llm`)，只随请求发出去；
 * 而 18:55 日复盘 / 19:02 情绪复盘 / 周五 19:10 AI 周报 跑的时候没有浏览器，
 * 它们读到的是 `<数据根>/config.json` 的 `provider.profile` + 一个环境变量里的 key ——
 * 跟用户在「接入 AI」里选的那一份**可以是两家**，而界面上一个字都看不出来。
 * 2026-11-05 实测就是这件事：侧栏写着「已接入AI」，三个任务却因为 config.json 里的模型名
 * 不是服务商认的名字，全部 404、当天的复盘一篇都没写出来。
 *
 * 所以：页面「测试并保存」成功之后，前端把同一份配置 POST 过来，这里落盘；
 * `defaultLlm()` 优先用它。**它不是第二份独立配置** —— 页面上清除，这里跟着删（`clearSavedLlm`）。
 *
 * 🔴 这份文件里有 API key，所以：
 *   - 权限收到只有本机当前用户（0600 / icacls），与 `api.token` 同一套；
 *   - **远程访问模式（VRA_REMOTE=1）拒绝写入**，由调用方拦（见 service.saveSavedLlm）；
 *   - 任何回给页面的状态都**不含 key**（只给 provider / model / 端点 / 保存时间）；
 *   - 日志、账本、产物一律不写它的内容。本文件是它**唯一**的写入点。
 */
import fs from "node:fs";
import path from "node:path";

import { atomicWrite, restrictPrivateFile } from "./fsutil.ts";

export const SAVED_LLM_FILE = "llm.json";

/** 与 `LlmOverride` 同形（这里不 import 那份类型：runtime_provider 反过来要 import 本文件） */
export interface SavedLlmSource {
  provider: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export interface SavedLlmRead {
  source: SavedLlmSource | null;
  savedAt: string | null;
  /**
   * 文件在、但读不懂 / 形状不对时的原话。
   * 🔴 与「没有这个文件」必须分开：前者是配置坏了（要报出来，**不许**悄悄换成 config.json 里那家去跑），
   *    后者只是用户还没保存过。
   */
  problem: string | null;
}

export function savedLlmFile(dataRoot: string): string {
  return path.join(dataRoot, SAVED_LLM_FILE);
}

/** 读。任何异常都翻译成 `problem`，不往外抛 —— 读配置这一步不该让进程崩。 */
export function readSavedLlm(dataRoot: string): SavedLlmRead {
  const file = savedLlmFile(dataRoot);
  let raw: string;
  try {
    const st = fs.lstatSync(file);
    // 数据区里被放了指向区外的符号链接时不读（与 api.token 同一条纪律）
    if (!st.isFile()) return { source: null, savedAt: null, problem: `${SAVED_LLM_FILE} 不是普通文件（符号链接或目录）` };
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { source: null, savedAt: null, problem: null };
    return { source: null, savedAt: null, problem: `读不了：${e instanceof Error ? e.message : String(e)}` };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return { source: null, savedAt: null, problem: `${SAVED_LLM_FILE} 不是合法 JSON（被手改过？）` };
  }
  // 两种形状都收：自己写的 {schemaVersion, savedAt, source}，以及 v2 之前前端存过的平铺对象
  const o = (parsed ?? {}) as Record<string, unknown>;
  const inner = o.schemaVersion !== undefined && o.source && typeof o.source === "object"
    ? o.source as Record<string, unknown>
    : o;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const provider = str(inner.provider)?.trim() ?? "";
  if (!provider) return { source: null, savedAt: null, problem: `${SAVED_LLM_FILE} 里没有 provider（这份配置用不了）` };
  const source: SavedLlmSource = { provider };
  const baseURL = str(inner.baseURL)?.trim(); if (baseURL) source.baseURL = baseURL;
  const apiKey = str(inner.apiKey)?.trim(); if (apiKey) source.apiKey = apiKey;
  const model = str(inner.model)?.trim(); if (model) source.model = model;
  return { source, savedAt: str(o.savedAt) ?? null, problem: null };
}

/**
 * 写。原子写 + 收权限。
 * 🔴 收不紧权限就把文件删掉再报错：一份别人可读的 key 文件，比"没保存成功"糟得多。
 */
export function writeSavedLlm(dataRoot: string, source: SavedLlmSource, now: Date = new Date()): { savedAt: string; file: string } {
  const file = savedLlmFile(dataRoot);
  const savedAt = beijingIso(now);
  const payload = {
    schemaVersion: 2,
    savedAt,
    source: {
      provider: source.provider.trim(),
      ...(source.baseURL ? { baseURL: source.baseURL.trim() } : {}),
      ...(source.apiKey ? { apiKey: source.apiKey.trim() } : {}),
      ...(source.model ? { model: source.model.trim() } : {}),
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(payload, null, 2) + "\n");
  try {
    restrictPrivateFile(file);
  } catch (e) {
    try { fs.unlinkSync(file); } catch { /* 删不掉也要报下面那句 */ }
    throw new Error(`配置写进去了但权限收不紧（${e instanceof Error ? e.message : String(e)}），已删除，避免密钥被别人读到`);
  }
  return { savedAt, file };
}

/** 删。返回是否真删掉了一份（本来就没有 = false）。 */
export function clearSavedLlm(dataRoot: string): boolean {
  const file = savedLlmFile(dataRoot);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`删不掉 ${SAVED_LLM_FILE}：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 回给页面的状态。**不含 key**，端点也去掉 userinfo / query / fragment（防着被当凭据留下来）。 */
export function savedLlmStatus(dataRoot: string): {
  saved: boolean; provider: string | null; model: string | null; base_url: string | null;
  saved_at: string | null; problem: string | null; file: string;
} {
  const r = readSavedLlm(dataRoot);
  const file = savedLlmFile(dataRoot);
  if (!r.source) {
    return { saved: false, provider: null, model: null, base_url: null, saved_at: null, problem: r.problem, file };
  }
  return {
    saved: true, provider: r.source.provider, model: r.source.model ?? null,
    base_url: maskUrl(r.source.baseURL ?? null), saved_at: r.savedAt, problem: null, file,
  };
}

function maskUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.username = ""; u.password = ""; u.search = ""; u.hash = "";
    return u.toString();
  } catch {
    return "（地址读不出来，已隐去）";
  }
}

/** 北京时间 ISO（`2026-11-05T19:40:00+08:00`），与台账里其它时间写法一致 */
function beijingIso(d: Date): string {
  const shifted = new Date(d.getTime() + 8 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}
