import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { detectPython } from "../src/init.ts";
import { analyzeStock, reconcileStage, type MoneyView } from "../src/finance/stock_analysis.ts";
import type { ServiceContext } from "../src/service.ts";

/**
 * 个股分析(本地规则引擎)。这个模块此前**一条测试都没有**,而它会给出结论。
 *
 * 🔴 钉住四件事:
 *   ① 「刷新」必须真取:不传 refresh 时命中快照、不重复取数;传了就一定重取;
 *   ② 估值分位来自全表行,亏损期(PE<0)要剔掉,否则分位会失真;
 *   ③ 样本不足时**不给阶段结论**(不是给 50 分 + 挂一行小字);
 *   ④ 取不到的域写明缺口、返回 null,不算成 0;basic 层不去碰慢端点。
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";

/** 假取数器:按 cfg.endpoints 出证据;每次调用把端点名追加进 cfg.count 指向的文件(用来数取了几次) */
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json',encoding='utf-8'))
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
with open(cfg['count'],'a',encoding='utf-8') as f: f.write(ep+'\n')
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
spec=cfg['endpoints'].get(ep)
if spec is None: done({'status':'failed','reason':'夹具里没给这个端点','evidence':[]},3)
if spec.get('failed'): done({'status':'failed','reason':spec['failed'],'evidence':[]},3)
evs=[]
ref=None
series=spec.get('series')
if series is not None:
  ref='raw/extracted_%s.json'%ep
  json.dump({'rows':series},open(os.path.join(out,ref),'w',encoding='utf-8'))
# 原始响应就是顶层数组的那种(新浪资金流):不规整成 rows,数字还是字符串
rawarr=spec.get('raw_array')
if rawarr is not None:
  ref='raw/%s_raw.json'%ep
  json.dump(rawarr,open(os.path.join(out,ref),'w',encoding='utf-8'))
for e in spec.get('evidence',[]):
  row=dict(e)
  if ref: row['raw_ref']=ref
  evs.append(row)
