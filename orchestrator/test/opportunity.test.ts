/**
 * 机会发现（板块 → 龙头 → 规划）单元测试。
 *
 * 🔴 这份测试护的是「不许把缺数当成结论」和「不许说自相矛盾的话」这两条：
 *    ① 没有近 5 日序列 ≠ 刚启动（轮动端点冷启 20+ 秒，挂了是常态）
 *    ② 5 只涨停但全是一板 → 理由必须是「没有高度」，不能是「仅 5 只涨停」
 *    ③ 已封板的票不许再写「距涨停还有 0.0%」「向上突破即封板」这种废话
 *    ④ 能不能动手只由市场状态的 can_open_position 决定，这里不自己拍 40%
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ignitionOf, rankLeaders, planDraftOf, sealGradeOf, SEAL_GRADE_CUT } from "../src/finance/opportunity.ts";
import { SNAPSHOT_MAX_AGE_MS, SNAPSHOT_FALLBACK_MAX_AGE_MS, consistencyFor, wantsFresh } from "../src/finance/snapshot_ttl.ts";
import { DEFAULT_CONSISTENCY, DEFAULT_PREFER_CACHE_MAX_AGE_MS, snapshotUsable } from "../src/snapshot.ts";
import type { RotationTopic, ThemeNode, SectorIgnition, LeaderPick, OpportunityResult, MarketFacts, TierOutcome, SealTiming, SealBucket, SealTrend } from "../src/finance/opportunity.ts";

const topic = (p: Partial<RotationTopic> & { tag: string }): RotationTopic => ({
  series: [], ranks: [], today: 0, active_days: 0, top3_days: 0, status: null, ...p,
});

const member = (p: { code: string; name?: string; boards: number; first_seal?: string | null; broken_times?: number | null; zt_stat?: string | null }) => ({
  code: p.code,
  name: p.name ?? p.code,
  boards: p.boards,
  zt_stat: p.zt_stat === undefined ? `${p.boards}天${p.boards}板` : p.zt_stat,
  first_seal: p.first_seal === undefined ? "093000" : p.first_seal,
  broken_times: p.broken_times === undefined ? 0 : p.broken_times,
});

/**
 * ⚠️ `limit_up` 必须能单独传：真实数据里它是题材的汇总字段（「三季报增长」今日 15 只），
 *    而同屏展示的 members 只截前 4 只 —— 用 members.length 当 limit_up 会算出完全不同的判断。
 */
const node = (p: Partial<ThemeNode> & { tag: string; members: ThemeNode["members"] }): ThemeNode => ({
  limit_up: p.limit_up ?? p.members.length,
  first_boards: p.first_boards ?? p.members.filter((m) => m.boards <= 1).length,
  consec_boards: p.consec_boards ?? p.members.filter((m) => m.boards >= 2).length,
  highest: p.highest ?? Math.max(0, ...p.members.map((m) => m.boards)),
  broken: 0, limit_down: 0,
  prev_limit_up: 0, prev_still_up: 0, prev_broken_or_down: 0,
  continuation_rate: null, upstream_state: null, first_seal: null, last_seal: null,
  ...p,
});

// ─── ① 板块启动 ─────────────────────────────────────────────────────────────────

describe("ignitionOf 板块启动判断", () => {
  it("没有近 5 日序列 → 「观察」，且明说判断不了（不许拿缺数当「昨天是 0」）", () => {
    const r = ignitionOf(topic({ tag: "大消费", series: [], today: 6 }), node({ tag: "大消费", members: [member({ code: "605338", boards: 2 })] }));
    assert.equal(r.state, "观察");
    assert.ok(r.evidence.some((e) => e.includes("判断不了")), `应明说判断不了，实际：${r.evidence.join(" | ")}`);
    // 🔴 最要命的错误形态：把缺数读成 0 然后判「新启动」
    assert.ok(!r.evidence.some((e) => e.includes("昨日 0 只")), "不许把缺数当昨日 0 只");
  });

  it("序列只有 1 位（等于只有今天）也不算新启动", () => {
    const r = ignitionOf(topic({ tag: "X", series: [6], ranks: [2], today: 6 }), node({ tag: "X", members: [member({ code: "A", boards: 1 })] }));
    assert.equal(r.state, "观察");
  });

  it("昨日有、今日归零 → 退潮", () => {
    const r = ignitionOf(topic({ tag: "X", series: [3, 5, 4, 0], ranks: [4, 2, 3, null] }), node({ tag: "X", members: [], limit_up: 0 }));
    assert.equal(r.state, "退潮");
    assert.ok(r.evidence[0]!.includes("今日 0 只"));
  });

  it("从榜外跳到 6 只且昨日 ≤2 → 新启动", () => {
    const r = ignitionOf(
      topic({ tag: "大消费", series: [0, 0, null, 0, 6], ranks: [null, null, null, null, 2], top3_days: 1 }),
      node({ tag: "大消费", limit_up: 6, first_boards: 5, consec_boards: 1, members: [member({ code: "605338", boards: 2 }), member({ code: "B", boards: 1 }), member({ code: "C", boards: 1 })] }),
    );
    assert.equal(r.state, "新启动");
    assert.ok(r.evidence.some((e) => e.includes("首板")));
  });

  it("本来在榜、今天还更多且仍在前三 → 加速", () => {
    const r = ignitionOf(
      topic({ tag: "三季报增长", series: [3, 3, 18, 11, 15], ranks: [4, 3, 1, 1, 1], top3_days: 4, active_days: 5 }),
      node({ tag: "三季报增长", limit_up: 15, first_boards: 12, consec_boards: 3, members: [member({ code: "001219", boards: 5 })] }),
    );
    assert.equal(r.state, "加速");
    assert.ok(r.evidence.some((e) => e.includes("连续放大")));
  });

  it("连续 5 天进前三但今天没再放大 → 高位拥挤", () => {
    const r = ignitionOf(
      topic({ tag: "“羊”字辈", series: [4, 5, 4, 6, 6], ranks: [2, 1, 3, 3, 2], top3_days: 5, active_days: 5 }),
      node({ tag: "“羊”字辈", limit_up: 6, first_boards: 2, consec_boards: 4, members: [member({ code: "002172", boards: 3 })] }),
    );
    assert.equal(r.state, "高位拥挤");
    assert.ok(r.evidence.some((e) => e.includes("没有继续放大")));
  });

  it("数据齐但都不满足前几条 → 延续", () => {
    const r = ignitionOf(
      topic({ tag: "PCB", series: [1, 1, 2, 1, 2], ranks: [9, 9, 6, 7, 6], top3_days: 0, active_days: 5 }),
      node({ tag: "PCB", limit_up: 2, first_boards: 2, consec_boards: 0, members: [member({ code: "301132", boards: 1 })] }),
    );
    assert.equal(r.state, "延续");
  });
});

