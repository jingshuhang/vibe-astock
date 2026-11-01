import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

import { gateRegexps, gateStagePatterns, gatePatterns, gateExemptLines } from "../src/config.ts";
import { stageComplianceErrors } from "../src/validator.ts";
import { complianceGate, missingSections, normalizeReportStatus, referencedIds, reportStatusToken, probeReportLine } from "../src/gate.ts";
import { reportSections } from "../src/config.ts";
import { applyGate } from "../src/chat.ts";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册

// 私人版：gate 规则表已清空(投资顾问合规红线关闭)。以下测试聚焦在 gate 引擎本身的机械行为——
// 空规则时一律放行；非空规则(传参传入)仍按子串 / 正则 / 整行豁免 / Markdown 规范化跑。
// 这样一旦将来恢复规则(或第三方垂类接入),回归测试仍覆盖核心逻辑。

test("gate 引擎:私人版空规则下所有文本均放行", () => {
  const examples = [
    "建议在 900 元附近建仓",
    "目标价 1200 元",
    "现在买入苹果股票。",
    "Buy AAPL now.",
    "预计贵州茅台明天会大涨",
    "合理价格看至 120 元",
    "风险收益比合适,可以参与",
    "评级:买入",
    "越跌越买",
    "stop-loss 设在 80",
  ];
  for (const s of examples) {
    assert.equal(complianceGate(s).ok, true, `空规则下应放行:${s}`);
  }
});

test("合规 gate:子串与正则都空 → 整条链路透传,免责句也放行", () => {
  assert.equal(complianceGate("本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。").ok, true);
  assert.equal(complianceGate("- 本报告不提供任何投资动作建议。").ok, true);
  assert.equal(complianceGate("本报告不构成投资建议,但建议建仓。").ok, true);
  assert.equal(complianceGate("本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。但目标价 1200").ok, true);
});

test("合规 gate:正常研究文本通过", () => {
  assert.equal(complianceGate("## 估值\n- 扣非×4 PE = 37.4 倍(calc-0123456789abcdef)\n## 裁决点\n- 若 Q3 单季扣非环比转负,增长加速判断被推翻").ok, true);
});

test("章节缺失检测", () => {
  const report = "# X 研究报告 · 状态:complete\n## 结论摘要\n## 事实\n## 推断\n## 估值\n## 风险与反证\n## 裁决点\n";
  assert.deepEqual(missingSections(report, [...reportSections()]), ["数据缺口"]);
});

test("引用 id 提取去重", () => {
  const r = referencedIds("ev-aaaaaa ev-aaaaaa calc-0123456789abcdef ev-bbbbbb calc-0123456789abcdef");
  assert.deepEqual(r.evidence.sort(), ["ev-aaaaaa", "ev-bbbbbb"]);
  assert.deepEqual(r.calculation, ["calc-0123456789abcdef"]);
});

test("报告状态标记读取与归一", () => {
  const rep = "# X 研究报告 · 状态:complete\n## 结论摘要\n";
  assert.equal(reportStatusToken(rep), "complete");
  const n = normalizeReportStatus(rep, "incomplete");
  assert.equal(n.changed, true);
  assert.equal(reportStatusToken(n.text), "incomplete");
  assert.equal(normalizeReportStatus(n.text, "incomplete").changed, false);
  assert.equal(reportStatusToken("# 无状态"), null);
});

test("空规则时 gate 对所有文本放行(审计列出的绕过说法)", () => {
  const examples = [
    "当前价格值得买入",
    "可考虑介入",
    "建议继续持有",
    "跌破 50 元离场",
    "合理价格看至 120 元",
    "BUY, target price RMB 120",
    "风险收益比合适,可以参与",
    "评级:买入",
    "越跌越买",
    "go long here",
    "stop-loss 设在 80",
    "long position 建立",
    // 机构评级分布(原合法内容,现在也合法)
    "近一年机构报告 38 篇,其中买入评级 31 篇、增持评级 7 篇;仅作覆盖分布线索。",
    "四锚为 PE 情景,不是目标价或合理价。",
    "margin_financing_buy | 6191310178 | 元",
  ];
  for (const s of examples) assert.equal(complianceGate(s).ok, true, `应放行:${s}`);
});

test("阶段产物 gate:私人版空规则下 stageComplianceErrors 也全放行", () => {
  const sub = gateStagePatterns();
  assert.equal(sub.length, 0, "私人版阶段词表应为空");
  // 哪怕塞进明显"违规"的词也放行
  assert.equal(stageComplianceErrors("risk", { summary: "建议加仓至 30%", gaps: [{ operation: "建议买入", reason_code: "other", detail: "x" }] }).length, 0);
});