done({'status':'ok','extra':{'settled':True},'evidence':evs})
`;

interface Cfg { endpoints: Record<string, unknown> }

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; count(): number; cleanup(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-stockanalysis-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  const counter = path.join(repo, "count.log");
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify({ ...c, count: counter })),
    count: () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0),
    cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

const DAY = 86_400_000;
const iso = (n: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

/** 120 根日 K:收盘价从 10 涨到 12,量能从 1000 微升 */
const BARS = Array.from({ length: 120 }, (_, i) => ({
  date: iso(i), open: 10 + i / 100, high: 10.2 + i / 100, low: 9.9 + i / 100, close: 10 + i / 100, volume: 1000 + i,
}));

/** 100 天估值序列:PE 从 1 涨到 100;另塞一条亏损期(PE=-5)与一条停牌行,看它们是否被剔掉 */
const VAL_SERIES = [
  ...Array.from({ length: 100 }, (_, i) => ({ date: iso(i), close: 10, peTTM: i + 1, pbMRQ: 2, psTTM: 3, tradestatus: "1", isST: "0" })),
  { date: iso(200), close: 10, peTTM: -5, pbMRQ: 2, psTTM: 3, tradestatus: "1", isST: "0" },
  { date: iso(201), close: 10, peTTM: 60, pbMRQ: 2, psTTM: 3, tradestatus: "0", isST: "0" },
];

const chipNote = "窗口 168 个交易日,累计换手 53.0%,前复权,decay=1.0;三角分布 + 换手衰减模型(非交易所数据)";

/**
 * 60 天日级主力净流入(新→旧倒着看):
 * 最近 3 天各 +1 亿,再往前 17 天各 -1000 万,更早 40 天各 +5000 万。
 * ⇒ 5 日 +2.8 亿 / 20 日 +1.3 亿(同向为正)、连续 3 日净流入、超大单 5 日 +2.3 亿。
 * 🔴 值故意用**字符串**(新浪源就是字符串),numLoose 没写对这条就会全变 null。
 */
const moneyRow = (i: number) => {
  const net = i >= 57 ? 1e8 : i >= 40 ? -1e7 : 5e7;
  const r0 = i >= 57 ? 8e7 : i >= 40 ? -5e6 : 4e7;
  return { opendate: iso(i), netamount: net.toFixed(4), r0_net: r0.toFixed(4), trade: "10.0000", turnover: "1.0" };
};
const MONEY = Array.from({ length: 60 }, (_, i) => moneyRow(i));

const BASE = (): Cfg => ({
  endpoints: {
    tx_kline: { series: BARS, evidence: [{ id: "ev-k1", field: "kline_points", value: BARS.length, period: iso(119) }] },
    sina_fund_flow: {
      raw_array: MONEY,
      evidence: [
        { id: "ev-m1", field: "fund_net_inflow_daily_latest", value: 1e8, unit: "元", period: iso(59) },
        { id: "ev-m2", field: "fund_net_inflow_daily_points", value: MONEY.length, unit: "条", period: `${iso(0)}..${iso(59)}` },
      ],
    },
    tx_quotes_batch: {
      evidence: [
        { id: "ev-q1", field: "security_name", value: "测试股", unit: "text", period: iso(119), record_key: "sh600519" },
        { id: "ev-q2", field: "price", value: 11.19, unit: "元", period: iso(119), record_key: "sh600519" },
        { id: "ev-q3", field: "change_pct", value: 1.2, unit: "%", period: iso(119), record_key: "sh600519" },
        { id: "ev-q4", field: "turnover_rate", value: 2.5, unit: "%", period: iso(119), record_key: "sh600519" },
        { id: "ev-q5", field: "pe_ttm", value: 18, unit: "倍", period: iso(119), record_key: "sh600519" },
      ],
    },
    bs_valuation_history: {
      series: VAL_SERIES,
      evidence: [
        { id: "ev-v1", field: "pe_ttm_latest", value: 100, unit: "倍", period: iso(99), as_of: iso(99) },
        { id: "ev-v2", field: "pe_ttm_points", value: VAL_SERIES.length, unit: "条", period: `${iso(0)}..${iso(99)}` },
        { id: "ev-v3", field: "pb_mrq_latest", value: 2, unit: "倍", period: iso(99), as_of: iso(99) },
      ],
    },
    bs_chip_distribution: {
      evidence: [
        { id: "ev-c1", field: "chip_profit_ratio", value: 0.37, unit: "小数", period: `${iso(0)}..${iso(99)}`, note: chipNote },
        { id: "ev-c2", field: "chip_avg_cost", value: 10, unit: "元", period: `${iso(0)}..${iso(99)}`, note: chipNote },
        { id: "ev-c3", field: "chip_price_ref", value: 11, unit: "元", period: `${iso(0)}..${iso(99)}` },
        { id: "ev-c4", field: "chip_concentration_90", value: 0.09, unit: "小数", period: `${iso(0)}..${iso(99)}`, note: chipNote },
        { id: "ev-c5", field: "chip_cost_90_low", value: 9, unit: "元", period: `${iso(0)}..${iso(99)}` },
        { id: "ev-c6", field: "chip_cost_90_high", value: 11, unit: "元", period: `${iso(0)}..${iso(99)}` },
      ],
    },
    em_holder_num: {
      evidence: [
        { id: "ev-h1", field: "shareholder_count", value: 278364, unit: "户", period: "2026-09-30", record_key: "2026-09-30" },
        { id: "ev-h2", field: "shareholder_count_change_pct", value: -6.09, unit: "%", period: "2026-09-30", record_key: "2026-09-30" },
      ],
    },
  },
});

/** full 层才会取的那几个 */
const EVENTS: Record<string, unknown> = {
  equity_pledge: {
    evidence: [
      { id: "ev-p0", field: "pledge_snapshot_count", value: 609, unit: "期", period: "2014-03-07..2026-10-30" },
      { id: "ev-p1", field: "pledge_ratio", value: 0.07, unit: "%", period: "2026-10-30", record_key: "600519:2026-10-30" },
      { id: "ev-p2", field: "pledge_ratio", value: 0.5, unit: "%", period: "2026-10-23", record_key: "600519:2026-10-23" },
    ],
  },
  em_lockup_expiry: {
    evidence: [{ id: "ev-l1", field: "lockup_upcoming_count", value: 0, unit: "批", period: "2026-11-01..2027-01-30" }],
  },
  em_block_trade: {
    evidence: [
      { id: "ev-b0", field: "block_trade_count", value: 20, unit: "笔", period: "2026-01-01..2026-10-30" },
      { id: "ev-b1", field: "block_trade_price", value: 1354, unit: "元", period: "2026-10-29", record_key: "2026-10-29|0|甲|乙" },
      { id: "ev-b2", field: "block_trade_premium_pct", value: -3.2, unit: "%", period: "2026-10-29", record_key: "2026-10-29|0|甲|乙" },
      { id: "ev-b2a", field: "block_trade_amount", value: 18685200, unit: "元", period: "2026-10-29", record_key: "2026-10-29|0|甲|乙" },
      { id: "ev-b3", field: "block_trade_price", value: 1300, unit: "元", period: "2026-10-20", record_key: "2026-10-20|1|丙|丁" },
      { id: "ev-b4", field: "block_trade_premium_pct", value: 1.1, unit: "%", period: "2026-10-20", record_key: "2026-10-20|1|丙|丁" },
    ],
  },
  holder_trades: {
    evidence: [
      { id: "ev-t0", field: "holder_trade_count", value: 13, unit: "条", period: "2010-05-08..2025-12-30" },
      { id: "ev-t1", field: "holder_change_pct_total", value: 0.1017, unit: "%", period: "2025-12-30", record_key: "600519:集团:2025", note: "集团;增持;二级市场;2025-10-21~2025-12-26" },
      { id: "ev-t2", field: "holder_change_pct_total", value: 0.2, unit: "%", period: "2025-11-06", record_key: "600519:集团:2025b", note: "集团;减持;二级市场;2025-09-02~2025-10-20" },
    ],
  },
};

test("刷新真的刷新:不传 refresh 命中快照不重取,传了就全部重取", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(BASE());
    const first = await analyzeStock(ctx, "600519");
    const n1 = ctx.count();
    assert.equal(n1, 6, "basic 层取 6 个端点(日K/行情/资金流/估值/筹码/户数)");
    assert.equal(first.from_cache, false);

    const second = await analyzeStock(ctx, "600519");
    assert.equal(ctx.count(), n1, "第二次全命中快照,不该再取数");
    assert.equal(second.from_cache, true, "读的是快照就要标明");

    const third = await analyzeStock(ctx, "600519", { refresh: true });
    assert.equal(ctx.count(), n1 * 2, "refresh=true 必须全部重取");
    assert.equal(third.from_cache, false);
  } finally { ctx.cleanup(); }
});

test("估值分位来自全表行:亏损期(PE<0)与停牌日都剔掉", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(BASE());
    const r = await analyzeStock(ctx, "600519");
    const v = r.valuation!;
    assert.equal(v.pe_ttm, 100);
    assert.equal(v.window.n, 101, "121 条里剔掉 1 条停牌行");
    // 100 个有效样本里 99 个低于 100 ⇒ 0.99;-5 那条若混进来会变成 99/101
    assert.equal(v.pe_percentile, 0.99);
    assert.match(v.basis, /过去 101 个交易日/);
    assert.match(v.note, /baostock/);
  } finally { ctx.cleanup(); }
});

test("筹码:带数据日与口径,算出现价相对平均成本", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(BASE());
    const chips = (await analyzeStock(ctx, "600519")).chips!;
    assert.equal(chips.profit_ratio, 0.37);
    assert.equal(chips.avg_cost, 10);
    assert.equal(chips.above_avg_cost, 10, "参照价 11 / 平均成本 10 ⇒ +10%");
    assert.deepEqual(chips.cost_90, [9, 11]);
    assert.match(chips.note, /非交易所数据/, "模型推算的口径必须跟着数一起走");
    assert.equal(chips.window.n, 168);
  } finally { ctx.cleanup(); }
});

test("样本不足:不给阶段结论,也不给总分(不是给 50 分凑数)", async () => {
  const ctx = fakeCtx();
  try {
    const cfg = BASE();
    (cfg.endpoints.tx_kline as { series: unknown[] }).series = BARS.slice(-20);
    ctx.setCfg(cfg);
    const r = await analyzeStock(ctx, "600519");
    assert.equal(r.sufficient, false);
    assert.equal(r.composite, null);
    assert.equal(r.main_capital.stage, "数据不足");
    assert.equal(r.main_capital.score, null);
    assert.match(r.main_capital.factors[0]!, /日 K 只有 20 根/);
  } finally { ctx.cleanup(); }
});

test("取不到的域:写明缺口并返回 null,不算成 0", async () => {
  const ctx = fakeCtx();
  try {
    const cfg = BASE();
    cfg.endpoints.bs_chip_distribution = { failed: "东财池为空" };
    cfg.endpoints.bs_valuation_history = { failed: "baostock 超时" };
    ctx.setCfg(cfg);
    const r = await analyzeStock(ctx, "600519");
    assert.equal(r.chips, null);
    assert.equal(r.valuation, null);
    assert.ok(r.gaps.some((g) => /筹码分布没取到\(东财池为空\)/.test(g)), r.gaps.join(" / "));
    assert.ok(r.gaps.some((g) => /估值历史没取到\(baostock 超时\)/.test(g)), r.gaps.join(" / "));
    // 日 K 与行情都在 ⇒ 仍然给结论,不因为别的域缺就把整份判成无效
    assert.equal(r.sufficient, true);
    assert.notEqual(r.composite, null);
  } finally { ctx.cleanup(); }
});

test("basic 层不去碰慢端点;full 层才取质押/解禁/大宗/增减持", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ endpoints: { ...BASE().endpoints, ...EVENTS } });
    const basic = await analyzeStock(ctx, "600519");
    assert.equal(basic.depth, "basic");
    assert.equal(ctx.count(), 6, "basic 只有 6 个端点");
    assert.equal(basic.holders!.pledge_ratio, null);
    assert.equal(basic.holders!.shareholder_count, 278364);

    const full = await analyzeStock(ctx, "600519", { depth: "full", refresh: true });
    assert.equal(full.depth, "full");
    assert.equal(ctx.count(), 6 + 4 + 6, "full 再多取 4 个端点(另计那次 basic 的 6 次)");
    const h = full.holders!;
    assert.equal(h.pledge_ratio, 0.07, "取最新一期质押比例");
    assert.equal(h.pledge_as_of, "2026-10-30");
    assert.equal(h.lockup_upcoming, 0, "0 批是确切结论,不是没取到");
    assert.equal(h.block_trade_count, 20);
    assert.equal(h.block_trade_latest!.date, "2026-10-29");
    assert.equal(h.block_trade_latest!.premium_pct, -3.2);
    assert.equal(h.block_trade_latest!.amount, 18685200, "金额按元(上游单位已核,不再是万字头)");
    assert.equal(h.holder_trade_latest!.direction, "增持");
    assert.equal(h.holder_trade_latest!.date, "2025-12-30");
  } finally { ctx.cleanup(); }
});

test("资金流:从原始数组算 5/20 日累计与连续天数(数字是字符串,不能当 0)", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(BASE());
    const m = (await analyzeStock(ctx, "600519")).money!;
    assert.ok(m, "资金流是 basic 层的主证据,不该为 null");
    assert.equal(m.window.n, 60);
    assert.equal(m.as_of, iso(59));
    assert.equal(m.net_1d, 1e8);
    assert.equal(m.net_5d, 2.8e8, "3×1 亿 + 2×(-1000 万)");
    assert.equal(m.net_20d, 1.3e8, "3×1 亿 + 17×(-1000 万)");
    assert.equal(m.big_order_5d, 2.3e8, "超大单 5 日:3×8000 万 - 2×500 万");
    assert.equal(m.streak, 3, "第 4 天是净流出,连续链断在这里");
    assert.equal(m.trend, "净流入");
    assert.match(m.note, /netamount/, "口径要跟着数一起走");
  } finally { ctx.cleanup(); }
});

test("资金流取不到:写缺口、返回 null,阶段退回只看量价(并且明说)", async () => {
  const ctx = fakeCtx();
  try {
    const cfg = BASE();
    cfg.endpoints.sina_fund_flow = { failed: "新浪超时" };
    ctx.setCfg(cfg);
    const r = await analyzeStock(ctx, "600519");
    assert.equal(r.money, null);
    assert.ok(r.gaps.some((g) => /资金流没取到\(新浪超时\)/.test(g)), r.gaps.join(" / "));
    // 少了一个域不能把整份判成无效;但阶段里要交代它是怎么来的
    assert.equal(r.sufficient, true);
    assert.notEqual(r.composite, null);
    assert.ok(r.main_capital.factors.some((f) => /只由量价推出/.test(f)), r.main_capital.factors.join(" / "));
  } finally { ctx.cleanup(); }
});

test("资金与量价打架:退成「观望」并把矛盾写在第一行(不挑顺眼的留下)", () => {
  const base = {
    score: 70, confidence: "中", advice: "趋势与量能配合,持有为主", factors: ["近一日放量"],
  };
  const money = (over: Partial<MoneyView>): MoneyView => ({
    as_of: "2026-10-30", window: { from: "2026-08-01", to: "2026-10-30", n: 60 },
    net_1d: null, net_5d: null, net_10d: null, net_20d: null, big_order_5d: null,
    streak: -6, trend: "净流出", note: "口径", ...over,
  });

  // 主升 / 吸筹(偏多)遇上持续净流出 ⇒ 不给方向
  for (const stage of ["主升", "吸筹"] as const) {
    const mc = reconcileStage({ ...base, stage }, money({ net_5d: -3e8, net_20d: -9e8 }));
    assert.equal(mc.stage, "观望", `${stage} 与资金流出相反,不能留着`);
    assert.equal(mc.confidence, "低");
    assert.match(mc.advice, /相反/);
    assert.match(mc.factors[0]!, /近 5 日 -3\.00 亿/);
    assert.ok(mc.factors.some((f) => /量价像主升|量价像吸筹/.test(f)), mc.factors.join(" / "));
  }
  // 出货(偏空)遇上持续净流入 ⇒ 同样不给方向
  const hold = reconcileStage({ ...base, stage: "出货" }, money({ trend: "净流入", streak: 6, net_5d: 3e8, net_20d: 9e8 }));
  assert.equal(hold.stage, "观望");
  assert.match(hold.advice, /相反/);
});

test("资金同向:只把「吸筹」的置信度升一档;观望不会被资金造出方向", () => {
  const money: MoneyView = {
    as_of: "2026-10-30", window: { from: "2026-08-01", to: "2026-10-30", n: 60 },
    net_1d: 1e8, net_5d: 3e8, net_10d: 5e8, net_20d: 9e8, big_order_5d: 2e8,
    streak: 4, trend: "净流入", note: "口径",
  };
  const acc = reconcileStage({ score: 50, stage: "吸筹", confidence: "低", advice: "低位缩量", factors: [] }, money);
  assert.equal(acc.stage, "吸筹");
  assert.equal(acc.confidence, "中", "多了一个独立证据,低可以升到中");
  assert.match(acc.factors[0]!, /近 5 日 \+3\.00 亿/);

  const hold = reconcileStage({ score: 50, stage: "观望", confidence: "低", advice: "信号不明确", factors: [] }, money);
  assert.equal(hold.stage, "观望", "资金有方向也不能替「观望」编一个形态");
  assert.equal(hold.confidence, "低");
  assert.ok(hold.factors.some((f) => /不足以据此定阶段/.test(f)));

  // 短中期分歧:阶段留着,但强度打折
  const split = reconcileStage(
    { score: 70, stage: "主升", confidence: "中", advice: "持有为主", factors: [] },
    { ...money, net_5d: 3e8, net_20d: -9e8, trend: "分歧" },
  );
  assert.equal(split.stage, "主升");
  assert.equal(split.confidence, "低");
  assert.match(split.advice, /强度打折/);
});
