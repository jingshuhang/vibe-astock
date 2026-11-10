/**
 * 超短线机会发现 · **取数信封契约**回归。
 *
 * 背景（2026-11-10 实机）：这一页长期显示「今天没有匹配到模式的机会」且零报错，
 * 上游 `em_zt_pool` 当天实取 53 只。根因是 `opportunities.ts` 按一套**根本不存在的字段名**
 * 解析信封（field === "code" / name / limit_up_time / tags / sector），
 * 而 mapper (`mappers.py: em_zt_pools`) 给的是 `pool_*` + `record_key`。
 *
 * 这里的 fixture 全部按 `/fetch` 实机返回的形状构造，不是自造的理想数据：
 *   - 逐只证据 `record_key = 代码`，字段 `pool_limit_days / pool_change_pct / pool_price /
 *     pool_amount / pool_float_cap / pool_seal_fund / pool_break_times / pool_turnover`；
 *   - 名称 / 行业 / 首封时间只在 note 里：`"{code} {name} {industry} {zt_stat} 首封 {HH:MM:SS}"`；
 *   - ladder / firstboard 的 `extra.result` 是**对象**，逐只在 `result.stocks`；
 *   - `em_limit_up_sentiment` 实机当天是 `status: failed`，而 `cn_shortline_daily` 有 broken_rate。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleOpportunities, envelopeUsable, opportunityDayArgs, parseFirstboard,
  parseLadder, parseRates, parseZtPool, type OpportunityEnvelopes,
} from "../src/finance/shortline/opportunities.ts";

interface Ev { field: string; value: unknown; record_key?: string; note?: string; period?: string }
const ev = (field: string, value: unknown, record_key?: string, note?: string): Ev =>
  ({ field, value, record_key, note, period: "2026-11-10" });

interface ZtSpec {
  code: string; name: string; industry: string; ztStat: string; firstSeal: string;
  boards: number; pct: number; price: number; amount: number; floatCap: number; sealFund: number; breaks: number;
}
const zt = (p: Partial<ZtSpec> & { code: string }): ZtSpec => ({
  name: "保利联合", industry: "化学制品", ztStat: "1天1板", firstSeal: "09:25:00",
  boards: 1, pct: 10.05, price: 7.23, amount: 25227639, floatCap: 3498478182, sealFund: 435029823, breaks: 0,
  ...p,
});

/** 与实机 `/fetch em_zt_pool` 的信封同形：8 条 pool_* 逐只证据 + 1 条计数 */
function ztEnvelope(specs: ZtSpec[], status = "ok"): Record<string, unknown> {
  const evidence: Ev[] = [ev("limit_up_pool_count", specs.length)];
  for (const s of specs) {
    const note = `${s.code} ${s.name} ${s.industry} ${s.ztStat} 首封 ${s.firstSeal}`;
    evidence.push(ev("pool_limit_days", s.boards, s.code, note));
    evidence.push(ev("pool_change_pct", s.pct, s.code, note));
    evidence.push(ev("pool_price", s.price, s.code, note));
    evidence.push(ev("pool_amount", s.amount, s.code, note));
    evidence.push(ev("pool_float_cap", s.floatCap, s.code, note));
    evidence.push(ev("pool_seal_fund", s.sealFund, s.code, note));
    evidence.push(ev("pool_break_times", s.breaks, s.code, note));
    evidence.push(ev("pool_turnover", 0.72, s.code, note));
  }
  return { status, evidence, extra: { pool: "limit_up_pool", date: "2026-11-10" }, missing: [] };
}