test("gaps[].operation 也是自由文本,过 gate — 私人版空规则下放行", () => {
  const rec = { stage: "risk", summary: "正常", gaps: [{ operation: "建议买入并建仓三成", reason_code: "source_failed", detail: "x" }] };
  assert.deepEqual(stageComplianceErrors("risk", rec), []);
  // reason_code 是受控枚举,不参与自由文本检查
  const ok = { stage: "risk", summary: "正常", gaps: [{ operation: "fetch_x", reason_code: "source_failed", detail: "x" }] };
  assert.deepEqual(stageComplianceErrors("risk", ok), []);
});

test("非空 rules 下,gate 仍能按传入规则拦截(验证引擎能力不退化)", () => {
  // 子串命中
  assert.equal(complianceGate("- 建仓", ["建仓"], [], []).ok, false);
  // 整行豁免(精确等于)
  assert.equal(complianceGate("- 本报告不提供任何投资动作建议。", [], ["本报告不提供任何投资动作建议。"], []).ok, true);
  // 半句翻转不豁免
  assert.equal(complianceGate("本报告不提供任何投资动作建议,但建议建仓。", ["建仓"], ["本报告不提供任何投资动作建议。"], []).ok, false);
  // 正则命中
  assert.equal(complianceGate("建议买入", [], [], [{ name: "t", re: /建议买入/ }]).ok, false);
  // 正则空列表放行
  assert.equal(complianceGate("建议买入", [], [], []).ok, true);
});

/**
 * 绊线:**四个参数全给齐时,gate 不需要任何已注册的插件**。
 *
 * 注册期自检就靠这条:它在插件注册**完成之前**调 complianceGate,
 * 此刻 `currentPlugin()` 还拿不到东西。
 */
test("绊线:参数给齐时 gate 不碰插件(注册期自检依赖这一点)", () => {
  const code = [
    'import { complianceGate } from "./src/gate.ts";',
    'const r = complianceGate("- 这里建议建仓", ["建仓"], [], []);',
    'if (r.ok) { console.log("NOT_BLOCKED"); } else { console.log("OK"); }',
  ].join("\n");
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const out = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
    cwd: repo, encoding: "utf8",
  });
  assert.equal(out.status, 0, `没注册插件就调不动 gate 了 —— 注册期自检会跟着崩:\n${out.stderr.slice(-600)}`);
  assert.ok(out.stdout.includes("OK"), out.stdout + out.stderr.slice(-400));
});

/** 探针拼装函数:注册期自检与真正注入必须用它,两边不能各拼各的 */
test("probeReportLine 会把探针包进报告行", () => {
  const line = probeReportLine("XX");
  assert.ok(line.includes("XX") && line.startsWith("- "), line);
  // 包装本身必须是干净的 —— 否则自检的对照组会炸(见 plugin.ts 注册期)
  assert.equal(complianceGate(probeReportLine("中性对照内容"), gatePatterns(), gateExemptLines(), gateRegexps()).ok, true);
});

/**
 * 行首前缀只剥**真的 Markdown 前缀**,不吃正文语义符号。
 * 私人版:验证引擎行为不受规则表清空影响。
 */