// ─── ①b 延续率与「昨日到底有没有这个题材」 ─────────────────────────────────────

describe("ignitionOf 延续率与昨日覆盖", () => {
  it("🔴 没有轮动序列，但题材结构确认「昨日该题材 0 只涨停」且覆盖完整 → 可以判新启动", () => {
    const r = ignitionOf(
      topic({ tag: "大消费", series: [], today: 6 }),
      node({ tag: "大消费", limit_up: 6, first_boards: 5, consec_boards: 1, prev_limit_up: 0, continuation_rate: null, members: [member({ code: "605338", boards: 2 })] }),
      true,
    );
    assert.equal(r.state, "新启动", "有硬证据（昨日 0 只 + 覆盖完整）时不该退回「观察」");
    assert.ok(r.evidence.some((e) => e.includes("一只涨停都没有")));
  });

  it("🔴 覆盖不可靠时，即使 prev_limit_up = 0 也不许判新启动（那是「没取到」，不是「昨日没有」）", () => {
    const r = ignitionOf(
      topic({ tag: "大消费", series: [], today: 6 }),
      node({ tag: "大消费", limit_up: 6, prev_limit_up: 0, continuation_rate: null, members: [member({ code: "A", boards: 1 })] }),
      false,
    );
    assert.equal(r.state, "观察");
    assert.ok(!r.evidence.some((e) => e.includes("一只涨停都没有")), "覆盖不完整时不许下这个结论");
  });

  it("🔴 有轮动序列时不再写「昨日一只涨停都没有」，避免和序列的「昨日 N 只」自相矛盾", () => {
    const r = ignitionOf(
      topic({ tag: "三季报扭亏", series: [0, 1, 2, 1, 4], ranks: [null, 9, 6, 7, 5], top3_days: 0, active_days: 4 }),
      node({ tag: "三季报扭亏", limit_up: 4, prev_limit_up: 0, continuation_rate: null, members: [member({ code: "603131", boards: 3 })] }),
      true,
    );
    const saysZero = r.evidence.some((e) => e.includes("一只涨停都没有"));
    const saysPrev = r.evidence.some((e) => e.includes("昨日 1 只"));
    assert.ok(saysPrev, `序列说昨日 1 只：${r.evidence.join(" | ")}`);
    assert.ok(!saysZero, `同时又说昨日一只都没有 → 自相矛盾：${r.evidence.join(" | ")}`);
  });

  it("延续率低 + 只数在涨 → 必须点明是「新票接力」，不是老方向在加强", () => {
    const r = ignitionOf(
      topic({ tag: "三季报增长", series: [3, 3, 18, 11, 15], ranks: [4, 3, 1, 1, 1], top3_days: 4, active_days: 5 }),
      node({ tag: "三季报增长", limit_up: 15, first_boards: 12, consec_boards: 3, limit_down: 2,
        prev_limit_up: 11, prev_still_up: 3, prev_broken_or_down: 2, continuation_rate: 0.273,
        members: [member({ code: "001219", boards: 5 })] }),
      true,
    );
    assert.equal(r.state, "加速");
    const all = r.evidence.join(" | ");
    assert.ok(all.includes("延续率 27.3%"), all);
    assert.ok(all.includes("新票接力"), all);
    assert.ok(all.includes("2 只跌停"), `同题材内跌停要写出来：${all}`);
  });

  it("延续率样本 < 3 只时标「参考意义很弱」，不许用 1 只的 0% 吓人", () => {
    const r = ignitionOf(
      topic({ tag: "PCB", series: [1, 1, 2, 1, 2], ranks: [9, 9, 6, 7, 6], top3_days: 0, active_days: 5 }),
      node({ tag: "PCB", limit_up: 2, prev_limit_up: 1, prev_still_up: 0, continuation_rate: 0,
        members: [member({ code: "301132", boards: 1 })] }),
      true,
    );
    const all = r.evidence.join(" | ");
    assert.ok(all.includes("样本只有 1 只"), all);
    assert.ok(all.includes("参考意义很弱"), all);
  });

  it("延续率高（>50%）时不加任何负面尾巴", () => {
    const r = ignitionOf(
      topic({ tag: "“羊”字辈", series: [4, 5, 4, 6, 6], ranks: [2, 1, 3, 3, 2], top3_days: 5, active_days: 5 }),
      node({ tag: "“羊”字辈", limit_up: 6, prev_limit_up: 6, prev_still_up: 4, continuation_rate: 0.667,
        members: [member({ code: "002172", boards: 3 })] }),
      true,
    );
    const all = r.evidence.join(" | ");
    assert.ok(all.includes("延续率 66.7%"), all);
    assert.ok(!all.includes("参考意义很弱"), all);
    assert.ok(!all.includes("一只都没接上"), all);
  });
});

