import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { detectPython } from "../src/init.ts";
import { FailureMemory, failTtlMsFromEnv, failureReasonOf, recentFailureMessage, slowFailMsFromEnv } from "../src/failure_memory.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";

// ── 纯逻辑 ──────────────────────────────────────────────────────────────

test("窗口内记得住,过了窗口自己忘掉(不让 Map 一直长)", () => {
  const m = new FailureMemory(() => 60_000);
  m.remember("k", "fetch_failed", "东财断连", 1000);
  const hit = m.recall("k", 1000 + 30_000);
  assert.ok(hit);
  assert.equal(hit.message, "东财断连");
  assert.equal(hit.ageMs, 30_000);
  assert.equal(hit.remainMs, 30_000);
  assert.equal(m.recall("k", 1000 + 60_000), null, "到点就作废");
  assert.equal(m.size, 0, "过期顺手清掉");
});

test("TTL 设成 0 就是整体关掉:不记、也不拦", () => {
  const m = new FailureMemory(() => 0);
  m.remember("k", "fetch_failed", "x", 1000);
  assert.equal(m.size, 0);
  assert.equal(m.recall("k", 1001), null);
});

test("成功一次就把记忆清掉 —— 上游恢复了不该继续拦", () => {
  const m = new FailureMemory(() => 60_000);
  m.remember("k", "fetch_failed", "x", 1000);
  assert.ok(m.recall("k", 2000));
  m.forget("k");
  assert.equal(m.recall("k", 2000), null);
});

test("环境变量:不填用默认 60 秒,0 等于关,乱填退回默认而不是变成 0", () => {
  assert.equal(failTtlMsFromEnv({}), 60_000);
  assert.equal(failTtlMsFromEnv({ VRA_FETCH_FAIL_TTL: "0" }), 0);
  assert.equal(failTtlMsFromEnv({ VRA_FETCH_FAIL_TTL: "30" }), 30_000);
  assert.equal(failTtlMsFromEnv({ VRA_FETCH_FAIL_TTL: "abc" }), 60_000, "写错不能悄悄关掉保护");
  assert.equal(failTtlMsFromEnv({ VRA_FETCH_FAIL_TTL: "-5" }), 60_000);
});

test("只记慢失败:阈值默认 2 秒,可配,乱填退回默认", () => {
  assert.equal(slowFailMsFromEnv({}), 2_000);
  assert.equal(slowFailMsFromEnv({ VRA_FETCH_FAIL_MIN_MS: "0" }), 0);
  assert.equal(slowFailMsFromEnv({ VRA_FETCH_FAIL_MIN_MS: "500" }), 500);
  assert.equal(slowFailMsFromEnv({ VRA_FETCH_FAIL_MIN_MS: "很快" }), 2_000);
});

test("失败原因用端点自己写的,读不到就说读不到、不编", () => {
  assert.equal(failureReasonOf({ status: "failed", errors: [{ error: "ConnectionError: 断连" }] }), "ConnectionError: 断连");
  assert.equal(failureReasonOf({ status: "failed", missing: [{ reason: "东财池为空" }] }), "东财池为空");
  assert.equal(failureReasonOf({ status: "failed" }), "取数状态 failed");
  assert.equal(failureReasonOf(null), "取数失败");
});

test("快失败的话要交代三件事:多久前失败、多久后才会再试、怎么立刻重试", () => {
  const msg = recentFailureMessage("涨跌分布", { code: "fetch_failed", message: "断连", at: 0, ageMs: 6_000, remainMs: 54_000 });
  assert.match(msg, /涨跌分布取数失败/);
  assert.match(msg, /6 秒前/);
  assert.match(msg, /断连/);
  assert.match(msg, /54 秒内不再重试/);
  assert.match(msg, /点刷新/);
});

// ── 接到取数链路上 ────────────────────────────────────────────────────────

/** 假取数器:每次都失败(退出码 3),并在 calls.log 里记一行,用来数「真取了几次」 */
const FAKE_FAIL = String.raw`import json,sys
a=sys.argv; ep=a[a.index('--endpoint')+1]
open('calls.log','a',encoding='utf-8').write(ep+'\n')
print(json.dumps({'script':ep,'status':'failed','evidence':[],
  'errors':[{'source':'eastmoney','error':'ConnectionError: RemoteDisconnected'}],'missing':[]}))
sys.exit(3)
`;

/** 慢版假取数器:一起来就先记一行(取消也能数到),再磨蹭一会儿才报失败 */
const FAKE_SLOW_FAIL = String.raw`import json,sys,time
a=sys.argv; ep=a[a.index('--endpoint')+1]
open('calls.log','a',encoding='utf-8').write(ep+'\n')
sys.stdout.flush()
time.sleep(1.2)
print(json.dumps({'script':ep,'status':'failed','evidence':[],
  'errors':[{'source':'eastmoney','error':'ConnectionError: RemoteDisconnected'}],'missing':[]}))
sys.exit(3)
`;

function fakeCtx(script: string = FAKE_FAIL): { ctx: { repoRoot: string; dataRoot: string; python: string; node: string }; calls: () => number; cleanup: () => Promise<void> } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "va-failmem-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), script);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot);
  return {
    ctx: { repoRoot: repo, dataRoot, python: PY, node: process.execPath },
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } },
    // Windows 上刚被杀掉的子进程放句柄慢,删目录会 EBUSY(实测)。退避重试几轮;
    // 真清不掉也就算了 —— 这是系统临时目录,不该为了让清理干净而把测试判红。
    cleanup: async (): Promise<void> => {
      for (let i = 0; i < 12; i++) {
        try { fs.rmSync(repo, { recursive: true, force: true }); return; }
        catch { await new Promise((r) => setTimeout(r, 120)); }
      }
    },
  };
}

