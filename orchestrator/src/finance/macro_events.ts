/**
 * 宏观事件面读数 —— 事件维度的唯一数据来源。
 *
 * 🔴 只用一个源:央视《新闻联播》文字稿(`cctv_news`)。
 *    选它的四个理由(对应「权威 / 宏观 / 不繁杂 / 少而精」):
 *      - **权威**:中共中央 / 国务院政策发布的官方窗口,口径最正式,不是二手转述;
 *      - **宏观**:条目以时政财经政策为主,天然是宏观面而非个股消息面;
 *      - **不繁杂**:一天一期、20~30 条标题;财联社电报是几百条滚动快讯,做因子太吵;
 *      - **少而精**:`with_content=false` 只取标题(≈1 次请求,不开 15 个详情页),
 *        端点已声明 `cache_max_age_sec=3600` —— 一天真取几次,不占并发额度。
 *
 * 🔴 这是**文本代理指标**,不是事实判断。三条必须写死的局限:
 *    1. 词典只认词,认不出否定与条件 ——「暂缓降准」会被算成利多;
 *    2. 官方表述天然偏正面,极性会系统性偏多(所以强度与极性都压在窄幅里);
 *    3. 它衡量的是「今天宏观面有多少信息、往哪边偏」,不是「明天涨还是跌」。
 *
 *    因此:分数**锁在 35~65**,权重**封顶 8%**(见 market_score.EVENT_WEIGHT_CAP)。
 *    即使整套判断都错了,对综合分的影响也只有 ±2 分,不会把仓位结论带偏。
 *    宁可它「几乎不影响仓位」,也不给它一个看起来精确、其实不可靠的大权重。
 */

/** 事件分上下限:窄幅,防止词典误判直接把综合分拉走 */
export const EVENT_SCORE_RANGE = { lo: 35, hi: 65 } as const;

/**
 * 宏观 / 政策主题词 —— **只判「这条是不是宏观政策 / 宏观数据」,不判方向**。
 *
 * 🔴 分三腿收词,是因为新闻联播的宏观条目有三类固定写法,只收一类会漏:
 *    ① 会议与文件:五中全会公报、政治局会议、国务院常务会议 —— 这是最重的政策发布;
 *    ② 宏观政策与工具:降准降息、财政专项债、关税、房地产、资本市场;
 *    ③ 宏观数据:同比环比、贷款、社融、用电量、进出口 —— 联播里报数据就是宏观面。
 *    收词原则:出现在官方标题里就基本能确定议题属性;不收含糊的舆论词。
 *
 *    ⚠️ 实测教训(2026-10-29 期):只收「中共中央 / 政治局」时,头条
 *    「中国共产党第二十届中央委员会第五次全体会议公报」一个字都不命中 —— 全期只认 1 条。
 *    「全会 / 公报 / 决议」这类写法是联播报道重大会议的固定格式,必须单列。
 */
const MACRO_TOPICS: readonly string[] = [
  // ① 会议与文件
  "全会", "公报", "决议", "政治局", "国务院", "中共中央", "中央委员会",
  "常务会议", "中央经济工作会议", "座谈会", "部署", "规划", "意见", "通知", "条例", "方案", "白皮书",
  // ② 宏观政策与工具
  "政策", "央行", "人民银行", "货币政策", "财政", "专项债", "国债", "降准", "降息", "利率", "汇率",
  "关税", "贸易", "减税", "降费", "补贴", "以旧换新", "扩内需", "促消费",
  "房地产", "楼市", "就业", "物价", "资本市场", "证监会", "改革", "民营经济", "外资", "自贸",
  "新质生产力", "产能", "制造业", "粮食", "能源",
  // ③ 宏观数据
  "同比", "环比", "增加值", "社会融资", "贷款", "信贷", "用电量", "货运量",
  "进出口", "外贸", "社会消费品零售", "固定资产投资", "CPI", "PPI", "PMI",
];