const dailyEnvelope = (broken = 0.278, status = "ok"): Record<string, unknown> => ({
  status,
  evidence: [ev("limit_up_count", 53), ev("ladder_highest", 6), ev("broken_rate", broken),
    ev("money_effect_sample", 55), ev("money_effect_median_ret", 3.13)],
  extra: { date: "2026-11-10", result: { date: "2026-11-10", readings: { broken_rate: broken } } },
  missing: [],
});
const sentimentEnvelope = (status = "ok"): Record<string, unknown> => ({
  status,
  evidence: status === "failed" ? [] : [ev("limit_up_count", 53), ev("break_board_count", 20), ev("limit_down_count", 3)],
  extra: {}, missing: [],
});
const ladderEnvelope = (status = "ok"): Record<string, unknown> => ({
  status,
  evidence: status === "failed" ? [] : [ev("ladder_sample_count", 54), ev("ladder_highest", 6)],
  extra: {
    quote_date: "2026-11-10", sample_date: "2026-11-09",
    result: {
      quote_date: "2026-11-10", sample_date: "2026-11-09",
      stocks: [{ code: "600099", name: "闽发铝业", boards: 6, label: "11天7板", sector: "工业金属", first_seal: "092500", broken_times: 1 }],
      total: 1, highest: 6, tiers: [{ boards: 6, count: 1 }],
    },
  },
  missing: [],
});
const firstboardEnvelope = (opts: { status?: string; reason?: boolean; resultAsArray?: boolean } = {}): Record<string, unknown> => {
  const stocks = [{ code: "600001", name: "阳光照明", sector: "照明设备", board: "10cm", first_seal: "092500",
    broken_times: 0, label: "首板", reason: opts.reason === false ? "" : "商业航天+激光通信" }];
  const result: Record<string, unknown> = {
    date: "2026-11-10", available: true, reason_available: opts.reason !== false,
    reason_covered: opts.reason === false ? 0 : 1, total_limit_up: 53, first_count: 1, stocks,
  };
  return {
    status: opts.status ?? "ok",
    evidence: [ev("limit_up_count", 53), ev("first_board_count", 1)],
    extra: { date: "2026-11-10", result: opts.resultAsArray ? stocks : result },
    missing: [],
  };
};

const goodEnvs = (): OpportunityEnvelopes => ({
  ztPool: ztEnvelope([zt({ code: "600001" }), zt({ code: "600002", name: "闽发铝业", industry: "工业金属", ztStat: "6天6板", boards: 6 })]),
  daily: dailyEnvelope(0.2), sentiment: sentimentEnvelope(), ladder: ladderEnvelope(), firstboard: firstboardEnvelope(),
});

// ─── ① 日期参数：唯一一处必须 compact ────────────────────────────────────────────
describe("机会页五路取数的 date 参数", () => {
  it("em_zt_pool 只认 YYYYMMDD；计算型端点两种格式都接受（实机验过）", () => {
    const a = opportunityDayArgs("2026-11-10");
    assert.deepEqual(a.ztPool, { date: "20261110" }, "带横线的日期会让端点 exit 3 / failed");
    assert.deepEqual(a.daily, { date: "2026-11-10" });
    assert.deepEqual(a.ladder, { date: "2026-11-10" });
    assert.deepEqual(a.firstboard, { date: "2026-11-10" });
    assert.deepEqual(a.sentiment, {});
    assert.equal(opportunityDayArgs("20261110").ztPool.date, "20261110", "本来就是紧凑格式时不能被改坏");
  });
});