// ─── ② 板块内龙头 ───────────────────────────────────────────────────────────────

describe("rankLeaders 板块内排龙头", () => {
  it("按「高度 → 开板次数 → 首封时间」排，不做加权", () => {
    const r = rankLeaders(node({
      tag: "X",
      members: [
        member({ code: "C", boards: 2, broken_times: 0, first_seal: "092500" }),
        member({ code: "A", boards: 3, broken_times: 2, first_seal: "102500" }),
        member({ code: "B", boards: 2, broken_times: 0, first_seal: "093000" }),
        member({ code: "D", boards: 2, broken_times: 1, first_seal: "092500" }),
      ],
    }));
    assert.deepEqual(r.map((x) => x.code), ["A", "C", "B", "D"]);
    assert.equal(r[0]!.role, "龙头");
    assert.equal(r[1]!.role, "跟风", "同高度（2 板）但不是第一 → 跟风");
  });

  it("同高度时开板次数少的排前面，其次比首封时间", () => {
    const r = rankLeaders(node({
      tag: "X",
      members: [
        member({ code: "LATE", boards: 2, broken_times: 0, first_seal: "140000" }),
        member({ code: "EARLY", boards: 2, broken_times: 0, first_seal: "092500" }),
        member({ code: "BROKEN", boards: 2, broken_times: 3, first_seal: "092500" }),
      ],
    }));
    assert.deepEqual(r.map((x) => x.code), ["EARLY", "LATE", "BROKEN"]);
  });

  it("板块只有 2 只涨停 → 独苗，理由写「仅 2 只」", () => {
    const r = rankLeaders(node({ tag: "商业航天", members: [member({ code: "603131", boards: 3 }), member({ code: "600261", boards: 2 })] }));
    assert.equal(r[0]!.role, "独苗");
    assert.ok(r[0]!.why.some((w) => w.includes("仅 2 只涨停")), r[0]!.why.join(" | "));
  });

  it("🔴 5 只涨停但全是一板 → 独苗，理由必须是「没有高度」而不是「仅 5 只涨停」", () => {
    const r = rankLeaders(node({
      tag: "三季报大增",
      members: [
        member({ code: "002365", boards: 1, first_seal: "093000" }),
        member({ code: "000716", boards: 1, first_seal: "093000" }),
        member({ code: "000417", boards: 1, first_seal: "093600" }),
        member({ code: "001287", boards: 1, first_seal: "093000", broken_times: 1 }),
        member({ code: "E", boards: 1, first_seal: "100000" }),
      ],
    }));
    assert.equal(r[0]!.role, "独苗");
    const why = r[0]!.why.join(" | ");
    assert.ok(why.includes("没有高度"), `5 只涨停时说「仅 5 只」是自相矛盾的，实际：${why}`);
    assert.ok(!why.includes("仅 5 只涨停"), "不许在 5 只涨停时写「仅 N 只涨停」");
  });

  it("1 板的非第一名算补涨，2 板以上算跟风", () => {
    const r = rankLeaders(node({
      tag: "X",
      members: [member({ code: "LEAD", boards: 5 }), member({ code: "F2", boards: 2 }), member({ code: "F1", boards: 1 })],
    }));
    assert.equal(r[0]!.role, "龙头");
    assert.equal(r[1]!.role, "跟风");
    assert.equal(r[2]!.role, "补涨");
  });

  it("最多只列 4 只（再多就不是「谁是龙头」而是「板块成分」了）", () => {
    const members = Array.from({ length: 9 }, (_, i) => member({ code: `S${i}`, boards: 9 - i }));
    assert.equal(rankLeaders(node({ tag: "X", members })).length, 4);
  });
});

// ─── ③ 交易规划 ─────────────────────────────────────────────────────────────────

const leader = (p: Partial<LeaderPick> = {}): LeaderPick => ({
  code: "001219", name: "青岛食品", boards: 5, first_seal: "093000", broken_times: 3, zt_stat: "5天5板",
  role: "龙头", why: [], quote: null,
  seal_fund_yi: null, seal_ratio: null, seal_grade: null, last_seal: null, reason_tags: [], ...p,
});