/**
 * 方向词 —— **只收方向明确、官方文本里不含糊的**。
 * 明确剔除的高风险词:「提高」(提高关税=利空)、「风险」(防范化解风险=中性偏正面)、
 * 「关税」(加征/降低两个方向都用)。宁可少收,不要收进来制造反向误判。
 */
const BULLISH: readonly string[] = [
  "降准", "降息", "下调利率", "减税", "降费", "补贴", "支持", "鼓励",
  "扩大", "提振", "促进", "加快", "放宽", "松绑", "新增", "增长",
  "回升", "企稳", "改善", "利好", "超预期", "稳增长", "扩内需",
];

const BEARISH: readonly string[] = [
  "收紧", "上调", "加征", "限制", "禁止", "整顿", "查处", "处罚",
  "违约", "退市", "下滑", "下降", "放缓", "收缩", "承压",
];

export interface MacroEventReading {
  /** 这一期新闻联播的日期(YYYY-MM-DD);通常是前一晚的那期 */
  date: string | null;
  /** 当期条目总数 */
  items: number;
  /** 命中宏观政策主题的条目数 */
  macro_hits: number;
  /** 利多 / 利空词命中数(可重复计,一条标题命中多个词就计多次) */
  bullish: number;
  bearish: number;
  /** 命中的标题样本(最多 3 条,供人审计「这个分是怎么来的」) */
  samples: string[];
  /** 事件分 35~65 */
  score: number;
  /** 一句话说明 */
  note: string;
}

function countHits(text: string, words: readonly string[]): { hits: number; matched: string[] } {
  let hits = 0;
  const matched: string[] = [];
  for (const w of words) {
    if (text.includes(w)) {
      hits++;
      matched.push(w);
    }
  }
  return { hits, matched };
}

/**
 * 把「一期新闻联播的标题」读成一个事件分。
 *
 * @param input.titles 标题数组(端点 `cctv_news_title` 证据里的 value)
 * @param input.date   这一期的日期
 * @returns 一条标题都没有时返回 **null**(取数失败 / 当期未发布),不是 50 ——
 *          「没有数据」和「今天没有宏观事件」是两件事,前者该让渡权重,后者才是中性 50
 */
export function readMacroEvents(input: { date: string | null; titles: string[] }): MacroEventReading | null {
  const titles = (input.titles ?? []).map((t) => String(t ?? "").trim()).filter(Boolean);
  if (!titles.length) return null;

  let macroHits = 0;
  let bullish = 0;
  let bearish = 0;
  const samples: string[] = [];

  for (const t of titles) {
    const topic = countHits(t, MACRO_TOPICS);
    const bull = countHits(t, BULLISH);
    const bear = countHits(t, BEARISH);
    // 方向词只在**宏观条目**里算 —— 一条体育新闻里的「加快」不该影响政策面读数
    if (topic.hits > 0) {
      macroHits++;
      bullish += bull.hits;
      bearish += bear.hits;
      if (samples.length < 3) samples.push(t);
    }
  }

  // 强度腿:每命中 1 条宏观条目 +2 分,最多 +8(4 条封顶)—— 再多也不加分,避免"今天新闻多"就变成"今天利好"
  const strength = Math.min(macroHits * 2, 8);
  // 极性腿:(利多−利空)/(利多+利空+1) 归一化到 [-1,1],再 ×7 → 最多 ±7 分
  const polarity = Math.max(-1, Math.min(1, (bullish - bearish) / (bullish + bearish + 1)));
  const raw = 50 + strength + polarity * 7;
  const score = Math.round(Math.max(EVENT_SCORE_RANGE.lo, Math.min(EVENT_SCORE_RANGE.hi, raw)));

  const when = input.date ? `${input.date} 期` : "当期";
  const note = macroHits === 0
    ? `新闻联播 ${when} ${titles.length} 条，无宏观政策条目（按中性 50 计）`
    : `新闻联播 ${when} ${titles.length} 条，其中宏观 / 政策 / 数据 ${macroHits} 条（利多词 ${bullish} / 利空词 ${bearish}）`;

  return { date: input.date, items: titles.length, macro_hits: macroHits, bullish, bearish, samples, score, note };
}
