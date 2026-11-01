// 本页战绩卡:收盘快照+次日对账的实测(类别×环境)与 patternPrior 先验并排。
// 断言语义不变量:12 格子全给、先验取自同一张表、无样本显示「—」不伪装 0、
// 口径文案(市场现象统计)原样带出、待对账不进统计、没快照时讲清楚 18:45 会发生什么。
import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { OpportunityTrackResult, TrackCell } from "../src/verticals/finance/lib/shortlineOpportunityTrack.ts";

const PAGE = "/src/verticals/finance/pages/ShortlineOpportunities.tsx";

const CATS = ["首板", "连板", "高标"] as const;
const REGIMES = ["情绪强", "情绪中", "情绪弱", "环境未覆盖"] as const;
type Cat = (typeof CATS)[number];
type Reg = (typeof REGIMES)[number];

const cell = (category: Cat, regime: Reg, sample: number, win_rate: number | null): TrackCell => ({
  category, regime, sample, win_rate,
  avg: win_rate == null ? null : 1.2, median: win_rate == null ? null : 0.8, best: sample ? 10 : null, worst: sample ? -5 : null,
  limit_up_rate: null,
});
/** 12 格子全给(后端 trackSummary 恒给全表);只有两格有已对账样本,其余 sample=0 */
const cells: TrackCell[] = [
  cell("首板", "情绪强", 9, 5 / 9), // 55.6%,先验 54.8%(n=281) → +0.8pp
  cell("连板", "情绪中", 3, 1 / 3), // 33.3%,先验 46.4%(n=56)
  ...CATS.flatMap((c) => REGIMES.map((r) =>
    (c === "首板" && r === "情绪强") || (c === "连板" && r === "情绪中") ? null : cell(c, r, 0, null))).filter((x): x is TrackCell => x != null),
];
const TRACK: OpportunityTrackResult = {
  available: true, date: "2026-10-30", snapshot_days: 3, total: 14, settled_count: 12, pending_count: 2,
  cells,
  pending_rows: [
    { date: "2026-10-30", code: "600001", name: "首板A", category: "首板", regime: "情绪强" },
    { date: "2026-10-30", code: "600002", name: "高位B", category: "高标", regime: "情绪中" },
  ],
  sample_caveat: "样本=前一日封板的涨停股(事后名单),收益=前收→今收等权,无滑点;是市场现象统计,不是策略回测,更不是打板收益。",
  generated_at: "2026-10-30T15:50:00+08:00",
};
const EMPTY: OpportunityTrackResult = { ...TRACK, available: false, date: null, snapshot_days: 0, total: 0, settled_count: 0, pending_count: 0, cells: [], pending_rows: [] };

test("战绩卡:12 格子里实测与先验并排,先验数字就是 patternPrior 那张表的", async () => {
  await withRenderer(async (r) => {
    const { TrackCard } = await r.load(PAGE);
    const t = textOf(r.html(TrackCard, { t: TRACK, loading: false, why: null }));
    // 有样本的格子:实测 55.6%(n=9) 与先验 54.8%(n=281) 同屏,差值 +0.8pp
    assert.match(t, /55\.6% \(n=9\)/);
    assert.match(t, /54\.8% \(n=281\)/);
    assert.match(t, /实测−先验 \+0\.8pp/);
    // 连板·情绪中:实测 33.3% 低于先验 46.4% → 差值为负
    assert.match(t, /33\.3% \(n=3\)/);
    assert.match(t, /46\.4% \(n=56\)/);
    assert.match(t, /实测−先验 -13\.1pp/);
    // 12 个格子都带一行「先验 x%(n=y)」——和 PRIOR 表逐格对齐
    assert.equal((t.match(/先验 \d+\.\d% \(n=\d+\)/g) ?? []).length, 12);
    // 汇总行:已对账/待对账分开报
    assert.match(t, /已对账 12 只/);
    assert.match(t, /待对账 2 只/);
  });
});

test("战绩卡:没样本的格子显示「—」,不伪装成 0%", async () => {
  await withRenderer(async (r) => {
    const { TrackCard } = await r.load(PAGE);
    const t = textOf(r.html(TrackCard, { t: TRACK, loading: false, why: null }));
    // 首板·情绪中没有已对账样本:实测 —(n=0),先验照常显示
    assert.match(t, /实测 — \(n=0\)/);
    assert.match(t, /36\.4% \(n=228\)/);
    // 页面上不应出现独立的 0.0% 这种「把没有伪装成零」的数字
    // (不能用 includes——先验里有 "60.0%" 这种子串;负向 (?<![\d.]) 只拦不带前缀的 0.0%)
    assert.ok(!/(?<![\d.])0\.0%/.test(t), t);
    // 没样本就不给差值(pp 行只在有实测时出现):正负两种差值各出现一次
    assert.equal((t.match(/实测−先验/g) ?? []).length, 2);
  });
});

test("战绩卡:口径文案原样带出——市场现象统计,不是策略回测", async () => {
  await withRenderer(async (r) => {
    const { TrackCard } = await r.load(PAGE);
    const t = textOf(r.html(TrackCard, { t: TRACK, loading: false, why: null }));
    assert.match(t, /市场现象统计/);
    assert.match(t, /不是策略回测/);
    assert.match(t, /更不是打板收益/);
  });
});

test("战绩卡:待对账清单逐只列出,并说明没到次日收盘不进统计", async () => {
  await withRenderer(async (r) => {
    const { TrackCard } = await r.load(PAGE);
    const t = textOf(r.html(TrackCard, { t: TRACK, loading: false, why: null }));
    assert.match(t, /600001 首板A · 首板·情绪强/);
    assert.match(t, /600002 高位B · 高标·情绪中/);
    assert.match(t, /不进统计/);
  });
});

test("战绩卡:还没跑过第一次快照时,讲清楚 18:45 会发生什么、不摆空表", async () => {
  await withRenderer(async (r) => {
    const { TrackCard } = await r.load(PAGE);
    const t = textOf(r.html(TrackCard, { t: EMPTY, loading: false, why: null }));
    assert.match(t, /还没跑过第一次收盘快照/);
    assert.match(t, /18:45/);
    assert.match(t, /次日收盘自动对账/);
    // 空台账不渲染 12 格子表(「先验 x%」的数字行一条都没有;标题「历史先验」不算)
    assert.ok(!/先验 \d/.test(t), t);
    assert.ok(!t.includes("已对账"), t);
  });
});

test("战绩卡:台账没取到时只降级文案,不摆空表也不报错", async () => {
  await withRenderer(async (r) => {
    const { TrackCard } = await r.load(PAGE);
    const t = textOf(r.html(TrackCard, { t: null, loading: false, why: "战绩台账没取到(不影响上面的清单): 端点不存在" }));
    assert.match(t, /战绩台账没取到/);
    assert.match(t, /不影响上面的清单/);
    // 只有标题里的「历史先验」,没有逐格的「先验 x%」数字行
    assert.ok(!/先验 \d/.test(t), t);
    // 还在取数时报状态,不显示错误
    const loading = textOf(r.html(TrackCard, { t: null, loading: true, why: null }));
    assert.match(loading, /台账取数中/);
  });
});