const sector = (p: Partial<SectorIgnition> = {}): SectorIgnition => ({
  tag: "三季报增长", state: "加速", today: 15, series: [], ranks: [],
  first_boards: 12, consec_boards: 3, highest: 5, broken: 0, diffusion: 0.8,
  active_days: 5, top3_days: 4, evidence: [], leaders: [], has_sector_effect: true,
  limit_down: 0,
  continuation: { prev_limit_up: 0, still_up: 0, broken_or_down: 0, rate: null },
  upstream_state: null, members_shown: 4,
  promotion: null, ...p,
});

/** 已封板：收盘价 == 涨停价 */
const SEALED = {
  price: 19.94, change_pct: 9.98, turnover_rate: 12, turnover_amount_yi: 8.2,
  float_cap_yi: 60, volume_ratio: 7.62, limit_up_price: 19.94, last_close: 18.13, to_limit_pct: 0,
};

const mkt = (p: Partial<NonNullable<OpportunityResult["market"]>> = {}): NonNullable<OpportunityResult["market"]> => ({
  phase: "退潮期", composite: 37, position_cap_pct: 20, risk_level: "high",
  can_open_position: false, gate_blockers: ["广度 15% < 55%"], ...p,
});

describe("planDraftOf 交易规划", () => {
  it("市场状态没算出来 → 一律只观察（没有仓位档位就不能谈执行）", () => {
    const p = planDraftOf(sector(), leader(), null);
    assert.equal(p.allowance, "只观察");
    assert.ok(p.allowance_note.includes("无法给仓位档位"));
  });

  it("仓位上限 0 → 不参与", () => {
    const p = planDraftOf(sector(), leader(), mkt({ position_cap_pct: 0, can_open_position: false }));
    assert.equal(p.allowance, "不参与");
    assert.ok(p.sizing.includes("不配置"));
  });

  it("上限 20% / 不能开新仓 → 只观察，并说清「这一档只够留住已有仓位」", () => {
    const p = planDraftOf(sector(), leader(), mkt());
    assert.equal(p.allowance, "只观察");
    assert.ok(p.allowance_note.includes("留"), p.allowance_note);
    assert.ok(!p.allowance_note.includes("不动手"), "20% 那一档的含义是留住已有仓位，不是「不动手」");
  });

  it("上限 60% 且 can_open_position → 可参与", () => {
    const p = planDraftOf(sector(), leader(), mkt({ phase: "主升期", composite: 82, position_cap_pct: 60, can_open_position: true, gate_blockers: [] }));
    assert.equal(p.allowance, "可参与");
  });

  it("🔴 能不能动手只看 can_open_position，这里不再自己拍 40%", () => {
    // 上限 50 但 can_open_position=false（比如风险 extreme）→ 不许「可参与」
    const p = planDraftOf(sector(), leader(), mkt({ position_cap_pct: 50, can_open_position: false }));
    assert.equal(p.allowance, "只观察");
  });

  it("🔴 已封板的票不许写「距涨停还有 0.0%」，要写「已封板」", () => {
    const p = planDraftOf(sector(), leader({ quote: SEALED }), mkt());
    assert.ok(!p.watch.some((w) => w.includes("还有 0.0%")), `已封板还说还有 0.0%：${p.watch.join(" | ")}`);
    assert.ok(p.watch.some((w) => w.includes("已封板")), p.watch.join(" | "));
  });

  it("🔴 已封板 → 触发是「再封一次」，不许同时出现「站稳收盘之上」和「向上突破即封板」", () => {
    const p = planDraftOf(sector(), leader({ quote: SEALED }), mkt());
    assert.ok(p.trigger.some((t) => t.includes("再封一次")), p.trigger.join(" | "));
    assert.ok(!p.trigger.some((t) => t.includes("站稳今日收盘")), "已封板时收盘价就是涨停价，「站稳收盘之上」是废话");
    assert.ok(!p.trigger.some((t) => t.includes("向上突破")), "已封板时「向上突破即封板」是废话");
  });

  it("已封板的失效位用涨停价，不用「收盘 -5%」", () => {
    const p = planDraftOf(sector(), leader({ quote: SEALED }), mkt());
    assert.ok(p.invalidate.some((i) => i.startsWith("收盘低于 19.94")), p.invalidate.join(" | "));
    assert.ok(!p.invalidate.some((i) => i.includes("-5%")), "今天涨停、明天 -5% 等于跌 15%，那个位子对连板票没意义");
  });

  it("未封板的票才有「距涨停还有几个点」和「突破即封板」", () => {
    const p = planDraftOf(
      sector(),
      leader({ boards: 1, quote: { ...SEALED, price: 18.5, limit_up_price: 20.35, change_pct: 2.1, to_limit_pct: 10 } }),
      mkt(),
    );
    assert.ok(p.watch.some((w) => w.includes("距涨停价 20.35 还有 10.0%")), p.watch.join(" | "));
    assert.ok(p.trigger.some((t) => t.includes("向上突破 20.35")), p.trigger.join(" | "));
  });

  it("补不到行情也不崩：价位类句子自动消失，其余照出", () => {
    const p = planDraftOf(sector(), leader({ quote: null }), mkt());
    assert.ok(p.watch.length > 0);
    assert.ok(p.trigger.length > 0);
    assert.ok(p.invalidate.length > 0);
    assert.ok(!p.watch.some((w) => w.includes("距涨停")), "没行情就不该编价位");
  });

  it("仓位建议不超过市场上限的一半（不越权放大）", () => {
    const p = planDraftOf(sector(), leader(), mkt({ position_cap_pct: 20, can_open_position: false }));
    assert.ok(p.sizing.includes("10%"), p.sizing);
  });
});

