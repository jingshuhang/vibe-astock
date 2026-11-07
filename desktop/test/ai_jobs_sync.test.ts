import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/verticals/finance/lib/backend.ts";
import { clearLlmEverywhere, saveLlmEverywhere } from "../src/verticals/finance/lib/llm.ts";
import { LLM_KEY, readAiRuntime } from "../src/verticals/finance/lib/llmStore.ts";

/**
 * 「页面保存的那份配置」必须同时落到后端一份 —— 三个定时任务（18:55 复盘 / 19:02 情绪复盘 /
 * 周五 19:10 周报）跑的时候没有浏览器，只存 localStorage 的话它们读到的是 `config.json` 里另一家。
 * 2026-11-05 实测：界面写着「已接入AI」，三个任务全部 404，当天复盘一篇没写。
 *
 * 这里钉的是**两条路都真的走了**，以及失败时说的是实话（页面存了 / 后台没存下 ≠ 保存失败）。
 */

function storageFixture() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  return values;
}

const CFG = { provider: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "sk-page-1", model: "deepseek-v4" };

interface Sent { url: string; method: string; body: Record<string, unknown> | null }

function fetchFixture(reply: (sent: Sent) => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const old = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    try { body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null; } catch { body = null; }
    const item = { url, method, body };
    sent.push(item);
    const r = reply(item);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = old; } };
}

const OK_STATUS = { saved: true, provider: "deepseek", model: "deepseek-v4", base_url: "https://api.deepseek.com", saved_at: "2026-11-05T19:40:00+08:00", problem: null, file: "/d/llm.json", jobs_ai: { layer: "page", provider: "deepseek", model: "deepseek-v4" } };

test("保存在浏览器的那份同时 POST 给后端：定时任务因此和页面同一个大脑", async () => {
  const values = storageFixture();
  const { sent, restore } = fetchFixture(() => ({ status: 200, body: { ok: true, ...OK_STATUS } }));
  try {
    await saveLlmEverywhere(CFG);
    assert.deepEqual(JSON.parse(values.get(LLM_KEY) ?? "null"), { schemaVersion: 2, source: CFG }, "浏览器这份照旧要存");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, "/api/llm-saved");
    assert.equal(sent[0]!.method, "POST");
    assert.deepEqual(sent[0]!.body?.source, CFG, "发给后端的必须就是同一份，不许另拼一份");
  } finally { restore(); }
});

test("🔴 后端那份没存下：说「页面已保存、后台没存下」，不许冒充保存成功也不许说全失败", async () => {
  const values = storageFixture();
  const { restore } = fetchFixture(() => ({ status: 400, body: { error: "missing_key", message: "fixture-api 需要 API key" } }));
  try {
    await assert.rejects(saveLlmEverywhere(CFG), (e: unknown) => {
      assert.ok(e instanceof ApiError, `要抛 ApiError，实际是 ${String(e)}`);
      assert.equal(e.code, "jobs_llm_save_failed");
      assert.match(e.message, /页面已保存/, "页面这份确实存了，要如实说");
      assert.match(e.message, /日复盘|定时任务/, "要说清代价：定时任务还用旧来源");
      return true;
    });
    assert.equal(readAiRuntime().status, "ok", "页面配置不该因为后端那份失败而被回滚");
    assert.equal(JSON.parse(values.get(LLM_KEY) ?? "null").source.apiKey, "sk-page-1");
  } finally { restore(); }
});

test("🔴 后端还是旧进程（没这个路由）：说清楚是「要重启」，别让用户以为是自己填错了", async () => {
  storageFixture();
  const { restore } = fetchFixture(() => ({ status: 404, body: { error: "not found" } }));
  try {
    await assert.rejects(saveLlmEverywhere(CFG), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.match(e.message, /旧版本/);
      assert.match(e.message, /重启/, "要给出下一步动作");
      assert.match(e.message, /页面已保存/);
      return true;
    });
  } finally { restore(); }
});

test("清除要连后端那份一起删，否则留下一个没人管的 key", async () => {
  const values = storageFixture();
  values.set(LLM_KEY, JSON.stringify({ schemaVersion: 2, source: CFG }));
  const { sent, restore } = fetchFixture(() => ({ status: 200, body: { ok: true, removed: true, ...OK_STATUS, saved: false, jobs_ai: { layer: "config", provider: "agnes-ai", model: "agnes-2.5-flash" } } }));
  try {
    await clearLlmEverywhere();
    assert.equal(values.has(LLM_KEY), false, "浏览器这份要删掉");
    assert.deepEqual(sent.map((s) => `${s.method} ${s.url}`), ["DELETE /api/llm-saved"]);
  } finally { restore(); }
});

test("🔴 后端那份没删掉：必须说出来（它带着 key，而且定时任务还在用它）", async () => {
  const values = storageFixture();
  values.set(LLM_KEY, JSON.stringify({ schemaVersion: 2, source: CFG }));
  const { restore } = fetchFixture(() => ({ status: 500, body: { error: "saved_llm_clear_failed", message: "删不掉 llm.json：EBUSY" } }));
  try {
    await assert.rejects(clearLlmEverywhere(), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, "jobs_llm_clear_failed");
      assert.match(e.message, /后台那份还在/);
      assert.match(e.message, /定时任务仍会用它/);
      return true;
    });
    assert.equal(values.has(LLM_KEY), false, "本地已清，报的必须是「后台那份还在」而不是「都没清」");
  } finally { restore(); }
});