// ─── ② 涨停池：真实字段契约 ──────────────────────────────────────────────────────
describe("涨停池信封解析（真实 pool_* 契约）", () => {
  it("53 只票能逐只解析出代码 / 名称 / 行业 / 连板数 / 首封时间", () => {
    const specs = Array.from({ length: 53 }, (_, i) => zt({ code: String(600000 + i).padStart(6, "0") }));
    const parsed = parseZtPool(ztEnvelope(specs));
    assert.equal(parsed.rows.length, 53);
    assert.deepEqual(parsed.gaps, [], "字段齐时不该凭空造缺口");
    const r = parsed.rows[0]!;
    assert.equal(r.code, "600000");
    assert.equal(r.name, "保利联合");
    assert.equal(r.sector, "化学制品");
    assert.equal(r.boards, 1);
    assert.equal(r.limit_up_time, "09:25");
  });

  it("成交额取 pool_amount（元），不能拿 pool_turnover（换手率%）当成交额", () => {
    const r = parseZtPool(ztEnvelope([zt({ code: "600001", amount: 25227639 })]));
    assert.equal(r.rows[0]!.turnover, 25227639);
    assert.equal(r.rows[0]!.float_market_cap, 3498478182);
    assert.equal(r.rows[0]!.seal_order, 435029823);
  });

  it("行业名为空时，第 3 段的「N天M板」不能当成行业名", () => {
    const env = ztEnvelope([zt({ code: "600001", industry: "" })]);
    // 真实 note 会因空 industry 出现连续空格：`600001 保利联合  1天1板 首封 09:25:00`
    const row = (env.evidence as Ev[]).find((e) => e.field === "pool_limit_days")!;
    row.note = "600001 保利联合  1天1板 首封 09:25:00";
    const r = parseZtPool(env).rows[0]!;
    assert.equal(r.name, "保利联合");
    assert.equal(r.sector, "", "不能把涨停统计写成行业");
  });

  it("缺连板数 / 开板次数要写进 gaps，不静默按 0 处理", () => {
    const env = ztEnvelope([zt({ code: "600001" })]);
    env.evidence = (env.evidence as Ev[]).filter((e) => e.field !== "pool_limit_days" && e.field !== "pool_break_times");
    const r = parseZtPool(env);
    assert.equal(r.rows[0]!.boards, undefined);
    assert.ok(r.gaps.some((g) => g.includes("pool_limit_days")));
    assert.ok(r.gaps.some((g) => g.includes("pool_break_times")));
  });

  it("旧版假字段名（field === \"code\"）解析不出有效行 —— 回归护栏", () => {
    const fake = { status: "ok", evidence: [ev("code", "600001", "600001"), ev("name", "甲", "600001")], extra: {}, missing: [] };
    assert.equal(envelopeUsable(fake), true, "信封本身看着是 ok，光判 status 抓不到这类断链");
    assert.equal(parseZtPool(fake).rows[0]?.boards, undefined);
    const out = assembleOpportunities({ ...goodEnvs(), ztPool: fake }, "2026-11-10", "10:55:00");
    assert.equal(out.status, "failed", "一行连板数都读不到，必须判没取到");
    assert.equal(out.opportunities.length, 0);
    assert.ok(out.gaps.some((g) => g.includes("不是「今天没有机会」")));
  });
});

// ─── ③ 辅源：extra.result 是对象 ────────────────────────────────────────────────
describe("ladder / firstboard 的 extra.result.stocks", () => {
  it("从对象里的 stocks 解析，HHMMSS 首封时间转 HH:MM", () => {
    const lad = parseLadder(ladderEnvelope());
    assert.equal(lad.size, 1);
    assert.equal(lad.get("600099")?.boards, 6);
    assert.equal(lad.get("600099")?.open_count, 1);
    assert.equal(lad.get("600099")?.limit_up_time, "09:25");
    const fb = parseFirstboard(firstboardEnvelope());
    assert.equal(fb.get("600001")?.tags?.[0], "商业航天+激光通信");
    assert.equal(fb.get("600001")?.limit_up_time, "09:25");
  });

  it("旧版把 extra.result 当数组的写法解析不出任何行 —— 回归护栏", () => {
    const asArray = firstboardEnvelope({ resultAsArray: true });
    assert.equal(parseFirstboard(asArray).size, 0);
    const out = assembleOpportunities({ ...goodEnvs(), firstboard: asArray }, "2026-11-10", "10:55:00");
    assert.ok(out.gaps.some((g) => g.includes("首板名单没取到")));
  });

  it("failed 信封不算可用；partial 可用但要标缺口", () => {
    assert.equal(envelopeUsable({ status: "failed", evidence: [], reason: "超出保留期" }), false);
    assert.equal(envelopeUsable({ status: "partial", evidence: [ev("broken_rate", 0.278)] }), true);
    assert.equal(envelopeUsable({ status: "ok", evidence: [ev("x", 0)], extra: { placeholder_zero: true } }), false,
      "占位 0 不是真 0，不能入清单");
  });
});

// ─── ④ 封板率：主源 / 备源 / 都没有 ─────────────────────────────────────────────
describe("封板率三态（2026-11-10 实机：三池计数 failed，每日情绪 0.278）", () => {
  it("主源 cn_shortline_daily 给 broken_rate → seal_rate = 1 − broken_rate", () => {
    const r = parseRates(dailyEnvelope(0.278), sentimentEnvelope("failed"));
    assert.equal(r.broken_rate, 0.278);
    assert.equal(r.seal_rate, 0.722);
    assert.equal(r.limit_up, 53);
  });

  it("主源缺失时退回三池计数备源：涨停 ÷(涨停 + 炸板)", () => {
    const r = parseRates({ status: "failed", evidence: [], extra: {}, missing: [] }, sentimentEnvelope());
    assert.ok(Math.abs((r.seal_rate ?? 0) - 53 / 73) < 1e-9);
    assert.ok(r.gaps.some((g) => g.includes("备源")));
  });

  it("两路都没取到 → 留白 + 缺口，不写 0", () => {
    const r = parseRates({ status: "failed", evidence: [], extra: {}, missing: [] }, sentimentEnvelope("failed"));
    assert.equal(r.seal_rate, null);
    assert.equal(r.broken_rate, null);
    assert.ok(r.gaps.some((g) => g.includes("不写 0")));
  });

  it("broken_rate 超出 [0,1] 不是合法读数，不能拿去算封板率", () => {
    const r = parseRates(dailyEnvelope(27.8), sentimentEnvelope("failed"));
    assert.equal(r.seal_rate, null);
  });
});

