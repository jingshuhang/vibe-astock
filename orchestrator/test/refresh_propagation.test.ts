/**
 * 「刷新」必须一路透到底：GET query → 视图 → 端点一致性；机会链的子信号也一样。
 *
 * 全项目审计找到的断链：
 *  ① `shortline_overview` 的 run 写死 `{}`，GET ?refresh=1 丢了（只有 POST act 有效）；
 *  ② 机会链内部的 `marketStateAct(ctx, {}, signal)` 没带 force，刷新机会链时子信号仍读缓存；
 *  ③ `day_opportunity` 的宽度回溯把具体异常吞成通用 gap，看不出是哪个环节挂了。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { wantsFresh } from "../src/finance/snapshot_ttl.ts";

const read = (p: string) => readFileSync(new URL(`../src/finance/${p}`, import.meta.url), "utf8");

test("shortline_overview 的 GET query 原样交给视图", () => {
  const line = read("shortline/register.ts").split("\n").find((l) => l.includes('id: "shortline_overview"'));
  assert.ok(line, "视图得还在");
  assert.match(line, /run: \(ctx, q, signal\) => shortlineOverviewAct\(ctx, q, signal\)/);
  assert.doesNotMatch(line, /_q|shortlineOverviewAct\(ctx, \{\}/, "不许再把 query 丢掉");
});

test("wantsFresh 认 GET query 的字符串 1（q.refresh 不是 boolean）", () => {
  assert.equal(wantsFresh("1"), true);
  assert.equal(wantsFresh(1), true);
  assert.equal(wantsFresh(true), true);
  assert.equal(wantsFresh("0"), false);
});

test("机会链的 marketStateAct 子信号带 force", () => {
  const src = read("opportunity.ts");
  assert.ok(src.includes("marketStateAct(ctx, { refresh: force }, signal)"), "刷新机会链时子信号不许读缓存");
  assert.ok(!src.includes("marketStateAct(ctx, {}, signal)"), "不许退回写死空 body");
});

test("宽度回溯失败要把具体原因带进 gap，不许只留一句通用话", () => {
  const src = read("day_opportunity.ts");
  assert.ok(src.includes("histError = e instanceof Error ? e.message : String(e)"), "异常原因要留下");
  assert.ok(src.includes('具体失败：${histError}'), "gap 里要带出原因");
  assert.ok(!src.includes(".catch(() => [] as PackageDay[])"), "不许再吞回空数组");
});
