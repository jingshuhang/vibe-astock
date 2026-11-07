/**
 * 「机会发现」页三源全失败时，不许把「上次取数时刻」刷成现在。
 *
 * 三源互不依赖、谁先回来谁先上屏；原来无论成败都在收尾处记 `loadedAt` / `fetchedAt`，
 * 于是全挂时屏上是旧数、Freshness 却写「数据 0s 前取的」，还会把「切回前台补刷」压住两分钟 ——
 * 偏偏这时候最该重试。与 MarketState 页对齐：只有真拿到数据才算跑完一轮。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/pages/${p}`, import.meta.url), "utf8");

test("三源全失败：错误照常上屏，但不记 loadedAt / fetchedAt", () => {
  const page = read("Opportunity.tsx");
  const start = page.indexOf("const load = useCallback");
  const load = page.slice(start, page.indexOf("}, []);", start));
  assert.ok(load, "要能从 load() 里截出本轮取数逻辑");
  assert.ok(load.includes("setErrors(errs)"), "失败原因仍要照常上屏");
  assert.match(
    load,
    /if \(errs\.length === 0\) \{\s*loadedAt\.current = Date\.now\(\);\s*setFetchedAt\(Date\.now\(\)\);\s*\}\s*setLoading\(false\);/,
    "只有零错误才允许记时刻；loading 仍要无条件收尾",
  );
  assert.ok(load.includes("Promise.allSettled"), "三源仍要互不依赖，一个挂了不影响另外两个");
});

test("与 MarketState 页同一个口径：只有真拿到数据才记时刻", () => {
  const page = read("MarketState.tsx");
  assert.match(page, /if \(my === seq\.current\) \{ setData\(r\); setError\(""\); loadedAt\.current = Date\.now\(\); \}/);
  assert.ok(!/finally\s*\{[^}]*loadedAt\.current = Date\.now\(\)/.test(page), "不许退回 finally 里记");
});