// ─── ⑤ 组装：失败 ≠ 今天没有机会 ────────────────────────────────────────────────
describe("assembleOpportunities：取数失败与真的没匹配到必须分开", () => {
  it("五路齐全 → 有具体标的，status ok，notes 与 gaps 同源", () => {
    const out = assembleOpportunities(goodEnvs(), "2026-11-10", "10:55:00");
    assert.equal(out.status, "ok", `不该凭空造缺口：${out.gaps.join(" | ")}`);
    assert.equal(out.limit_up_count, 2);
    assert.equal(out.opportunities.length, 2, "首板爆发 + 龙头接力都该识别出来");
    assert.equal(out.opportunities[0]?.code, "600001");
    assert.equal(out.opportunities[0]?.pattern?.type, "首板爆发");
    assert.equal(out.opportunities[0]?.name, "保利联合", "名称从涨停池 note 解析");
    assert.equal(out.opportunities[0]?.tags?.[0], "商业航天+激光通信", "题材从首板名单的结构化 reason 补上");
    assert.equal(out.seal_rate, 0.8);
    assert.equal(out.phase, "强势");
    assert.deepEqual(out.notes, out.gaps, "notes 是 gaps 的兼容别名，两处不许分叉");
  });

  it("涨停池 failed → status failed、空清单明说「不是今天没有机会」", () => {
    const failed = { status: "failed", evidence: [], reason: "2026-11-10 的池子是空的(超出东财约一个月的保留期)", missing: [], extra: {} };
    const out = assembleOpportunities({ ...goodEnvs(), ztPool: failed }, "2026-11-10", "10:55:00");
    assert.equal(out.status, "failed");
    assert.equal(out.limit_up_count, 0);
    assert.equal(out.opportunities.length, 0);
    assert.ok(out.gaps[0]!.includes("不是「今天没有机会」"), "缺口第一条就要把这条说破");
    assert.ok(out.gaps[0]!.includes("超出东财约一个月"));
    assert.deepEqual(out.notes, out.gaps);
  });

  it("被 allSettled 拒掉也要写进缺口，不静默", () => {
    const envs = goodEnvs();
    envs.rejected = { firstboard: "连接超时" };
    envs.firstboard = null;
    const out = assembleOpportunities(envs, "2026-11-10", "10:55:00");
    assert.equal(out.status, "partial");
    assert.ok(out.gaps.some((g) => g.includes("连接超时")));
  });

  it("涨停原因没取到 → 题材维度标缺口，首板爆发仍按封板时间判定", () => {
    const out = assembleOpportunities({ ...goodEnvs(), firstboard: firstboardEnvelope({ reason: false }) }, "2026-11-10", "10:55:00");
    assert.equal(out.status, "partial");
    assert.ok(out.gaps.some((g) => g.includes("题材维度本轮不参与")));
    assert.equal(out.opportunities.find((o) => o.code === "600001")?.pattern?.confidence, 50,
      "没题材只给「题材待确认」那一档，不能假装核实过");
  });

  it("真的没匹配到（信封 ok 但没有早封首板 / 高标）→ status ok、空清单是合法结论", () => {
    const envs = goodEnvs();
    envs.ztPool = ztEnvelope([zt({ code: "600009", boards: 2, firstSeal: "14:20:00" })]);
    const out = assembleOpportunities(envs, "2026-11-10", "10:55:00");
    assert.equal(out.status, "ok");
    assert.equal(out.limit_up_count, 1);
    assert.equal(out.opportunities.length, 0);
    assert.ok(!out.gaps.some((g) => g.includes("没取到")));
  });
});
