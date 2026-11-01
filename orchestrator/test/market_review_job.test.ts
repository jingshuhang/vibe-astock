import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { detectPython } from "../src/init.ts";
import type { JobContext } from "../src/notify.ts";
import { callLine, dailyReviewJob, tiersSummary } from "../src/finance/market_review.ts";
import type { ReviewTiersResult } from "../src/finance/review_tiers.ts";
import { ledgerInsertMany, ledgerList, type ServiceContext } from "../src/service.ts";

/**
 * 「Agent 复盘」定时任务整条跑:假取数器读仓库根目录的 cfg.json,不联网、不真调模型(注入 turn)。
 *
 * 🔴 要钉住的是**纪律**,不是排版:
 *   ① 资料包里的数必须带读法护栏与数据日,没取到的块写成【缺口】(空着会被读成「今天没有」);
 *   ② 存进「研究记录」的是 `note` / `category=review`,和页面上点「存入沉淀」同一张表;
 *   ③ 同一天写过就不再写,手动运行除外;
 *   ④ 没接 AI 只写一句 note,不抛错(抛错会被重试三次、进收件箱)。
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";

const FAKE = String.raw`import json,sys,hashlib
a=sys.argv; ep=a[a.index('--endpoint')+1]
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json',encoding='utf-8'))
def done(env,code=0): print(json.dumps(env)); sys.exit(code)
def ev(*p,**kw): return dict(id='ev-'+hashlib.sha1('|'.join(map(str,p)).encode()).hexdigest()[:12],**kw)
day=cfg['review_day']; prev=cfg['prev_day']
dead=cfg.get('dead',[])
if ep in dead: done({'status':'failed','reason':'上游没回数据','evidence':[]},3)
if ep=='em_market_breadth':
  out=[]
  for k,n in ((11,45),(-11,6),(1,3000),(-1,2000),(0,100),(6,120),(-6,80)):
    out.append(ev('b',k,field='market_dist_count',value=n,unit='只',period=day,record_key='dist|%d'%k,note='档 %d'%k))
  out.append(ev('b','SH',field='market_turnover_amount',value=6.1e11,unit='元',period=day,record_key='exchange|SH',note='沪市'))
  out.append(ev('b','SZ',field='market_turnover_amount',value=7.4e11,unit='元',period=day,record_key='exchange|SZ',note='深市'))
  out.append(ev('b','BJ',field='market_turnover_amount',value=3.0e10,unit='元',period=day,record_key='exchange|BJ',note='北交所'))
  done({'status':'ok','extra':{'date':day},'evidence':out})
if ep=='em_limit_up_sentiment':
  done({'status':'ok','extra':{'date':day},'evidence':[
    ev('s',field='limit_up_count',value=45,unit='只',period=day),
    ev('s',field='break_board_count',value=15,unit='只',period=day),
    ev('s',field='limit_down_count',value=6,unit='只',period=day)]})
if ep=='em_zt_pool':
  out=[]
  for code,name,ind,b in (('600001','甲','银行',3),('600002','乙','半导体',2),('600003','丙','半导体',1)):
    out.append(ev('z',code,field='pool_limit_days',value=b,unit='板',period=day,record_key=code,note='%s %s %s 首封 09:3%d:00'%(code,name,ind,b)))
  done({'status':'ok','extra':{'date':day},'evidence':out})
if ep=='em_yzt_pool':
  out=[ev('y',c,field='pool_change_pct',value=v,unit='%',period=day,record_key=c,note='%s 昨涨停'%c)
       for c,v in (('600001',5.0),('600002',-6.0),('600009',2.0))]
  out += [ev('y',c,field='pool_y_limit_days',value=1,unit='板',period=day,record_key=c) for c in ('600001','600002','600009')]
  out.append(ev('y','n',field='yesterday_limit_up_pool_count',value=3,unit='只',period=day))
  done({'status':'ok','extra':{'date':day},'evidence':out})
if ep=='em_market_trend':
  out=[ev('t',1,field='index_close',value=3300.5,unit='点',period=day,record_key='index|000001',note='上证指数(000001)')]
  for f,v in (('index_change_pct',0.8),('index_return_20d',2.5),('index_return_60d',-1.2),('index_return_250d',9.9),('index_return_ytd',4.4),('index_ma20',3250.0),('index_ma60',3200.0),('index_ma250',3100.0),('index_off_high_250d_pct',-3.3)):
    out.append(ev('t',f,field=f,value=v,unit='点' if 'ma' in f else '%',period=day,record_key='index|000001',note='上证指数(000001)'))
  out.append(ev('t','a1',field='market_amount_total',value=1.35e12,unit='元',period=day,record_key='amount|'+day))
  out.append(ev('t','a2',field='market_amount_total',value=1.20e12,unit='元',period=prev,record_key='amount|'+prev))
  out.append(ev('t','avg',field='market_amount_ma20',value=1.25e12,unit='元',period=day,record_key='amount|avg'))
  out.append(ev('t','avg',field='market_amount_ma60',value=1.10e12,unit='元',period=day,record_key='amount|avg'))
  done({'status':'ok','extra':{'date':day},'evidence':out})
if ep=='index_valuation':
  done({'status':'ok','extra':{'date':day},'evidence':[
    ev('v',field='index_pe_total',value=12.5,unit='倍',period=day,record_key='000300:'+day),
    ev('v',field='index_dividend_yield_total',value=3.2,unit='%',period=day,record_key='000300:'+day)]})
if ep=='chinabond_yield_curve':
  done({'status':'ok','evidence':[ev('y10',field='yield_10y',value=1.8,unit='%',period=day,record_key='treasury:10y')]})
done({'status':'ok','extra':{'date':day},'evidence':[]})
`;

// 交易日历是 legacy 脚本(不是 fetch_endpoint),单独一个文件
const FAKE_CAL = String.raw`import json
cfg=json.load(open('cfg.json',encoding='utf-8'))
day=cfg['review_day']; prev=cfg['prev_day']
def ev(tag,field,value,period):
  return {'id':'ev-'+tag,'field':field,'value':value,'unit':'日期','period':period}
print(json.dumps({'status':'ok','script':'fetch_trade_calendar','evidence':[
  ev('ltd','last_trading_day',day,day),
  ev('ptd','previous_trading_day',prev,prev),
  {'id':'ev-itt','field':'is_today_trading_day','value':1,'unit':'布尔','period':day},
  {'id':'ev-sp','field':'session_phase','value':'post_close','unit':'枚举','period':day}]}))
`;

interface Cfg { review_day: string; prev_day: string; dead?: string[] }

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; cleanup(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-mktreview-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  fs.writeFileSync(path.join(scripts, "fetch_trade_calendar.py"), FAKE_CAL);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(path.join(dataRoot, "ledger"), { recursive: true });
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

const CFG: Cfg = { review_day: "2026-10-30", prev_day: "2026-10-29" };
const NOW = new Date("2026-10-30T10:55:00Z"); // 北京 18:55
const jobOf = (ctx: ServiceContext, manual = false): JobContext =>
  ({ ctx, day: "2026-10-30", now: NOW, signal: new AbortController().signal, state: undefined, manual });
const TEXT = "市场处在偏弱状态,上涨 3000 / 下跌 2000[测试正文]。";

test("资料包:数带读法护栏与数据日,没取到的块写【缺口】,不写空档", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    const seen: { message: string; session: string }[] = [];
    const turn = async (message: string, session: string) => { seen.push({ message, session }); return TEXT; };
    await dailyReviewJob(jobOf(ctx), { turn });

    const m = seen[0]!.message;
    assert.equal(seen[0]!.session, "daily-review-2026-10-30");
    assert.match(m, /【业务日】2026-10-30/);
    // 涨跌面:上涨/下跌按分档求和(涨停算在上涨里,与页面同一口径),派生标签与规则一起进去
    assert.match(m, /【涨跌面·2026-10-30】上涨 3165 \/ 下跌 2086 \/ 平盘 100 家/);
    assert.match(m, /涨停 45 \/ 跌停 6;涨 5% 以上 165 \/ 跌 5% 以上 86/);
    assert.match(m, /上涨占比 60\.3%\(派生标签「偏强」,规则:上涨家数 ÷\(上涨 \+ 下跌\)/);
    assert.match(m, /沪深京成交额 13,800 亿/);
    // 短线情绪:封板率的口径写在括号里
    assert.match(m, /封板率 75\.0%\(涨停 ÷\(涨停 \+ 炸板\)\)/);
    assert.match(m, /最高连板 3;2 板及以上 2 只;分层 3 板 1 · 2 板 1 · 首板 1/);
    // 昨日涨停今日表现:平均 (5-6+2)/3 = 0.33
    assert.match(m, /【昨日涨停今日表现】3 只有涨跌幅\(昨日涨停 3 只\):平均 \+0\.33%/);
    assert.match(m, /跌 5% 以上 1 只/);
    assert.match(m, /【晋级】昨日涨停今天又涨停 2\/3\(66\.7%\)/);
    // 中长线:均线位置 + 成交额与均值比
    assert.match(m, /【指数·上证指数·截至 2026-10-30】3300\.5 点/);
    assert.match(m, /在 20 日线上方、在 60 日线上方、在 250 日线上方/);
    assert.match(m, /【两市成交额·2026-10-30】13,500 亿;20 日均值 12,500 亿\(\+8\.0%\)/);
    // 估值:股债差是两组收益率的差,不是估值判断
    assert.match(m, /市盈率 12\.5 倍\(盈利收益率 1÷市盈率 = 8%\)/);
    assert.match(m, /股息率 − 国债 1\.4 个百分点/);
    assert.match(m, /只是两组收益率的差,不是估值判断/);
    // 没取到的块要写成缺口,并且明确「不要就它下结论」
    assert.match(m, /【缺口】两融余额这次没取到,不要就它下结论/);
    assert.match(m, /【缺口】行业资金这次没取到,不要就它下结论/);
    assert.match(m, /【缺口】龙虎榜这次没取到或还是空表\(收盘后才公布\),不要就此说「今天没有上榜的」/);
    assert.match(m, /【缺口】成交额榜这次没取到或为空,不要据此说「今天没有活跃的」/);
    // 各块自己的读法护栏与提示词要求
    assert.match(m, /【读法·涨停梯队】/);
    assert.match(m, /【当日全景判断】2026-10-30 没有对应的全景判断记录/);
    assert.match(m, /标了【缺口】的块不要就它下任何结论/);
    assert.doesNotMatch(m, /建议买入|可以买|目标价必/, "提示词不能自己给出建议口径");
    assert.match(m, /资料包结束/);
  } finally { ctx.cleanup(); }
});

test("存进研究记录(note / category=review),同一天不重复写,手动运行除外", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    let calls = 0;
    const turn = async () => { calls++; return TEXT; };
    const r = await dailyReviewJob(jobOf(ctx), { turn });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0]!.dedupeKey, "daily_review_ai:2026-10-30");
    assert.equal(r.messages[0]!.link, "/daily-review");
    assert.match(r.messages[0]!.title, /Agent 复盘 2026-10-30 已写完并存进研究记录/);

    const notes = ledgerList(ctx, "note").note ?? [];
    assert.equal(notes.length, 1);
    assert.deepEqual([notes[0]!.category, notes[0]!.title], ["review", "每日复盘 2026-10-30(自动)"]);
    assert.ok(String(notes[0]!.body).startsWith(TEXT), "正文就是模型写的那一篇");
    assert.match(String(notes[0]!.body), /由定时任务自动生成/, "存档里要写明是自动生成的");

    // 同一天再跑:一句 note 就结束,不调模型、不写第二条
    const again = await dailyReviewJob(jobOf(ctx), { turn });
    assert.equal(again.messages.length, 0);
    assert.match(again.note!, /已经有 1 篇复盘,今天不再写/);
    assert.equal(calls, 1);
    assert.equal((ledgerList(ctx, "note").note ?? []).length, 1);

    // 手动运行:照写(用户自己要看这一天的第二版)
    const manual = await dailyReviewJob(jobOf(ctx, true), { turn });
    assert.equal(manual.messages.length, 1);
    assert.equal(calls, 2);
    assert.equal((ledgerList(ctx, "note").note ?? []).length, 2);
  } finally { ctx.cleanup(); }
});

test("没接 AI:只写一句、不抛错、不写台账(抛错会被重试三次再进收件箱)", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CFG);
    // 临时数据根没有 config.json ⇒ 没有后台默认模型
    const r = await dailyReviewJob(jobOf(ctx));
    assert.equal(r.messages.length, 0);
    assert.match(r.note!, /^没写:/);
    assert.match(r.note!, /AI 来源/);
    assert.deepEqual(ledgerList(ctx, "note").note ?? [], []);
  } finally { ctx.cleanup(); }
});

test("整屏一块都没取到:报错(不许把取数失败写成「今天没什么可复盘的」)", async () => {
  const ctx = fakeCtx();
  try {
    // 除交易日历外全部失败
    ctx.setCfg({ ...CFG, dead: ["em_market_breadth", "em_limit_up_sentiment", "em_zt_pool", "em_yzt_pool", "em_market_trend", "em_market_margin", "index_valuation", "chinabond_yield_curve", "em_board_fund_flow", "em_turnover_rank", "em_daily_dragon_tiger"] });
    await assert.rejects(dailyReviewJob(jobOf(ctx), { turn: async () => TEXT }), /一块都没取到/);
    assert.deepEqual(ledgerList(ctx, "note").note ?? [], []);
  } finally { ctx.cleanup(); }
});

test("全景判断在台账里时写成交叉验证项,并写明「不是你的结论」", () => {
  const ctx = fakeCtx();
  try {
    ledgerInsertMany(ctx, { kind: "market_call", records: [{
      date: "2026-10-30", call: "减仓", direction: "偏空", basis: "广度回落", trigger: "广度破 45% 转减",
      trigger_metric: "breadth_pct", trigger_op: "below", trigger_value: 45,
      breadth_pct: 43.2, amount_yi: 13800, limit_up: 45, limit_down: 6, settled: false,
    }] });
    const line = callLine(ctx, "2026-10-30")!;
    assert.match(line, /全景收盘档给出「减仓·偏空」/);
    assert.match(line, /触发条件:广度 ≤ 45\(广度破 45% 转减\)/);
    assert.match(line, /写下时读数:广度 43\.2% · 额 13800 亿 · 涨停 45 \/ 跌停 6/);
    assert.match(line, /只作交叉验证对照,不构成投资建议/);
    assert.match(line, /不要直接采信它/);
    assert.equal(callLine(ctx, "2026-10-29"), "【当日全景判断】2026-10-29 没有对应的全景判断记录(全景侧还没落件),本轮没有可交叉验证的对照项。");
  } finally { ctx.cleanup(); }
});

test("涨停分档:没算出来只写缺口,不写空的四档(空档会被读成「今天没有集中的行业」)", () => {
  assert.deepEqual(tiersSummary(null), ["【缺口·涨停分档】这次没算出来,不分档、不据此下结论"]);
  const res: ReviewTiersResult = {
    date: "2026-10-30", prev_dates: ["2026-10-29", "2026-10-28"], total: 45,
    groups: [{
      industry: "半导体", tier: "mainline", today: 3, prev: [2, 3], note: "",
      stocks: [
        { symbol: "600002", name: "乙", industry: "半导体", boards: 3, tags: [], first_seal: "09:31:00" },
        { symbol: "600003", name: "丙", industry: "半导体", boards: 1, tags: [], first_seal: "10:02:00" },
      ],
      tags: [{ tag: "国产替代", count: 2 }],
    }, {
      industry: "银行", tier: "single", today: 1, prev: [0, 1], note: "",
      stocks: [{ symbol: "600001", name: "甲", industry: "银行", boards: 1, tags: [] }], tags: [],
    }],
    tiers: [], fetched_at: null, cached: false, generated_at: "", gaps: [], source: "",
  };
  const lines = tiersSummary(res);
  assert.match(lines[0]!, /【涨停分档·2026-10-30】45 只涨停按东财行业归类/);
  assert.match(lines[0]!, /前两个交易日\(2026-10-29、2026-10-28\)比/);
  const semi = lines.find((l) => l.includes("半导体 3 只"))!;
  assert.match(semi, /前两个交易日 2 \/ 3/);
  assert.match(semi, /最高板 乙\(3 连板,09:31 首封\)/);
  assert.match(semi, /梯队 3 板 1 · 首板 1/);
  assert.match(semi, /同花顺题材标签 国产替代×2/);
  assert.ok(lines.some((l) => /单只\(今天这个行业只有 1 只涨停\):银行/.test(l)), "单只档只列行业名");
});