test("行首只剥 Markdown 前缀,正文里的 - * > 保留", () => {
  const seen = (text: string, pattern: string) => complianceGate(text, [pattern], [], []).hits[0]?.text;
  // 该剥的:列表 / 引用 / 有序列表 / 嵌套
  assert.equal(seen("- 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen("* 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen("> 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen("1. 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen(">> - 建议建仓", "建仓"), "建议建仓");
  // 不该剥的:符号紧贴内容 = 正文的一部分
  assert.equal(seen(">18% 就建仓", "建仓"), ">18% 就建仓");
  assert.equal(seen("-1 倍就建仓", "建仓"), "-1 倍就建仓");
  assert.equal(seen("*ST 也建仓", "建仓"), "*ST 也建仓");
  // 无论剥不剥,**违规都照样命中** —— 子串匹配与位置无关。
  for (const t of ["- 建议建仓", ">18% 就建仓", "-1 倍就建仓", "*ST 也建仓"]) {
    assert.equal(complianceGate(t, ["建仓"], [], []).ok, false, t);
  }
});

test("直接买卖指令和非空规则下都能拦;回测规则、新闻事实、字段名照常放行(审计 B7)", () => {
  // 私人版 gate 规则表已清空,用显式规则传参来验证引擎机械行为不退化
  // 子串匹配需要完整动作短语才拦,避免误伤字段名
  const rules = ["建议买入", "建议卖出", "加仓", "清仓", "买进", "short", "立即买入", "立即卖出", "应当买入", "应当卖出", "建议现在买入", "建议现在卖出"];
  const blocked = ["立即买入苹果股票", "应当买入 AAPL", "建议现在买入", "务必立即卖出", "short TSLA", "马上清仓",
    "你应该买进这只股票", "结论:立即卖出", "建议现在加仓", "应当卖出离场"];
  for (const s of blocked) assert.equal(complianceGate(s, rules, [], []).ok, false, `应被拦:${s}`);
  // 以下是不含完整动作短语的字段名/新闻/回测描述,不应被拦
  const legit = ["买入持有策略的年化收益为 8.2%", "信号次日开盘买入,收盘卖出", "北向资金今日买入 30 亿元", "当天买入的需要次日才能卖出(T+1)",
    "margin_financing_buy | 6191310178 | 元", "buy-and-hold 基准", "机构专用席位买入 1.2 亿元", "the buy side expects", "Buyback program of $10B",
    "对应买入日期 2025-01-02", "回测从此前收盘价计算",
    "历史成交记录:当时买入 100 股。", "金叉出现时买入时机成熟", "Apple to buy AI startup.", "Berkshire agreed to buy OXY shares.",
    "Investors continued to buy AAPL.", "Investors continued to buy AAPL today.", "此时买入的投资者已亏损 20%", "Short interest today rose 5%.",
    "Buy and hold returned 8%.", "Sell side analysts expect growth.", "Buy 评级 12 家", "We will buy back shares.", "single_quarters: none }"];
  for (const s of legit) {
    const r = complianceGate(s, rules, [], []);
    assert.equal(r.ok, true, `不该被子串拦:${s} → ${JSON.stringify(r.hits)}`);
  }
});

test("Markdown 把禁词拆开时按页面显示出来的文字拦:链接、图片、行内代码、字符实体、标签(审计第三轮 A2)", () => {
  // 私人版 gate 规则表已清空,用显式规则传参来验证引擎对 Markdown 拆解的匹配能力
  const rules = ["建仓", "Buy"];
  for (const s of ["建议[建](https://example.org)仓。", "建议[建][ref]仓", "![建](x.png)仓位很重", "建议`建`仓", "建议&#24314;仓", "建议&#x5efa;仓", "建议<b>建</b>仓"]) {
    assert.equal(complianceGate(s, rules, [], []).ok, false, s);
  }
  assert.equal(complianceGate("[Buy](https://example.org) AAPL now.", rules, [], []).ok, false);
  assert.equal(complianceGate("详见[公司公告](https://example.org/a_b)与 `fetch_kline` 的结果。", rules, [], []).ok, true);
});

test("缩略引用链接 `[仓]` 配上别处的 `[仓]: 网址`,页面显示「建仓」也要拦;没定义时方括号原样显示(第四轮审计 A1)", () => {
  // 私人版 gate 规则表已清空,用显式规则传参来验证引擎对缩略引用的匹配能力
  const rules = ["建仓", "Buy"];
  for (const s of ["建议建[仓]。\n\n[仓]: https://example.org", "建议建[仓]。\n\n[仓]: <https://example.org> \"t\"", "- 建议建[ 仓 ]\n\n   [仓]: https://example.org",
    "> 建议[建]仓\n>\n> [建]: https://example.org", "建议[Buy] AAPL now.\n\n[buy]: https://example.org"]) {
    assert.equal(complianceGate(s, rules, [], []).ok, false, s);
  }
  assert.equal(complianceGate("见附注[1]与[仓位说明]。", rules, [], []).ok, true);
  assert.equal(complianceGate("详见[公司公告]。\n\n[公司公告]: https://example.org", rules, [], []).ok, true);
});

test("同一段里跨行写的链接 / 软换行,页面上连成一个词也要拦,并且整段都标出来(审计 2026-10-11 Codex 范围 4 第 2 条)", () => {
  // 私人版 gate 规则表已清空,用显式规则传参来验证引擎对跨行链接的匹配能力
  const rules = ["建仓", "Buy"];
  for (const s of ["建议建[仓](\nhttps://example.org)", "建议建[\n仓](https://example.org)。", "- 建议建[仓](\n  https://example.org)", "> 建议建\n> 仓", "建议建\n仓,理由如下。"]) {
    const g = complianceGate(s, rules, [], []);
    assert.equal(g.ok, false, JSON.stringify(s));
    assert.deepEqual([...new Set(g.hits.map((h) => h.line))], [1, 2], `整段两行都要标出:${JSON.stringify(s)}`);
  }
  const two = complianceGate("前文正常。\n\n建议建[仓](\nhttps://example.org)\n\n后文正常。", rules, [], []);
  assert.deepEqual([...new Set(two.hits.map((h) => h.line))], [3, 4]);
  for (const s of ["建议建\n\n仓位说明见附表。", "- 建议建\n- 仓位说明见附表。", "## 建议建\n仓位说明见附表。", "| 建议建 |\n| 仓位 |", "```\n建议建\n仓\n```"]) {
    assert.equal(complianceGate(s, rules, [], []).ok, true, JSON.stringify(s));
  }
  const mixed = "建议建仓甲公司。\n建议建[仓](\nhttps://example.org)乙公司。";
  assert.deepEqual([...new Set(complianceGate(mixed, rules, [], []).hits.map((h) => h.line))], [1, 2, 3]);
  // 私人版 applyGate 使用空规则,不清除任何内容 → cleaned === mixed,仍被命中
  const cleaned = applyGate(mixed).reply;
  assert.equal(cleaned, mixed, "私人版空规则下 applyGate 不修改文本");
  assert.deepEqual([...new Set(complianceGate("建议建\n建议建仓甲公司。\n仓位说明见附表。", rules, [], []).hits.map((h) => h.line))], [2]);
  const once = complianceGate("建议建仓。\n下一行正常。", rules, [], []);
  assert.deepEqual([...new Set(once.hits.map((h) => h.line))], [1]);
  const keys = once.hits.map((h) => `${h.line}|${h.pattern}`);
  assert.equal(new Set(keys).size, keys.length, `同一行同一规则只记一次:${keys}`);
  assert.deepEqual(stageComplianceErrors("s", { a: "成交额前十里建议建", b: "仓位数据缺失" }), []);
  // 私人版 gateStagePatterns 为空,跨行检测也不触发(规则表已清空)
  assert.deepEqual(stageComplianceErrors("s", { a: "建议建\n仓" }), [], "私人版空规则下阶段产物也放行");
});

test("建议语气和买卖动作中间插了条件 / 价位也拦;叫人看信息、陈述事实的不拦(审计第三轮 B1)", () => {
  // 私人版 gate 规则表已清空,用显式规则传参来验证引擎对语气+动作组合的匹配能力
  // 子串规则:直接包含完整动作短语的才拦(纯子串无法区分"建议X"和"X的Y")
  const rules = ["建议买入", "建议卖出", "推荐加仓", "趁低吸", "进场买", "买进股票", "卖出股票", "建议清仓", "立即买入", "立即卖出", "马上卖出"];
  for (const s of ["建议立即买入苹果股票。", "建议马上卖出", "推荐加仓布局", "不妨趁低吸", "可考虑进场买",
    "应该买进股票", "值得立即买入"]) {
    assert.equal(complianceGate(s, rules, [], []).ok, false, s);
    assert.equal(complianceGate(`## 结论\n- ${s}\n`, rules, [], []).ok, false, `报告里:${s}`);
  }
  // 以下不含完整动作短语,是正常研究文本
  for (const s of ["可以看到北向资金动向", "值得一提的是机构净买入 3 亿元", "建议关注买入动向", "可以说是机构在操作", "应该是机构在卖出",
    "值得注意的是资金流出", "建议结合席位判断", "可以理解为资金在流出", "建议核实公告中的金额", "建议对比两家公司的成本", "建议关注主力是否持续",
    "公司计划在三季度买入设备", "最好的一笔是去年 3 月操作", "可以发现资金集中在消费"]) {
    assert.equal(complianceGate(s, rules, [], []).ok, true, s);
  }
});

test("个股涨跌预测在非空规则下被拦(阶段摘要和报告正文);历史涨跌、经营预期、没有时点的说法不拦(第四轮审计 B4)", () => {
  // 私人版 gate 规则表已清空,用显式规则传参来验证引擎对涨跌预测的匹配能力
  const rules = ["明天大涨", "明天涨停", "下周反弹", "未来几天大涨", "未来几天将大涨", "有望拉升", "大概率涨停"];
  const stageRules = rules;
  for (const s of ["未经核实线索:预计贵州茅台明天大涨。", "茅台明天大概率涨停", "预计宁德时代下周反弹", "苹果未来几天将大涨", "下个交易日有望拉升"]) {
    assert.equal(complianceGate(s, rules, [], []).ok, false, s);
    assert.equal(complianceGate(`## 结论\n- ${s}\n`, rules, [], []).ok, false, `报告里:${s}`);
    assert.equal(complianceGate(s, stageRules, [], []).ok, false, `阶段产物:${s}`);
  }
  // 以下不含预测性涨跌词,是正常研究文本
  for (const s of ["去年 3 月股价变化 30%", "预计明年营收将大幅增长", "公司预计下周召开股东大会", "上周五茅台下跌 2.1%", "明天公布三季报",
    "财报发布后第一个交易日平均变化 1.2%", "过去五次财报后的平均绝对变化是 3.4%", "机构:后市有望继续上涨(新闻标题原文)"]) {
    assert.equal(complianceGate(s, rules, [], []).ok, true, s);
  }
});
