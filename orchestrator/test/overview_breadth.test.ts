/**
 * 涨跌分布「没取到」不许被画成「真的是 0 家」。
 *
 * 旧链路：`breadthFrom(env)` 一家都没解析出来时返回 null，`extractBreadth` 却用
 * `?? 0` 把六个计数填满 → `extract()` 拿到非 null 的 data、块状态是 `ok` →
 * 前端 `BreadthBody` 用 `String(d.limit_up)` 显示「涨停 0 / 上涨 0」。
 * 同一屏的短线情绪是实时读数，看着就像全市场冰点 —— 不报错，只给错答案。
 *
 * 这里用真跑 `shortlineOverviewAct`（注入假取数、不联网）验证三态：
 * 全空 → empty + 算不出来；有数据 → 照常；部分数据 → 明确提示缺档是 0。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { shortlineOverviewAct } from "../src/finance/shortline/overview.ts";
import { fetchEndpoint, type ServiceContext } from "../src/service.ts";

const signal = new AbortController().signal;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ctx = (): ServiceContext => ({
  repoRoot,
  dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "vra-breadth-")),
  python: "python3", node: process.execPath,
});
const clean = (c: ServiceContext) => fs.rmSync(c.dataRoot, { recursive: true, force: true });
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/** 按 note 分档的长表（与 em_market_breadth 的真实信封同形） */
const BUCKETS = [
  { record_key: "d1", note: "涨停", field: "market_dist_count", value: 35 },
  { record_key: "d1", note: "涨停", field: "market_turnover_amount", value: 1.2e10 },
  { record_key: "d2", note: "跌停", field: "market_dist_count", value: 3 },
  { record_key: "d3", note: "涨0-3%", field: "market_dist_count", value: 1500 },
  { record_key: "d4", note: "跌0-3%", field: "market_dist_count", value: 500 },
  { record_key: "d5", note: "平盘", field: "market_dist_count", value: 200 },
];

/** 只有 breadth 端点给指定信封，其余端点给空但合法的结果，避免联网 */
function fakeFetch(breadth: Record<string, unknown>) {
  return async (_c: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => {
    const endpoint = String((req as { endpoint?: unknown }).endpoint ?? "");
    return {
      envelope: endpoint === "em_market_breadth" ? breadth : { status: "ok", evidence: [], extra: {} },
      fetched_at: "2026-11-08T09:30:00+08:00",
    };
  };
}

test("[行为] 一家都没解析出来 → breadth=empty、data=null、市场状态判「算不出来」", async () => {
  const c = ctx();
  try {
    const v = await shortlineOverviewAct(c, {}, signal, {
      fetch: fakeFetch({ status: "ok", evidence: [], extra: {} }),
    });
    assert.equal(v.breadth.status, "empty", "没数据不能报 ok");
    assert.equal(v.breadth.data, null, "不能给一份六个 0 的对象让前端当真值画");
    assert.match(v.breadth.note ?? "", /不是 0 家/, "要说清这不是「真的 0 家」");
    assert.equal(v.marketState.status, "empty", "全空时内嵌市场状态也得是 empty");
    assert.ok(v.marketState.data, "算不出来的视图仍要返回,别抛异常");
    assert.match(v.marketState.data.signal.unavailable ?? "", /没取到涨跌分布/);
    assert.equal(v.marketState.data.signal.composite, null, "不给分数");
    assert.equal(v.marketState.data.signal.position_cap_pct, null, "不给仓位上限(不是 0)");
  } finally { clean(c); }
});

test("[行为] 真实分档照常解析 —— 别把有数据的一天也判成「没取到」", async () => {
  const c = ctx();
  try {
    const v = await shortlineOverviewAct(c, {}, signal, {
      fetch: fakeFetch({ status: "ok", evidence: BUCKETS, extra: {} }),
    });
    assert.equal(v.breadth.status, "ok");
    assert.ok(v.breadth.data);
    assert.deepEqual(
      {
        limit_up: v.breadth.data.limit_up, limit_down: v.breadth.data.limit_down,
        up: v.breadth.data.up, down: v.breadth.data.down, flat: v.breadth.data.flat,
      },
      { limit_up: 35, limit_down: 3, up: 1500, down: 500, flat: 200 },
    );
    assert.equal(v.breadth.data.turnover_yi, 120);
    assert.equal(v.breadth.note, undefined, "数据齐时不该挂缺口提示");
  } finally { clean(c); }
});

test("[行为] partial 且只取到部分分档 → 明确提示「没取到的分档显示为 0」", async () => {
  const c = ctx();
  try {
    const v = await shortlineOverviewAct(c, {}, signal, {
      fetch: fakeFetch({ status: "partial", evidence: BUCKETS.slice(0, 1), extra: {} }),
    });
    assert.equal(v.breadth.status, "partial");
    assert.match(v.breadth.note ?? "", /别当成「一家都没有」/);
    assert.equal(v.breadth.data?.limit_up, 35);
    assert.equal(v.breadth.data?.up, 0, "缺的分档确实是 0,但要有说明");
  } finally { clean(c); }
});

test("[行为] 只取到部分分档 → 内嵌市场状态报 partial，并把缺口说明带出来", async () => {
  const c = ctx();
  try {
    const v = await shortlineOverviewAct(c, {}, signal, {
      fetch: fakeFetch({ status: "partial", evidence: BUCKETS.slice(0, 1), extra: {} }),
    });
    assert.equal(v.breadth.status, "partial");
    assert.equal(v.marketState.status, "partial", "部分数据不许被吞成 ok");
    assert.match(v.marketState.note ?? "", /别当成「一家都没有」/, "breadth 的缺口 note 要一路带到市场状态块");
    assert.equal(v.marketState.data?.signal.unavailable, null, "仍算得出来,不该冒充「算不出来」");
  } finally { clean(c); }
});

test("[结构] 后端不许退回 `?? 0` 占位，前端也不许无条件把六个计数画出来", () => {
  const backend = read(path.join("orchestrator", "src", "finance", "shortline", "overview.ts"));
  assert.doesNotMatch(backend, /c\?\.limit_up\s*\?\?\s*0/, "占位 0 的旧写法不能回来");
  assert.match(backend, /if \(!c\) return null;/, "解析不出来要真的返回 null");
  assert.match(backend, /gaps\.length \? "partial" : "ok"/, "部分数据不许再被吞成 ok");
  const frontend = read(path.join("desktop", "src", "verticals", "finance", "shortline", "OverviewTab.tsx"));
  assert.match(frontend, /d\.limit_up \+ d\.limit_down \+ d\.up \+ d\.down \+ d\.flat === 0/,
    "前端要有第二道防线,旧后端 / 旧缓存的六个 0 也不许画成读数");
  assert.match(frontend, /note=\{block\.note\}/, "后端的缺口说明要传到页面上");
  assert.match(frontend, /MarketStateOverviewPanel d=\{d as MarketStateResult\} note=\{block\.note\}/,
    "市场状态块也要接住 partial 的缺口说明");
});