// ─── ④ 规划里的「同档反馈」────────────────────────────────────────────────────

/**
 * 这一条最容易写错的地方有三个，全是踩过的坑：
 *   ① 拿连板天梯的 `boards=N` 当同档（那是 N-1 → N，上一个档位）；
 *   ② 括号里把跌停只数写两遍（`${dist}` 里已经列过）；
 *   ③ 1~2 只的样本直接给百分比，看着像结论，实际没意义。
 */
const facts = (p: Partial<MarketFacts> = {}): MarketFacts => ({
  prev_date: "2026-10-29", sample: 47,
  seal_quality: null, loss_effect: null, by_board: [],
  tiers: [], ...p,
});

const tier = (p: Partial<TierOutcome> & { tier: string }): TierOutcome => ({
  total: 2,
  buckets: [{ label: "跌停", count: 2 }],
  promoted: 0, promotion_rate: 0, limit_down: 2, ...p,
});

describe("planDraftOf 同档反馈（唯一与龙头档位正对应的证据）", () => {
  it("龙头 3 板 → 取「3板」这一档，写明日面对的就是这个分布", () => {
    const p = planDraftOf(sector(), leader({ boards: 3 }), mkt(), facts({
      tiers: [tier({ tier: "3板", total: 2, promoted: 0, promotion_rate: 0, limit_down: 2 })],
    }));
    const line = p.watch.find((w) => w.includes("昨日「3板」"))!;
    assert.ok(line, p.watch.join(" | "));
    assert.ok(line.includes("明日走的就是这一档的分布"), line);
  });

  it("🔴 不许拿连板天梯的 boards=N 顶替：龙头 3 板就该找「3板」，不是「4板」", () => {
    const p = planDraftOf(sector(), leader({ boards: 3 }), mkt(), facts({
      tiers: [tier({ tier: "4板", total: 1, promoted: 1, promotion_rate: 1 })],
    }));
    assert.ok(!p.watch.some((w) => w.includes("昨日「4板」")), "拿了上一个档位就是错的");
    assert.ok(p.watch.some((w) => w.includes("昨日没有「3板」这一档")), p.watch.join(" | "));
  });

  it("🔴 跌停只数不写两遍（dist 里已列过，括号里只补晋级率）", () => {
    const p = planDraftOf(sector(), leader({ boards: 3 }), mkt(), facts({
      tiers: [tier({ tier: "3板", total: 2, promotion_rate: 0 })],
    }));
    const line = p.watch.find((w) => w.includes("昨日「3板」"))!;
    assert.equal(line.split("跌停").length - 1, 1, `跌停只该出现一次：${line}`);
    assert.ok(line.includes("晋级 0/2＝0%"), line);
  });

  it("样本 < 3 只 → 标「参考意义很弱」，不许把 1 只的 100% 当结论", () => {
    const p = planDraftOf(sector(), leader({ boards: 2 }), mkt(), facts({
      tiers: [tier({ tier: "2板", total: 1, buckets: [{ label: "晋级涨停", count: 1 }], promoted: 1, promotion_rate: 1, limit_down: 0 })],
    }));
    const line = p.watch.find((w) => w.includes("昨日「2板」"))!;
    assert.ok(line.includes("样本只有 1 只"), line);
  });

  it("样本 ≥ 3 只时不加「参考意义很弱」这条尾巴", () => {
    const p = planDraftOf(sector(), leader({ boards: 2 }), mkt(), facts({
      tiers: [tier({ tier: "2板", total: 6, buckets: [{ label: "跌停", count: 3 }, { label: "收红", count: 3 }], promoted: 0, promotion_rate: 0, limit_down: 3 })],
    }));
    const line = p.watch.find((w) => w.includes("昨日「2板」"))!;
    assert.ok(!line.includes("参考意义很弱"), line);
  });

  it("首板龙头走「首板」这一档（不是「1板」）", () => {
    const p = planDraftOf(sector(), leader({ boards: 1 }), mkt(), facts({
      tiers: [tier({ tier: "首板", total: 29, buckets: [{ label: "收红", count: 23 }], promoted: 6, promotion_rate: 0.207, limit_down: 0 })],
    }));
    assert.ok(p.watch.some((w) => w.includes("昨日「首板」的 29 只")), p.watch.join(" | "));
  });

  it("昨日最高只到 2 板 → 明说「没有同档分布可参考，等于在走没走过的高度」", () => {
    const p = planDraftOf(sector(), leader({ boards: 4 }), mkt(), facts({
      tiers: [tier({ tier: "首板", total: 10 }), tier({ tier: "2板", total: 3 })],
    }));
    const line = p.watch.find((w) => w.includes("昨日没有「4板」"))!;
    assert.ok(line.includes("昨日最高只到 2板"), line);
    assert.ok(line.includes("没走过的高度"), line);
  });

  it("facts 完全没取到 → 跳过这一条，不编造", () => {
    const p = planDraftOf(sector(), leader({ boards: 3 }), mkt(), null);
    assert.ok(!p.watch.some((w) => w.includes("昨日「")), p.watch.join(" | "));
  });

  it("facts 有但分档表是空的 → 也跳过，不许写「昨日最高只到 —」", () => {
    const p = planDraftOf(sector(), leader({ boards: 3 }), mkt(), facts({ tiers: [] }));
    assert.ok(!p.watch.some((w) => w.includes("昨日没有「")), p.watch.join(" | "));
  });
});

