/**
 * 「刷新」必须一路透到底：GET query → 视图 → 端点一致性；机会链的子信号也一样。
 *
 * 全项目审计找到的断链：
 *  ① `shortline_overview` 的 run 写死 `{}`，GET ?refresh=1 丢了（只有 POST act 有效）；
 *  ② 机会链内部的 `marketStateAct(ctx, {}, signal)` 没带 force，刷新机会链时子信号仍读缓存；
 *  ③ `day_opportunity` 的宽度回溯把具体异常吞成通用 gap，看不出是哪个环节挂了。
 *
 * 🔴 验证强度分两类，别混：
 *  - **[行为]**：真调 `runView` / `shortlineOverviewAct`（注入假取数、不联网），断言 consistency 真的变了；
 *  - **[结构]**：注册闭包、子信号、gap 文案这三处没法不联网注入，只能钉源码，措辞一改就红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { wantsFresh } from "../src/finance/snapshot_ttl.ts";
import { shortlineOverviewAct } from "../src/finance/shortline/overview.ts";
import { fetchEndpoint, type ServiceContext } from "../src/service.ts";
import { registerView, runView } from "../src/views.ts";

const read = (p: string) => readFileSync(new URL(`../src/finance/${p}`, import.meta.url), "utf8");
const signal = new AbortController().signal;

/** 用模块位置算项目根，不依赖跑测试时的 cwd（从项目根跑还是从 orchestrator/ 跑都得一样） */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function ctx(): ServiceContext {
  return { repoRoot, dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-refresh-")), python: "python3", node: process.execPath };
}
const clean = (c: ServiceContext) => fs.rmSync(c.dataRoot, { recursive: true, force: true });

/** 假取数：记下每次请求的一致性策略。信封故意给 failed —— 视图本来就容忍单点失败 */
function spyFetch() {
  const calls: { endpoint: string; mode?: string; maxAge?: unknown }[] = [];
  const fetch = async (_c: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => {
    const r = req as { endpoint?: unknown; consistency?: { mode?: string; max_age_ms?: unknown } };
    calls.push({ endpoint: String(r.endpoint), mode: r.consistency?.mode, maxAge: r.consistency?.max_age_ms });
    return { envelope: { status: "failed", evidence: [], extra: {}, missing: [{ field: "probe", reason: "测试桩" }] } };
  };
  return { calls, fetch };
}

test("[行为] GET ?refresh=1 走到取数层时，所有端点都变成 fresh", async () => {
  const c = ctx();
  const { calls, fetch } = spyFetch();
  try {
    await shortlineOverviewAct(c, { refresh: "1" }, signal, { fetch });
    assert.ok(calls.length >= 6, `要真的发过取数请求，实得 ${calls.length}`);
    assert.ok(calls.every((x) => x.mode === "fresh"), "点了刷新就不许有任何一次读缓存");
  } finally { clean(c); }
});

test("[行为] 不带 refresh 时走 prefer_cache，且每次都带有限上限", async () => {
  const c = ctx();
  const { calls, fetch } = spyFetch();
  try {
    await shortlineOverviewAct(c, {}, signal, { fetch });
    assert.ok(calls.length >= 6);
    assert.ok(calls.every((x) => x.mode === "prefer_cache"), "没点刷新不该强制真取");
    assert.ok(calls.every((x) => typeof x.maxAge === "number" && Number.isFinite(x.maxAge) && x.maxAge > 0),
      "每个上限都得是有限正数 —— 缺一个就等于永不过期");
  } finally { clean(c); }
});

test("[行为] runView 把 GET query 原样交给注册视图的 run", async () => {
  let got: Record<string, string> | null = null;
  registerView({
    id: "probe_query_passthrough", label: "透传探针",
    run: async (_c, q) => { got = q; return null; },
  });
  const c = ctx();
  try {
    await runView(c, "probe_query_passthrough", { refresh: "1", foo: "bar" }, signal);
    assert.deepEqual(got, { refresh: "1", foo: "bar" }, "query 不许在 Core 层被丢掉或改写");
  } finally { clean(c); }
});

test("[结构] shortline_overview 的注册闭包原样把 query 交给视图", () => {
  const line = read("shortline/register.ts").split("\n").find((l) => l.includes('id: "shortline_overview"'));
  assert.ok(line, "视图得还在");
  assert.match(line, /run: \(ctx, q, signal\) => shortlineOverviewAct\(ctx, q, signal\)/);
  assert.doesNotMatch(line, /_q|shortlineOverviewAct\(ctx, \{\}/, "不许再把 query 丢掉");
});

test("[结构] wantsFresh 认 GET query 的字符串 1（q.refresh 不是 boolean）", () => {
  assert.equal(wantsFresh("1"), true);
  assert.equal(wantsFresh(1), true);
  assert.equal(wantsFresh(true), true);
  assert.equal(wantsFresh("0"), false);
});

test("[结构] 机会链的 marketStateAct 子信号带 force", () => {
  const src = read("opportunity.ts");
  assert.ok(src.includes("marketStateAct(ctx, { refresh: force }, signal)"), "刷新机会链时子信号不许读缓存");
  assert.ok(!src.includes("marketStateAct(ctx, {}, signal)"), "不许退回写死空 body");
});

test("[结构] 宽度回溯失败要把具体原因带进 gap，不许只留一句通用话", () => {
  const src = read("day_opportunity.ts");
  assert.ok(src.includes("histError = e instanceof Error ? e.message : String(e)"), "异常原因要留下");
  assert.ok(src.includes('具体失败：${histError}'), "gap 里要带出原因");
  assert.ok(!src.includes(".catch(() => [] as PackageDay[])"), "不许再吞回空数组");
});
