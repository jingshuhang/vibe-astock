/**
 * 交易计划视图(闭环前半球)的回归锁。
 *
 * 这一屏是新增的,此前没有任何测试守护(只靠 tsc + 手跑 live 兜着)。
 * 这里覆盖:
 *   1. 纯函数:planOf / lifecycleOf / gapsOf(不依赖台账,确定性)
 *   2. computePlans:空账本 / 关联成交后的事后对照 / 同代码候选轮次 / 过期推导
 *
 * 设计口径(见 plans.ts):只做客观计算,不替用户排序、不给建议;排序按写下顺序,分组按客观状态。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { LedgerRecord } from "../src/ledger.ts";
import { ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { journalAct } from "../src/finance/journal/view.ts";
import { computePlans, gapsOf, lifecycleOf, planOf, type TradePlan } from "../src/finance/plans.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function withRoot(fn: (ctx: ServiceContext) => Promise<void>) {
  return async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-plans-"));
    try {
      await fn({ repoRoot: REPO, dataRoot, python: "false", node: process.execPath });
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  };
}

const NOW = new Date("2026-10-09T06:00:00Z"); // 北京时间 14:00
const sig = new AbortController().signal;

const rec = (o: Record<string, unknown>): LedgerRecord => o as LedgerRecord;

// ─── 纯函数 ────────────────────────────────────────────────────────────────────

test("planOf:字段规整 + 缺省与非法值兜底", () => {
  const p = planOf(rec({
    id: "p1", symbol: "600519", name: "贵州茅台",
    playbook: "打板", thesis: "回踩不破",
    planned_entry: 1500, planned_stop: 14, planned_target: 1700, position_pct: 10,
    watch: [1, "涨破", "", "回踩"], next_check: "14:00", due: "2026-10-09",
    valid_until: "2026-10-20", status: "planned", round_ref: "t1", note: "首板",
    created_at: "2026-10-01T10:00:00.000Z", updated_at: "2026-10-01T10:00:00.000Z",
  }));
  assert.equal(p.id, "p1");
  assert.equal(p.symbol, "600519");
  assert.equal(p.planned_entry, 1500);
  assert.equal(p.planned_stop, 14);
  assert.deepEqual(p.watch, ["涨破", "回踩"]); // 非字符串与空串过滤掉
  assert.equal(p.status, "planned");
  assert.equal(p.round_ref, "t1");

  // 缺省 status → planned;非法 status → planned;非法的 playbook → null
  const d = planOf(rec({ id: "p2", symbol: "000001" }));
  assert.equal(d.status, "planned");
  assert.equal(d.playbook, null);
  assert.equal(d.planned_entry, null);
  assert.deepEqual(d.watch, []);

  const bad = planOf(rec({ id: "p3", symbol: "000001", status: "weird", playbook: "不是真打法" }));
  assert.equal(bad.status, "planned");
  assert.equal(bad.playbook, null);
});

test("lifecycleOf:executed/abandoned 直接返回;planned 看有效期是否过了今天", () => {
  const base: TradePlan = planOf(rec({ id: "p", symbol: "600519", valid_until: "2026-10-08" }));
  assert.equal(lifecycleOf({ ...base, status: "executed" }, "2026-10-09"), "executed");
  assert.equal(lifecycleOf({ ...base, status: "abandoned" }, "2026-10-09"), "abandoned");
  // 有效期 < 今天 → 过期(只推导不入库)
  assert.equal(lifecycleOf({ ...base, status: "planned", valid_until: "2026-10-08" }, "2026-10-09"), "expired");
  // 有效期 == 今天 / 在未来 → 仍待执行
  assert.equal(lifecycleOf({ ...base, status: "planned", valid_until: "2026-10-09" }, "2026-10-09"), "planned");
  assert.equal(lifecycleOf({ ...base, status: "planned", valid_until: "2026-10-20" }, "2026-10-09"), "planned");
  // 没写有效期 → 待执行
  assert.equal(lifecycleOf({ ...base, status: "planned", valid_until: "" }, "2026-10-09"), "planned");
});

test("gapsOf:买入前应问的四项,缺哪项标哪项", () => {
  const full = planOf(rec({
    id: "p", symbol: "600519", planned_entry: 1500, planned_stop: 14, planned_target: 1700,
    position_pct: 10, thesis: "理由",
  }));
  assert.deepEqual(gapsOf(full), []); // 四项齐 → 空

  const noStop = planOf(rec({ id: "p", symbol: "600519", planned_entry: 1500, planned_target: 1700, position_pct: 10, thesis: "理由" }));
  assert.deepEqual(gapsOf(noStop), [{ key: "no_stop", text: "没写计划止损 —— 最坏情况无从估计" }]);

  const noLevels = planOf(rec({ id: "p", symbol: "600519", planned_stop: 14, position_pct: 10, thesis: "理由" }));
  assert.deepEqual(gapsOf(noLevels).map((g) => g.key), ["no_levels"]);

  const noSize = planOf(rec({ id: "p", symbol: "600519", planned_entry: 1500, planned_stop: 14, planned_target: 1700, thesis: "理由" }));
  assert.deepEqual(gapsOf(noSize).map((g) => g.key), ["no_size"]);

  const noThesis = planOf(rec({ id: "p", symbol: "600519", planned_entry: 1500, planned_stop: 14, planned_target: 1700, position_pct: 10 }));
  assert.deepEqual(gapsOf(noThesis).map((g) => g.key), ["no_thesis"]);
});

// ─── computePlans 集成 ──────────────────────────────────────────────────────────

test("空账本:能打开,计划为空,日期正确", withRoot(async (ctx) => {
  const r = computePlans(ctx, NOW);
  assert.equal(r.available, true);
  assert.deepEqual(r.plans, []);
  assert.equal(r.day, "2026-10-09");
  assert.equal(r.hm, "14:00");
  assert.equal(r.open_count, 0);
  assert.equal(r.linked_count, 0);
  assert.equal(r.due_count, 0);
  assert.equal(r.expired_count, 0);
}));

test("关联成交后:事后对照拿到首笔成交价与追高幅度,四项齐了不计缺项", withRoot(async (ctx) => {
  // 先记一笔成交(买入 @1550),journalAct 会切轮并回传 trade_ids
  const out = await journalAct(ctx, {
    action: "record", symbol: "600519", name: "贵州茅台",
    fills: [{ type: "buy", date: "2026-10-09", shares: 1000, price: 1550, fee: 5 }],
    playbook: "打板", as_planned: true, planned_stop: 14, note: "首板",
  }, sig, NOW);
  const tradeIds = (out.result as { trade_ids: string[] }).trade_ids;
  assert.ok(tradeIds.length >= 1);

  // 计划用 round_ref 认领那一笔(计划页「关联这笔交易」就是写这个)
  ledgerUpsert(ctx, {
    kind: "trade_plan",
    record: {
      symbol: "600519", thesis: "回踩不破",
      planned_entry: 1500, planned_stop: 14, planned_target: 1700, position_pct: 10,
      due: "2026-10-09", next_check: "14:00", valid_until: "2026-10-20",
      status: "planned", round_ref: tradeIds[0],
    },
  });

  const r = computePlans(ctx, NOW);
  assert.equal(r.plans.length, 1);
  const v = r.plans[0]!;
  assert.equal(v.lifecycle, "planned");
  assert.equal(v.due_today, true);          // due == 今天
  assert.equal(v.check_arrived, true);       // 14:00 >= 14:00
  assert.deepEqual(v.gaps, []);              // 四项都写了

  assert.ok(v.execution, "关联到了那一轮 → 有事后对照");
  assert.equal(v.execution!.first_price, 1550);
  assert.equal(v.execution!.avg_cost, 1550);
  assert.equal(v.execution!.closed, false);
  assert.equal(v.execution!.realized_pnl_pct, null);
  assert.equal(v.execution!.entry_gap_pct, 3.3); // (1550-1500)/1500*100,四舍五入 1 位

  assert.deepEqual(v.candidates, []);        // 已关联 → 不再列候选

  assert.equal(r.open_count, 1);
  assert.equal(r.linked_count, 1);
  assert.equal(r.due_count, 1);
}));

test("没关联但同代码有成交:列出候选轮次,让用户自己挂", withRoot(async (ctx) => {
  const out = await journalAct(ctx, {
    action: "record", symbol: "600519", name: "贵州茅台",
    fills: [{ type: "buy", date: "2026-10-09", shares: 1000, price: 1550, fee: 5 }],
    playbook: "打板", as_planned: true, planned_stop: 14, note: "首板",
  }, sig, NOW);
  const tradeIds = (out.result as { trade_ids: string[] }).trade_ids;

  // 计划不写 round_ref,也不在标注上写 plan_id → 未关联
  ledgerUpsert(ctx, {
    kind: "trade_plan",
    record: {
      symbol: "600519", thesis: "回踩不破",
      planned_entry: 1500, planned_stop: 14, planned_target: 1700, position_pct: 10,
      due: "2026-10-09", next_check: "14:00", valid_until: "2026-10-20",
      status: "planned",
    },
  });

  const r = computePlans(ctx, NOW);
  const v = r.plans[0]!;
  assert.equal(v.execution, null);
  assert.equal(v.candidates.length, 1, "同代码、未认领的那一轮应作为候选出现");
  assert.equal(v.candidates[0]!.round_key, tradeIds[0]);
  assert.equal(v.candidates[0]!.first_price, 1550);
  assert.equal(r.linked_count, 0);
}));

test("有效期过了还没成交:推导为过期,不计入待执行", withRoot(async (ctx) => {
  ledgerUpsert(ctx, {
    kind: "trade_plan",
    record: {
      symbol: "600519", thesis: "理由",
      planned_entry: 1500, planned_stop: 14, planned_target: 1700, position_pct: 10,
      due: "2026-10-01", next_check: "09:00", valid_until: "2026-10-08",
      status: "planned",
    },
  });

  const r = computePlans(ctx, NOW);
  const v = r.plans[0]!;
  assert.equal(v.lifecycle, "expired");
  assert.equal(v.due_today, false);
  assert.equal(r.expired_count, 1);
  assert.equal(r.open_count, 0);
}));
