/**
 * 快照时效「两套声明」的口径护栏。
 *
 * 🔴 2026-11-08 盘点时一度写成「registry 的 `cache_max_age_sec` 没有任何代码读取，
 *    是静默失效」—— **这是误判**。`service.ts` 一直把它读出来传给 `snapshotUsable`，
 *    后者与调用方 `consistency.max_age_ms` 取 `Math.min`，它是**硬上限**。
 *    那次只 grep 了 finance/ 目录就下结论，没扫全仓（silent-data-traps #21：
 *    提「高优先建议」前先确认不是假空白）。
 *
 * 真正的隐患是两套声明分叉：`datasources/registry.json` 的 54 个声明(硬上限)
 * 与 `finance/snapshot_ttl.ts` 的 18 个(视图调用方意图)，重叠 11 个里 8 个数值不同。
 * 改任一侧都可能悄悄改变取数频率，所以这里：
 *   ① 用真函数钉住 `min` 语义（含 `0 = 从不缓存`）；
 *   ② 钉住 TS 表的 key 都对应真实端点（拼错会静默落兜底，不报错）；
 *   ③ 钉住「缺省不是不限」与「service.ts 确实读了注册表」，防注释与接线回退。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_PREFER_CACHE_MAX_AGE_MS, SNAPSHOT_SCHEMA, snapshotUsable, type Snapshot } from "../src/snapshot.ts";
import { SNAPSHOT_FALLBACK_MAX_AGE_MS, SNAPSHOT_MAX_AGE_MS, consistencyFor } from "../src/finance/snapshot_ttl.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");
const registry = JSON.parse(read(path.join("datasources", "registry.json"))) as {
  endpoints: { id: string; cache_max_age_sec?: number | null }[];
};
const byId = new Map(registry.endpoints.map((e) => [e.id, e]));

const snapAt = (msAgo: number): Snapshot => ({
  schema: SNAPSHOT_SCHEMA, key: "k", endpoint: "ep", symbol: "",
  fetched_at: new Date(Date.now() - msAgo).toISOString(), payload: {},
});

test("[行为] registry 声明是硬上限：调用方给再宽的上限也压不过它", () => {
  const ep = registry.endpoints.find((e) => e.cache_max_age_sec === 300);
  assert.ok(ep, "注册表里得有声明 300 秒的端点");
  const hardMs = Number(ep.cache_max_age_sec) * 1000;
  const wide = { mode: "prefer_cache" as const, max_age_ms: 24 * 3600_000 };
  assert.equal(snapshotUsable(snapAt(4 * 60_000), wide, hardMs), true,
    "硬上限 5 分钟内,调用方给一天也不该把上限放宽掉");
  assert.equal(snapshotUsable(snapAt(4 * 60_000), { mode: "prefer_cache", max_age_ms: 60_000 }, hardMs), false,
    "调用方要求更严时按更严的 —— 两侧取 min");
  assert.equal(snapshotUsable(snapAt(6 * 60_000), wide, hardMs), false,
    "超过硬上限,调用方放宽不了");
});

test("[行为] cache_max_age_sec=0 是「从不缓存」,不是「不限」", () => {
  const ep = registry.endpoints.find((e) => e.cache_max_age_sec === 0);
  assert.ok(ep, "得有声明 0 秒的端点(交易日历/会话阶段这类按此刻算的字段)");
  assert.equal(snapshotUsable(snapAt(1), { mode: "prefer_cache", max_age_ms: 3600_000 }, 0), false,
    "刚取回也不许命中");
  assert.equal(snapshotUsable(snapAt(1), { mode: "prefer_cache", max_age_ms: 3600_000 }, undefined), true,
    "没声明的端点不受这条约束,落调用方 / Core 兜底");
});

test("[行为] 不写上限也不再等于永不过期,且两套兜底同源", () => {
  assert.equal(SNAPSHOT_FALLBACK_MAX_AGE_MS, DEFAULT_PREFER_CACHE_MAX_AGE_MS);
  assert.equal(snapshotUsable(snapAt(60 * 60_000), { mode: "prefer_cache" }), false,
    "1 小时前的快照必须判过期");
  assert.deepEqual(consistencyFor("zzz_undeclared_endpoint"),
    { mode: "prefer_cache", max_age_ms: DEFAULT_PREFER_CACHE_MAX_AGE_MS },
    "表外端点统一落 Core 缺省,不许再分叉出第二套兜底");
});

test("[结构] TS 表里的端点 id 必须都在注册表里 —— 拼错会静默落兜底", () => {
  const declared = Object.keys(SNAPSHOT_MAX_AGE_MS);
  assert.ok(declared.length >= 18, `逐端点表不该被清空,实得 ${declared.length}`);
  for (const id of declared) {
    assert.ok(byId.has(id), `${id} 不在 datasources/registry.json 里 —— 拼错的 key 不会报错,只会悄悄不走这条规则`);
    assert.ok(Number.isFinite(SNAPSHOT_MAX_AGE_MS[id]) && (SNAPSHOT_MAX_AGE_MS[id] ?? 0) > 0,
      `${id} 的上限得是有限正数`);
  }
});

test("[结构] service.ts 必须把注册表声明传进 snapshotUsable —— 别再被误判成「没人读」", () => {
  const src = read(path.join("orchestrator", "src", "service.ts"));
  assert.match(src, /ep\.cache_max_age_sec/, "得从端点定义里读声明");
  assert.match(src, /snapshotUsable\(hit, consistency, epMaxAge\)/, "得作为硬上限传下去");
  const regTs = read(path.join("orchestrator", "src", "registry.ts"));
  assert.doesNotMatch(regTs, /缺省\s*=\s*不限/, "Core 加 2 分钟兜底后,「缺省=不限」已是过时口径");
});