// ─── ⑤ 封板时点（cn_shortline_settled）──────────────────────────────────────────

/**
 * 这一组护两件事：
 *   ① 分档**只分三档**。四档实测中间两档方向相反（-2.3% 与 +5.3%，各 14/5 只），拆开是噪声；
 *   ② 这是**单日横截面**，文案必须自己声明，不许写成规律。
 */
const sealB = (p: Partial<SealBucket> & { label: string }): SealBucket => ({
  n: 10, still_up: 3, still_up_rate: 0.3, avg_ret: 0.5, win_rate: 0.5, deep_loss: 2, deep_loss_rate: 0.2, ...p,
});

const timing = (p: Partial<SealTiming> = {}): SealTiming => ({
  date: "2026-10-30", prev_date: "2026-10-29", sample: 39, coverage_rate: 1, partial: false,
  buckets: [
    sealB({ label: "10:00 前", n: 14, still_up: 6, still_up_rate: 0.429, avg_ret: 0.6, win_rate: 0.57, deep_loss: 6, deep_loss_rate: 0.429 }),
    sealB({ label: "10:00-14:00", n: 19, still_up: 3, still_up_rate: 0.158, avg_ret: -0.3, win_rate: 0.53, deep_loss: 5, deep_loss_rate: 0.263 }),
    sealB({ label: "14:00 后", n: 6, still_up: 0, still_up_rate: 0, avg_ret: -4.8, win_rate: 0.17, deep_loss: 3, deep_loss_rate: 0.5 }),
  ],
  trend: null,
  ...p,
});

/** 多日累计：每档都够厚（≥100 只），规划应该优先用它 */
const trend = (p: Partial<SealTrend> = {}): SealTrend => ({
  days: 20, tried: 30, from_date: "2026-09-25", to_date: "2026-10-29", sample: 780,
  buckets: [
    sealB({ label: "10:00 前", n: 312, still_up: 104, still_up_rate: 0.333, avg_ret: 0.9, win_rate: 0.55, deep_loss: 96, deep_loss_rate: 0.308 }),
    sealB({ label: "10:00-14:00", n: 358, still_up: 46, still_up_rate: 0.128, avg_ret: -0.6, win_rate: 0.47, deep_loss: 121, deep_loss_rate: 0.338 }),
    sealB({ label: "14:00 后", n: 110, still_up: 3, still_up_rate: 0.027, avg_ret: -3.1, win_rate: 0.24, deep_loss: 58, deep_loss_rate: 0.527 }),
  ],
  ...p,
});

