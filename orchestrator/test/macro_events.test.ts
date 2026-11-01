/**
 * 事件面读数（新闻联播标题 → 宏观词典 → 事件分）单元测试
 *
 * 🔴 这个模块的定位是**文本代理指标**，不是宏观判断。测试要锁住四条边界：
 *    ① 取不到标题 → null（不是 50）：「没数据」和「今天宏观面安静」是两件事
 *    ② 分数永远落在 35~65：词典再离谱也不许把综合分拉走
 *    ③ 方向词只在宏观条目里算：体育新闻里的「加快」不该影响政策读数
 *    ④ 权重封顶 8%：见 market_state.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readMacroEvents, EVENT_SCORE_RANGE } from "../src/finance/macro_events.ts";

const TITLES_HOT = [
  "中共中央政治局召开会议 分析研究当前经济形势",
  "国务院常务会议部署进一步扩大内需 提振消费",
  "央行宣布降准0.5个百分点 支持实体经济发展",
  "财政部:加大减税降费力度 减轻企业负担",
  "某地通报查处一批违法违规案件 加强整顿",
];

describe("readMacroEvents", () => {
  it("没有标题 → null(不是中性 50)", () => {
    assert.equal(readMacroEvents({ date: null, titles: [] }), null);
    assert.equal(readMacroEvents({ date: "2026-10-29", titles: [] }), null);
    // 空白标题也算没有
    assert.equal(readMacroEvents({ date: "2026-10-29", titles: ["  ", ""] }), null);
  });

  it("全是宏观政策条目 → 分数偏高,且被压在 65 以内", () => {
    const r = readMacroEvents({ date: "2026-10-29", titles: TITLES_HOT })!;
    assert.ok(r);
    assert.equal(r.items, 5);
    assert.ok(r.macro_hits >= 4, `应命中多数宏观条目,实得 ${r.macro_hits}`);
    assert.ok(r.bullish > r.bearish);
    assert.ok(r.score > 50, `利多占优应大于 50,实得 ${r.score}`);
    assert.ok(r.score <= EVENT_SCORE_RANGE.hi, `上限 ${EVENT_SCORE_RANGE.hi},实得 ${r.score}`);
  });

  it("没有宏观条目 → 中性 50,并说明「不是没接入」", () => {
    const r = readMacroEvents({
      date: "2026-10-29",
      titles: ["我国运动员在世界杯夺冠", "某地举办国际马拉松赛", "秋粮收购进度过半"],
    })!;
    assert.ok(r);
    assert.equal(r.macro_hits, 0);
    assert.equal(r.score, 50);
    assert.ok(r.note.includes("无宏观政策条目"));
  });

  it("分数永远落在 35~65(极端输入也不越界)", () => {
    const allBear = readMacroEvents({
      date: "2026-10-29",
      titles: Array.from({ length: 30 }, () => "国务院部署 收紧 上调 加征 限制 禁止 整顿 查处 处罚 下滑 放缓 承压"),
    })!;
    assert.ok(allBear.score >= EVENT_SCORE_RANGE.lo, `下限 ${EVENT_SCORE_RANGE.lo},实得 ${allBear.score}`);
    const allBull = readMacroEvents({
      date: "2026-10-29",
      titles: Array.from({ length: 30 }, () => "国务院政策 降准 降息 减税 降费 补贴 支持 鼓励 扩大 提振 促进 加快 放宽"),
    })!;
    assert.ok(allBull.score <= EVENT_SCORE_RANGE.hi, `上限 ${EVENT_SCORE_RANGE.hi},实得 ${allBull.score}`);
  });

  it("方向词只在宏观条目里算:体育新闻里的「加快」不算利多", () => {
    const r = readMacroEvents({
      date: "2026-10-29",
      titles: ["我国运动员加快冲刺 夺得金牌"],
    })!;
    assert.ok(r);
    assert.equal(r.macro_hits, 0);
    assert.equal(r.bullish, 0, "非宏观条目的方向词不该计入");
    assert.equal(r.score, 50);
  });

  it("样本标题最多 3 条,且都是命中宏观主题的", () => {
    const r = readMacroEvents({ date: "2026-10-29", titles: TITLES_HOT })!;
    assert.ok(r.samples.length <= 3);
    assert.ok(r.samples.length > 0);
    assert.ok(r.samples.every((s) => TITLES_HOT.includes(s)));
  });

  it("note 里带期次日期,能被审计", () => {
    const r = readMacroEvents({ date: "2026-10-29", titles: TITLES_HOT })!;
    assert.ok(r.note.includes("2026-10-29"));
    assert.ok(r.note.includes("5 条"), `应写明条目数,实得「${r.note}」`);
  });

  /**
   * 🔴 真实数据回归(2026-10-29 期,`cctv_news` 实取):
   *    只收「中共中央 / 政治局」时,头条「…中央委员会第五次全体会议公报」一个字都不命中 ——
   *    整期 8 条只认出 1 条,事件面等于瞎的。这条用例锁住「会议 / 公报」这一腿。
   */
  it("真实一期(2026-10-29):五中全会公报必须被认成宏观条目", () => {
    const titles = [
      "中国共产党第二十届中央委员会第五次全体会议公报",
      "张升民同志简历",
      "习近平就西班牙高速列车追尾脱轨事故向西班牙国王致慰问电 李强向西班牙首相致慰问电",
      "【学习贯彻党的二十届五中全会精神】不断开创新时代管党治党、兴党强党新局面",
      "人民日报社论：把我们党建设得更好、更强",
      "三季度末科技型中小企业贷款余额同比增长20.1%",
      "今年以来以旧换新带动相关品类销售额超2万亿元",
      "联播快讯",
    ];
    const r = readMacroEvents({ date: "2026-10-29", titles })!;
    assert.ok(r);
    assert.ok(r.macro_hits >= 4, `8 条里应认出 ≥4 条宏观条目,实得 ${r.macro_hits}`);
    assert.ok(r.samples.includes(titles[0]!), "五中全会公报必须在样本里");
    assert.ok(r.score > 50 && r.score <= EVENT_SCORE_RANGE.hi);
    // 「张升民同志简历」「联播快讯」这类不该算宏观
    assert.ok(!r.samples.includes(titles[1]!));
  });
});