test("🔴 刚失败的端点第二次直接快失败,不再白等一遍;刷新与关掉记忆时照旧真取", async () => {
  const { fetchEndpoint, resetFailureMemory } = await import("../src/service.ts");
  const { ctx, calls, cleanup } = fakeCtx();
  resetFailureMemory();
  delete process.env.VRA_FETCH_FAIL_TTL;
  process.env.VRA_FETCH_FAIL_MIN_MS = "0"; // 假取数器秒回,按默认阈值不会被记;这里要验记忆本身
  try {
    // 第一次:真取,拿到 failed 信封(exit 3)
    const r1 = await fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" });
    assert.equal(r1.exit_code, 3);
    assert.equal(calls(), 1);

    // 第二次(窗口内):不该再起进程,直接说清原因
    await assert.rejects(() => fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" }),
      (e: unknown) => (e as { code?: string; message?: string }).code === "fetch_recently_failed" &&
        /em_market_trend|主要指数/.test(String((e as { message?: string }).message)) &&
        /秒内不再重试/.test(String((e as { message?: string }).message)));
    assert.equal(calls(), 1, "第二次不许再起取数进程");

    // 显式刷新:用户不信这份记忆,必须真取
    await fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1", refresh: true });
    assert.equal(calls(), 2, "刷新要真取");

    // 关掉记忆:又回到每次都真取
    process.env.VRA_FETCH_FAIL_TTL = "0";
    await fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" });
    await fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" });
    assert.equal(calls(), 4);
  } finally {
    delete process.env.VRA_FETCH_FAIL_TTL;
    delete process.env.VRA_FETCH_FAIL_MIN_MS;
    resetFailureMemory();
    await cleanup();
  }
});

test("🔴 客户端自己取消不算上游失败:打断一次请求,别把后面一分钟的请求挡在门外", async () => {
  const { fetchEndpoint, resetFailureMemory } = await import("../src/service.ts");
  const { ctx, cleanup } = fakeCtx(FAKE_SLOW_FAIL);
  resetFailureMemory();
  delete process.env.VRA_FETCH_FAIL_TTL;
  process.env.VRA_FETCH_FAIL_MIN_MS = "0"; // 阈值清零:这样「取消要不要记」才是唯一变量,不掺时长
  try {
    // 用户切页面 / 手快点了刷新:请求被主动打断。
    // 等 200ms 再掐,确保打的是**正在取数的那一次**,而不是入口处就发现 signal 已废。
    const ac = new AbortController();
    const p = fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1", signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(() => p, (e: unknown) => (e as { code?: string }).code === "cancelled");

    // ⚠️ 必须等子进程真的关掉再往下走。取消是两段式的:调用方立刻拿到 cancelled,
    //    而「这次取数算不算失败」要等子进程 close 之后在内部 catch 里才判定。
    //    少了这一步,测试会跑在判定之前 —— 于是**修没修都是绿的**,等于没测。
    await new Promise((r) => setTimeout(r, 600));

    // 关键:重来一次必须**真取**,而不是被一句「几秒前取数已取消」挡回来。
    // (若取消被记成失败,这里会抛 fetch_recently_failed,拿不到 exit_code。)
    const r2 = await fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" });
    assert.equal(r2.exit_code, 3, "取消不该留下记忆 —— 这一次要真的去取,并如实返回上游失败");

    // 真失败才记:第三次在同一窗口内应快失败(证明「记」这个能力还在,不是被一刀切关掉)
    await assert.rejects(() => fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" }),
      (e: unknown) => (e as { code?: string }).code === "fetch_recently_failed");
  } finally {
    delete process.env.VRA_FETCH_FAIL_TTL;
    delete process.env.VRA_FETCH_FAIL_MIN_MS;
    resetFailureMemory();
    await cleanup();
  }
});

test("记忆按「查询」分开:别的端点不受牵连,也不会被别的端点的失败挡住", async () => {
  const { fetchEndpoint, resetFailureMemory } = await import("../src/service.ts");
  const { ctx, calls, cleanup } = fakeCtx();
  resetFailureMemory();
  delete process.env.VRA_FETCH_FAIL_TTL;
  process.env.VRA_FETCH_FAIL_MIN_MS = "0"; // 假取数器秒回,按默认阈值不会被记;这里要验记忆本身
  try {
    await fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" });
    assert.equal(calls(), 1);
    // 另一个端点:记忆不该命中,应该真取一次(然后自己也失败、也记一笔)
    await fetchEndpoint(ctx as never, { endpoint: "sina_board_flow", session: "s1" });
    assert.equal(calls(), 2, "别的端点不受牵连");
    // 两个都被记住之后,各自的第二次都快失败
    await assert.rejects(() => fetchEndpoint(ctx as never, { endpoint: "em_market_trend", session: "s1" }),
      (e: unknown) => (e as { code?: string }).code === "fetch_recently_failed");
    await assert.rejects(() => fetchEndpoint(ctx as never, { endpoint: "sina_board_flow", session: "s1" }),
      (e: unknown) => (e as { code?: string }).code === "fetch_recently_failed");
    assert.equal(calls(), 2);
  } finally {
    delete process.env.VRA_FETCH_FAIL_TTL;
    delete process.env.VRA_FETCH_FAIL_MIN_MS;
    resetFailureMemory();
    await cleanup();
  }
});