describe("planDraftOf 封板时点（唯一一条按时点的证据）", () => {
  it("龙头 09:30 末封 → 落「10:00 前」档，并引这一档的再涨停率", () => {
    const p = planDraftOf(sector(), leader({ last_seal: "093000" }), mkt(), null, timing());
    const line = p.watch.find((w) => w.includes("今日末封 09:30"))!;
    assert.ok(line, p.watch.join(" | "));
    assert.ok(line.includes("10:00 前"), line);
    assert.ok(line.includes("14 只今天再涨停 6 只（43%）"), line);
  });

  it("末封 13:00 → 落「10:00-14:00」档；末封 14:45 → 落「14:00 后」档", () => {
    const mid = planDraftOf(sector(), leader({ last_seal: "130000" }), mkt(), null, timing());
    assert.ok(mid.watch.some((w) => w.includes("落在「10:00-14:00」")), mid.watch.join(" | "));
    const late = planDraftOf(sector(), leader({ last_seal: "144500" }), mkt(), null, timing());
    assert.ok(late.watch.some((w) => w.includes("落在「14:00 后」")), late.watch.join(" | "));
  });

  it("🔴 没有多日回溯时必须声明「单日横截面」—— 一个交易日的 39 只撑不起因果结论", () => {
    const p = planDraftOf(sector(), leader({ last_seal: "093000" }), mkt(), null, timing());
    const line = p.watch.find((w) => w.includes("今日末封"))!;
    assert.ok(line.includes("单日横截面"), line);
    assert.ok(line.includes("不是规律"), line);
    assert.ok(line.includes("多日回溯没拿到"), "要说清为什么只有单日：" + line);
  });

  it("档位样本 < 10 只时额外标出来（14:00 后只有 6 只）", () => {
    const p = planDraftOf(sector(), leader({ last_seal: "144500" }), mkt(), null, timing());
    const line = p.watch.find((w) => w.includes("今日末封"))!;
    assert.ok(line.includes("这一档只有 6 只"), line);
    const big = planDraftOf(sector(), leader({ last_seal: "093000" }), mkt(), null, timing());
    assert.ok(!big.watch.find((w) => w.includes("今日末封"))!.includes("这一档只有"), "14 只不该标小样本");
  });

  it("末封时间取不到（ladder 没给）→ 跳过这一条，不拿首封冒充", () => {
    const p = planDraftOf(sector(), leader({ last_seal: null, first_seal: "093000" }), mkt(), null, timing());
    assert.ok(!p.watch.some((w) => w.includes("今日末封")), p.watch.join(" | "));
  });

  it("有分档表但没有同时段的样本 → 明说没得比，且列出昨日各档只数", () => {
    const p = planDraftOf(sector(), leader({ last_seal: "144500" }), mkt(), null, timing({
      buckets: [sealB({ label: "10:00 前", n: 14 })],
    }));
    const line = p.watch.find((w) => w.includes("今日末封"))!;
    assert.ok(line.includes("没有落在同一时段"), line);
    assert.ok(line.includes("10:00 前 14 只"), line);
    assert.ok(!line.includes("再涨停"), "没样本就不许给比例");
  });

  it("seal_timing 没取到 → 整条跳过", () => {
    const p = planDraftOf(sector(), leader({ last_seal: "093000" }), mkt(), null, null);
    assert.ok(!p.watch.some((w) => w.includes("今日末封")), p.watch.join(" | "));
  });

  it("🔴 有多日回溯时优先用它，并写明「近 N 个交易日」和多日累计口径", () => {
    const p = planDraftOf(sector(), leader({ last_seal: "093000" }), mkt(), null, timing({ trend: trend() }));
    const line = p.watch.find((w) => w.includes("今日末封"))!;
    assert.ok(line.includes("近 20 个交易日"), line);
    assert.ok(line.includes("312 只"), "要给出这一档累计样本量：" + line);
    assert.ok(line.includes("33%"), line);
    assert.ok(line.includes("多日累计"), line);
    assert.ok(line.includes("不是预测"), "统计口径也要声明：" + line);
  });

  it("多日累计的数字和单日不同时，取的是多日（单日的 43% 不该再出现）", () => {
    const p = planDraftOf(sector(), leader({ last_seal: "093000" }), mkt(), null, timing({ trend: trend() }));
    const line = p.watch.find((w) => w.includes("今日末封"))!;
    assert.ok(!line.includes("43%"), `这是单日的数，不该出现在多日文案里：${line}`);
  });

  it("多日样本太薄（每档 <100 只）→ 退回单日，不假装有统计意义", () => {
    const thin = trend({ buckets: [sealB({ label: "10:00 前", n: 12, still_up: 4, still_up_rate: 0.333 })] });
    const p = planDraftOf(sector(), leader({ last_seal: "093000" }), mkt(), null, timing({ trend: thin }));
    const line = p.watch.find((w) => w.includes("今日末封"))!;
    assert.ok(line.includes("昨日同档"), line);
    assert.ok(!line.includes("近 20 个交易日"), "样本不够就不该摆出多日的架子");
  });

  it("多日里有这一档、单日里没有 → 用多日的（别因为单日缺就整条跳过）", () => {
    const onlyLate = trend({ buckets: [sealB({ label: "14:00 后", n: 110, still_up: 3, still_up_rate: 0.027 })] });
    const p = planDraftOf(sector(), leader({ last_seal: "144500" }), mkt(), null, timing({ trend: onlyLate }));
    assert.ok(p.watch.some((w) => w.includes("落在「14:00 后」")), p.watch.join(" | "));
  });

  it("和「同档反馈」是两条正交的线：同时给 facts 与 timing，两条都在", () => {
    const p = planDraftOf(sector(), leader({ boards: 3, last_seal: "093000" }), mkt(),
      facts({ tiers: [tier({ tier: "3板", total: 2, promoted: 0, promotion_rate: 0, limit_down: 2 })] }), timing());
    assert.ok(p.watch.some((w) => w.includes("昨日「3板」")), "按高度那条");
    assert.ok(p.watch.some((w) => w.includes("今日末封")), "按时点那条");
  });
});

/**
 * 封单厚度分档的阈值不是拍的，是 14 个交易日回溯出来的（>1.5% → 次日再涨停 42%，≤1.5% → 15%，按日配对 14/14 一致）。
 * 阈值一旦被随手改掉，页面上那句「软档只有 15%」就变成假话，所以钉在这里。
 */
describe("sealGradeOf 封单厚度分档", () => {
  it("1.5% 与 3% 是两个分界，边界值归上档", () => {
    assert.equal(sealGradeOf(4.4), "硬");
    assert.equal(sealGradeOf(SEAL_GRADE_CUT.hard), "硬", "刚好 3% 算硬");
    assert.equal(sealGradeOf(2.9), "中");
    assert.equal(sealGradeOf(SEAL_GRADE_CUT.mid), "中", "刚好 1.5% 算中");
    assert.equal(sealGradeOf(1.4), "软");
    assert.equal(sealGradeOf(0), "软");
  });

  it("null 返回 null，不能当成「软」", () => {
    assert.equal(sealGradeOf(null), null, "没取到封单 != 封得软，这两个不能混");
  });
});

/**
 * 快照时效：**不许再出现「一次写入、永久命中」。**
 *
 * 2026-11-06 的事故：`DEFAULT_CONSISTENCY` 是 `{mode:"prefer_cache"}`，不带 `max_age_ms`；
 * `snapshotUsable` 在「一个上限都没有」时直接 `return true`。而快照键只由「端点+参数」决定、
 * 不含日期 —— 于是 `cn_shortline_themes{top:12}` 自 **10-30** 起再没换过，页面上
 * 「三季报增长 15 只 / 最高 5 板 / 龙头青岛食品封单 0.57 亿」摆了整整 7 天，
 * 而同屏的「涨停 26 / 炸板 11」是当天实时。`?refresh=1` 当时也被丢掉，按刷新也救不回来。
 */
describe("机会链与板块宽度的快照时效", () => {
  /** 两个视图实际会打的端点，漏写一条就等于给它开了一张「永不过期」的通行证 */
  const USED = [
    // 机会发现（opportunity_scan）
    "cn_shortline_themes",
    "cn_shortline_theme_rotation",
    "cn_shortline_board_ladder",
    "cn_shortline_cycle",
    "cn_shortline_facts",
    "cn_shortline_settled",
    "cn_shortline_live",
    "sina_board_flow",
    // 板块宽度（day_opportunity）
    "tx_quotes_batch",
    "index_constituents",
  ];

  it("机会链用到的每个端点都要有显式上限", () => {
    for (const id of USED) {
      const v = SNAPSHOT_MAX_AGE_MS[id];
      assert.equal(typeof v, "number", `${id} 没在 SNAPSHOT_MAX_AGE_MS 里 —— 会退化成永久命中`);
      assert.ok(Number.isFinite(v) && v > 0, `${id} 的上限必须是有穷正数，不许写 Infinity 图省事`);
    }
  });

  it("上限不许超过 12 小时：再长就等于「跨交易日也不换」", () => {
    const TWELVE_HOURS = 12 * 3600_000;
    for (const [id, v] of Object.entries(SNAPSHOT_MAX_AGE_MS) as [string, number][]) {
      assert.ok(v <= TWELVE_HOURS, `${id} 给了 ${v}ms，超过 12 小时就意味着隔夜不重取`);
    }
  });

  it("7 天前的快照在每个上限下都必须判过期（这是 10-30 那次的最小复现）", () => {
    const old = {
      schema: 1, key: "k", endpoint: "x", symbol: "",
      fetched_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      payload: {},
    };
    for (const id of USED) {
      const c = { mode: "prefer_cache" as const, max_age_ms: SNAPSHOT_MAX_AGE_MS[id] };
      assert.equal(snapshotUsable(old, c), false, `${id}：7 天前的快照还被判成「可用」`);
    }
    // 兜底档同理：表里没写的端点也不许把旧件当新件
    assert.equal(snapshotUsable(old, { mode: "prefer_cache", max_age_ms: SNAPSHOT_FALLBACK_MAX_AGE_MS }), false);
  });

  it("刚取到的快照仍然要命中缓存 —— 修的只是「永不重取」，不是把缓存关掉", () => {
    const fresh = {
      schema: 1, key: "k", endpoint: "x", symbol: "",
      fetched_at: new Date().toISOString(), payload: {},
    };
    for (const id of USED) {
      const c = { mode: "prefer_cache" as const, max_age_ms: SNAPSHOT_MAX_AGE_MS[id] };
      assert.equal(snapshotUsable(fresh, c), true, `${id}：刚取回来的快照不该再打一次上游`);
    }
  });
});

/**
 * `?refresh=1` 必须真取，未知端点不许「没有上限」。
 * 这两条是同一个事故的两半：视图动作的 body 参数曾写作 `_body`、从没被读过（刷新无效），
 * 而端点没有时效上限（缓存永不失效），两条加起来就是「点刷新也只换回同一份」。
 */
describe("consistencyFor / wantsFresh", () => {
  it("表单里的 refresh 认四种写法，其余一律当没点", () => {
    for (const v of ["1", 1, true, "true"]) assert.equal(wantsFresh(v), true, `${String(v)} 应认`);
    for (const v of ["0", 0, false, "", undefined, null, "yes"]) assert.equal(wantsFresh(v), false, `${String(v)} 不该认`);
  });

  it("点了刷新 → fresh，不看时效", () => {
    assert.deepEqual(consistencyFor("cn_shortline_themes", true), { mode: "fresh" });
    assert.deepEqual(consistencyFor("某个没人登记过的端点", true), { mode: "fresh" });
  });

  it("没点刷新 → prefer_cache + 有穷上限，未知端点走兜底而不是「不限」", () => {
    const listed = consistencyFor("cn_shortline_live");
    assert.equal(listed.mode, "prefer_cache");
    assert.equal((listed as { max_age_ms?: number }).max_age_ms, SNAPSHOT_MAX_AGE_MS.cn_shortline_live);

    const unknown = consistencyFor("某个没人登记过的端点");
    assert.equal(unknown.mode, "prefer_cache");
    assert.equal((unknown as { max_age_ms?: number }).max_age_ms, SNAPSHOT_FALLBACK_MAX_AGE_MS,
      "未知端点必须落到兜底上限 —— 缺省成「无上限」就是下一次 10-30");
  });

  it("Core 缺省也不许是「不限」，且与 finance 兜底同源", () => {
    assert.equal(DEFAULT_CONSISTENCY.mode, "prefer_cache");
    assert.equal((DEFAULT_CONSISTENCY as { max_age_ms?: number }).max_age_ms, DEFAULT_PREFER_CACHE_MAX_AGE_MS);
    assert.equal(SNAPSHOT_FALLBACK_MAX_AGE_MS, DEFAULT_PREFER_CACHE_MAX_AGE_MS, "两套兜底不许再分叉");
  });
});
