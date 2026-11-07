/**
 * 机会发现 —— 一条链：**哪些板块在启动 → 板块里谁是龙头 → 明天这只票怎么看**。
 *
 * 和 `shortline/opportunities.ts` 的分工（两者不重复）：
 *   - 那边是**个股视角**：从涨停池里按形态挑票（首板爆发 / 弱转强 / N 字反包…）；
 *   - 这边是**板块视角**：先判断钱往哪个方向去（题材轮动 + 资金流），再在该方向里排龙头，
 *     最后把「板块—龙头—价位」串成一张条件式规划。个股视角看不到「这个题材是不是刚起来」。
 *
 * 🔴 三条口径，写完就锁死：
 *   1. **排序只用客观量**（今日涨停只数、连板高度、首封时间），不做加权总分。
 *      一加权就得解释权重从哪来，而那个权重是我们拍的，不是市场给的。
 *   2. **独苗不算龙头**：板块只有 1~2 只涨停时，那只是「跑得快的票」，不是板块效应。
 *      沿用龙头维度那条规矩（广度不足时龙头分封顶 55）的同一个逻辑。
 *   3. **能不能动手由市场状态决定，不由这里决定**。先看 `market_state` 的仓位上限：
 *      上限 0% 时这张表里的所有机会都只能是「只观察」，不许因为题材好看就绕过闸门。
 *
 * ── 能力边界（这一路研究的总结论，2026-10-30 实测后写死）────────────────────────
 *
 * 🔴 **本模块只做「启动确认之后」，做不了「启动之前」。这不是没写，是数据源堵死。**
 *
 *   「启动前」需要的先行指标 = 板块还没有涨停潮、但成分股已经在普涨 / 放量 / 资金净流入。
 *   三个候选端点全部撞墙（实测时间 2026-10-30 20:51）：
 *   - `em_industry_comparison`（行业板块涨跌排名）→ **failed**：东财 push2
 *     `RemoteDisconnected`，与 `em_board_fund_flow` 同一个上游故障。
 *   - `em_board_fund_flow`（板块 5/10 日资金流）→ **failed**，同上。→ 拿不到「资金先于涨停进场」。
 *   - `em_concept_blocks`（概念成分）→ **只支持单票**（`需要 symbol`），无法批量拉 5000 只做
 *     「概念 → 成分股涨幅广度」的聚合。→ 拿不到「广度先于涨停」。
 *   - `sina_board_flow` 能通，但只有**当日**净流入、只有行业不含概念、且行业名与题材名不互通。
 *
 *   剩下的所有可用端点（themes / rotation / ladder / live / facts / settled / firstboard / 涨停池）
 *   **起点都是「已经涨停」**。所以本模块的时间分辨率天然是「天」，且最早的确认点是**当天收盘**。
 *
 *   ⇒ 能给的：**今晚确认，明早执行**。
 *   ⇒ 不能给的：**哪天、哪个板块会启动**。
 *
 *   唯一比「3 只涨停」更早的信号，是「昨日 0 只 → 今日 1~2 只」的萌芽（themes 里就有，
 *   36 个题材里有 25 个落在这段、当前被「≥3 只」的阈值滤掉）。但 10/30 实测信噪比很低：
 *   25 个里多数是**同一只票被切成多个题材名**（巴比食品同时属于大消费/中式面点/小笼包/三季报增），
 *   扣掉重复后真正干净的萌芽只有「白酒」1 个（古井贡酒 + 皇台酒业，昨日 0 只）。
 *   → 补萌芽池会引入大量重复噪声，收益不足以抵消误读风险，**暂不做**。
 *
 * 端点盘点（`datasources/registry.json` 共 182 个，全部 enabled；2026-10-30 逐个实测）：
 *
 *   【本页已用】
 *   - `cn_shortline_themes` / `cn_shortline_theme_rotation`：同花顺涨停揭秘 + 东财涨停池，
 *     给「题材 → 涨停数 / 首板 / 连板 / 最高板 / 成员 / 首封时间 / 开板次数」，是这套判断的主干。
 *     ⚠️ 轮动端点冷启 20+ 秒、常被上游标 partial；它挂的时候只能用 themes 的当日结构，判断不了「刚启动」。
 *   - `cn_shortline_board_ladder`（8ms~2s）：封单额 / 流通市值 / 换手 / 末封时间 + 逐档晋级率与断板去向。
 *     **全页最便宜也最硬的一个**：封单占比是「封得死不死」的直接量化，别处拿不到。
 *   - `cn_shortline_live`（单独 7s，与其他端点并行会慢到 40s+）：涨停 / 炸板 / 跌停 / 封板率 /
 *     赚钱效应 / 1进2。**唯一盘中会滚动刷新的端点**（收盘后 phase=「已收盘」）。
 *   - `cn_shortline_cycle`（26.8s，全页最慢）：情绪周期位置，只给「新启动」加时间背景，不参与档位。
 *   - `cn_shortline_facts`（~2s）：封板质量 / 亏钱效应 / 按昨日高度分档的今日去向。
 *     `feedback.matrix` 是全套里**唯一与龙头档位正对应**的证据。
 *   - `cn_shortline_settled`（~2s）：昨日涨停股逐只明细。**只取 `seal_time`**做「封板时点 → 次日表现」。
 *     🔴 2026-10-30 实测：它的 `sector` 是**申万三级**，39 只昨日涨停股散在 **32 个行业**、其中 27 个
 *        只有 1 只 —— 按行业聚合出来是「32 行、每行 1 只」的废表，**行业维度不可用**（原计划想用它
 *        补「题材名与行业名对不上」，实测证伪）。题材成员与它的交集也只有 13/41（成员是**今天**涨停
 *        的票，settled 是**昨日**涨停的票，首板必然 miss），所以也做不了题材×行业穿透。
 *        真正可用的是 `seal_time`（最后封板时间，不是首封）：三档下来再涨停率 43%/16%/0%，是本页
 *        唯一一条「时点」维度的证据。
 *   - `sina_board_flow`（行业资金流，仅当日、仅旁证）/ `tx_quotes_batch`（价位与涨停价）/ `market_state`。
 *
 *   【实测可用、尚未接入 —— 下一轮优先级从高到低】
 *   1. `cn_shortline_firstboard`（2.3s）：38 只首板 + `rebound`（反包）标记 + reason + float_cap。
 *      反包是「启动」最强的形态，本页现在只能从 themes 的成员里间接看。
 *   2. `em_zb_pool`（1.2s）/ `em_yzt_pool`（1.3s）：炸板池 / 昨日涨停今日。炸板是板块走坏的**第一手**信号，
 *      比本页「板块涨停数掉到 N 只以下」这种机械阈值来得早。
 *   3. `ths_hsgt_realtime`（0.8s）：沪深股通分钟累计净买入（262 个点）—— 盘中唯一的分钟级外部资金流。
 *   4. `cn_shortline_settled` 的**历史**：已收盘日的结果长期缓存、越积越长 → 攒够 20 个交易日就能把
 *      「封板时点 → 次日表现」从**单日横截面**升级成**多日统计**。现在只有一个点，不许当规律。
 *
 *   【实测不可用】
 *   - `em_board_fund_flow`（东财 push2）：RemoteDisconnected，板块 5/10 日资金流拿不到 → 不许假装有 5 日趋势。
 *   - `em_industry_comparison`（东财 push2 `clist fs=m:90+t:2`）：同样 RemoteDisconnected（6.9s 超时后断连）。
 *     → 行业涨跌排名拿不到，这是「启动前」最想要的一块，堵在这里。
 *   - `em_hot_rank`：status=failed。
 *
 *   ⚠️ 接口约束（踩过的）：`cn_shortline_themes` 的 `top` 只接受 **3–30**，传 60 会直接 failed
 *      （`ValueError: top 要在 3–30 之间`）。要全量题材口径就得自己分页或改上游。
 *
 *   ⚠️ 命名陷阱：题材名（「三季报增长」「"羊"字辈」）和行业名（「休闲食品」「通用设备」）**不是一套命名，无法 join**。
 *      这一点已被 `settled` 的 `sector` 字段实测证实：39 只昨日涨停股散在 32 个申万三级行业，
 *      说明涨停股本身就不按行业聚 —— 「题材 → 行业」不是命名对不上，而是**根本没有一一对应关系**。
 *      所以资金流只做旁证，不参与打分，也不和题材强行对号；行业维度只剩「和行业指数/ETF 对照」这一个用法。
 *      **也别按名字字面映射**（「科技推广和应用服务业」≠ 半导体），证监会与申万两套口径混用已出过 4 次错。
 *   ⚠️ 口径陷阱：`cn_shortline_live` 的涨停 / 跌停家数与涨跌分布端点（market_state 用的那套）会差几只
 *      （10/30 实测 47/82 vs 49/93）—— 两套上游池子不同，页面上要标清楚，别互相校验。
 */
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../service.ts";
import { clockOf } from "./shortline/intraday.ts";
import { consistencyFor, wantsFresh } from "./snapshot_ttl.ts";
import { marketStateAct } from "./market_state.ts";
import type { MarketSignal } from "./market_state.ts";

// ─── 类型 ───────────────────────────────────────────────────────────────────────

/** 板块（题材）的启动状态。用词都是盘口黑话，但每一条都有明确判据，见 `ignitionOf` */
export type IgnitionState = "新启动" | "加速" | "高位拥挤" | "退潮" | "延续" | "观察";

export interface QuoteLite {
  price: number | null;
  change_pct: number | null;
  turnover_rate: number | null;
  turnover_amount_yi: number | null;
  float_cap_yi: number | null;
  volume_ratio: number | null;
  limit_up_price: number | null;
  last_close: number | null;
  /** 距涨停价还差几个点（已封板 = 0） */
  to_limit_pct: number | null;
}

export interface LeaderPick {
  code: string;
  name: string;
  boards: number;
  first_seal: string | null;
  broken_times: number | null;
  zt_stat: string | null;
  role: "龙头" | "跟风" | "补涨" | "独苗";
  /** 凭什么排在这 —— 全是客观字段，不是评价 */
  why: string[];
  quote: QuoteLite | null;
  /** 封单额（亿元），来自连板天梯；null = 天梯没取到 */
  seal_fund_yi: number | null;
  /**
   * 封单 ÷ 流通市值（%）。这是「封得死不死」的直接量化：
   * 青岛食品 5 板封单 0.57 亿 / 流通 37.9 亿 = 1.5%、换手 25%；
   * 上海沪工 3 板封单 2.58 亿 / 流通 59.1 亿 = 4.4%、换手 3.2% —— 后者硬得多。
   */
  seal_ratio: number | null;
  /**
   * 封单厚度分档（硬 ≥3% / 中 ≥1.5% / 软 <1.5%）。
   * 阈值来自 14 个交易日回溯：>1.5% 次日再涨停 42%、≤1.5% 只有 15%，按日配对 14/14 天方向一致。
   * null = 没拿到封单数据（不是「软」）。
   */
  seal_grade: SealGrade | null;
  /** 末封时间（回封到最后一次的时间） */
  last_seal: string | null;
  /** 涨停原因标签（上游编辑归因，非公司确认） */
  reason_tags: string[];
}

/** 连板天梯里「某一档」的晋级情况 */
export interface PromotionStep {
  /** 该档的**今日高度** */
  boards: number;
  /**
   * 🔴 分母是「昨日处在 ${boards-1} 板的只数」，分子是其中今天上到 ${boards} 板的只数。
   *    即统计的是 **${boards-1} → ${boards} 这一跳**，不是 ${boards} → ${boards+1}。
   *    （证据：boards=5 这一档，fell 里是「光洋股份 4板 → 没涨停」）
   *    所以它描述的是「到达当前高度有多难」，**不能**直接当龙头明天的晋级概率。
   */
  base: number;
  /** 其中今天晋级成功的只数 */
  promoted: number;
  /** 晋级率 = promoted / base */
  rate: number | null;
  /** 没接上的票去了哪（炸板 / 跌停 / 没涨停），带当日涨跌幅 */
  fell: { code: string; name: string; prev_label: string | null; outcome: string; ret: number | null }[];
}

/**
 * 情绪周期位置（`cn_shortline_cycle`）。
 *
 * 🔴 它的用途只有一个：**给「新启动」加时间背景**。
 *    同样叫「新启动」，「低点后第 2 天、分位 21%」和「第 8 天、分位 90%」是完全不同的两件事，
 *    而 `ignitionOf` 只看得到今天和昨天。这个字段不能拿来单独下结论，也不参与任何档位计算。
 */
export interface CyclePosition {
  /** 回看的交易日窗口 */
  window: number;
  /** 窗口内低点的日期与相对分 */
  trough_date: string | null;
  trough_score: number | null;
  current_score: number | null;
  current_date: string | null;
  /** 距低点第几个交易日 */
  day_n: number | null;
  rising: boolean | null;
  /** 上游的趋势词，如「今日走强」 */
  trend: string | null;
  /** 当前分在窗口内的分位（0~1）：越低说明现在还在低位 */
  pctile: number | null;
  series: { date: string; score: number | null; limit_up: number | null; highest_consec: number | null; broken_rate: number | null }[];
}

/**
 * 打板反馈：昨日各档涨停股今天去了哪（`cn_shortline_facts` 的 feedback.matrix）。
 *
 * 🔴 这是全套里**唯一与龙头档位正对应**的证据：
 *    `tier = "3板"` 统计的是「昨日 3 板的票今天表现如何」，
 *    所以今天我 3 板的龙头，明天走的就是这个分布。
 *    （对比：连板天梯 `boards=3` 统计的是「昨日 2 板→今日 3 板」，那是上一个档位，不能直接套。）
 */
export interface TierOutcome {
  /** 昨日所处高度："首板" / "2板" / "3板" … */
  tier: string;
  /** 该档昨日只数 */
  total: number;
  /** 各去向只数，按上游 order（晋级涨停 → 收红 → 小跌 → 跌超5% → 跌停） */
  buckets: { label: string; count: number }[];
  promoted: number;
  /** 晋级率 = promoted / total */
  promotion_rate: number | null;
  /** 其中跌停只数 —— 这一档「打错了」的代价 */
  limit_down: number;
}

/** 盘面事实（`cn_shortline_facts`）：封板质量 + 亏钱效应 + 分档反馈 + 分涨跌幅制度 */
export interface MarketFacts {
  prev_date: string | null;
  sample: number | null;
  /** 封板质量：47 只里 26 只从没开过板（55.3%）、平均开板 1.81 次 */
  seal_quality: {
    total: number | null;
    never_broken: number | null;
    never_broken_rate: number | null;
    avg_broken_times: number | null;
    late_seal: number | null;
    reopened: number | null;
    ever_opened_rate: number | null;
  } | null;
  /** 亏钱效应：昨日涨停股今天跌超 5% 的比例、跌停只数、最差一只 */
  loss_effect: {
    deep_loss_5_count: number | null;
    deep_loss_5_rate: number | null;
    deep_loss_7_count: number | null;
    limit_down_count: number | null;
    worst: number | null;
  } | null;
  /** 按昨日高度分层的今日去向 */
  tiers: TierOutcome[];
  /** 分涨跌幅制度（10cm / 20cm） */
  by_board: { board: string; limit_up: number | null; highest: number | null; prev_base: number | null; promoted: number | null; broken: number | null; promotion_rate: number | null }[];
}

/**
 * 封板时间分档：昨日「最后封板时间」落在这一档的涨停股，今天怎么样了。
 *
 * 🔴 这是 `cn_shortline_settled` 唯一不可替代的增量 —— 它的 `sector`（申万三级）
 *    实测不可用：10/30 的 39 只昨日涨停股散在 **32 个行业**，27 个行业只有 1 只，
 *    按行业聚合出来是「32 行、每行 1 只」的废表；而题材成员（今天涨停的票）与它
 *    （昨日涨停的票）交集只有 13/41，首板必然 miss。所以行业维度**不做**。
 *
 * ⚠️ 两个必须守住的边界：
 *    ① `seal_time` 是**最后封板时间**，不是首封（registry notes 明确写死）；
 *    ② 这是**单日横截面**，n=39。别把某一天的「43% → 16% → 0%」说成统计规律。
 */
export interface SealBucket {
  label: string;
  /** 这一档昨日涨停只数 */
  n: number;
  still_up: number;
  still_up_rate: number;
  avg_ret: number;
  /** 今日收红比例 */
  win_rate: number;
  /** 今日跌 ≤ -5% 的只数 */
  deep_loss: number;
  deep_loss_rate: number;
}

export interface SealTiming {
  date: string | null;
  prev_date: string | null;
  /** 昨日涨停样本只数 */
  sample: number;
  /** 上游给的覆盖率（39/39 = 1）。null = 没给 */
  coverage_rate: number | null;
  /** 上游标 partial（当日未收盘）时为 true */
  partial: boolean;
  buckets: SealBucket[];
  /**
   * 多日累计（默认近 20 个交易日）。
   *
   * 🔴 这是同一批数据**按日期扇出**回溯出来的，不是「一天天攒」——
   *    `cn_shortline_settled` 带 `date` 参数，东财保留约一个月，够 20 个交易日。
   *    单日只有三四十只，一档十几只，说「43%」其实没有统计意义；20 天累计后每档几百只才站得住。
   *
   *    null = 一天都没回溯成功（那才叫只能看单日）。
   */
  trend: SealTrend | null;
}

/** 多日累计的封板时点表现 */
export interface SealTrend {
  /** 成功拿到并聚合的交易日数 */
  days: number;
  /** 尝试过的日期数（含周末外的失败、非交易日） */
  tried: number;
  from_date: string | null;
  to_date: string | null;
  /** 所有交易日各档 n 之和 */
  sample: number;
  buckets: SealBucket[];
}

/** 盘中「此刻」读数（cn_shortline_live，盘中会刷新，收盘后定格） */
export interface LiveEmotion {
  /** 上游给的相位词：「已收盘」/ 盘中 */
  phase: string | null;
  settled: boolean;
  limit_up: number | null;
  broken: number | null;
  limit_down: number | null;
  highest_board: number | null;
  consec_count: number | null;
  /** 封板率 = 涨停 / (涨停 + 炸板) */
  seal_rate: number | null;
  broken_rate: number | null;
  /** 全档晋级率（昨日涨停今日又涨停的比例） */
  promotion_all: number | null;
  /** 1 进 2 晋级率 */
  promotion_1to2: number | null;
  /** 昨日涨停股今日中位涨幅（%）：负数就是打板在亏钱 */
  money_effect: number | null;
  /** 昨日涨停今日跌超 5% 的只数 */
  deep_loss: number | null;
  sample: number | null;
  as_of: string | null;
}

export interface SectorIgnition {
  tag: string;
  state: IgnitionState;
  /** 今日涨停只数 */
  today: number;
  /** 近 N 个交易日的涨停只数序列（缺数为 null） */
  series: (number | null)[];
  ranks: (number | null)[];
  first_boards: number;
  consec_boards: number;
  highest: number;
  /** 题材内涨停股中**开板过**的只数（不是全市场炸板数，见 `ThemeNode.broken`） */
  broken: number;
  /** 首板 ÷ 涨停：越高说明是新资金扩散，不是老龙头独扛 */
  diffusion: number | null;
  active_days: number;
  top3_days: number;
  /** 该题材内跌停只数（与涨停数并存 → 内部已在分化） */
  limit_down: number;
  /**
   * 昨日涨停股今天的延续情况。
   * 🔴 `rate === null` 表示「昨日这个题材一只涨停都没有」= 真·新出现，
   *    和「昨日有 11 只、今天只剩 3 只」（rate 0.273）是**完全相反**的两件事。
   *    早先只判「今日涨停只数 + 名次」，把这两种情况都叫「新启动」，是错的。
   */
  continuation: {
    /** 昨日该题材涨停只数 */
    prev_limit_up: number;
    /** 其中今天仍涨停 */
    still_up: number;
    /** 其中今天炸板或下跌 */
    broken_or_down: number;
    /** null = 昨日没有这个题材 */
    rate: number | null;
  };
  /** 上游状态词，与我方 state 是两套口径，并列显示 */
  upstream_state: string | null;
  /** 成员明细只给了几只（上游截断到 8 只，但按板数降序，龙头一定在） */
  members_shown: number;
  /** 命中的判据，逐条写出来 */
  evidence: string[];
  leaders: LeaderPick[];
  /** 板块整体是否有资格谈"龙头"（≥3 只涨停且高度 ≥2） */
  has_sector_effect: boolean;
  /**
   * 该板块最高板这一档的晋级情况（来自连板天梯）。
   * null = 天梯没取到，或这个高度没有可比档位。
   * 🔴 两层别混：① 天梯按**高度**分档，不按题材分档，它不是「板块晋级率」；
   *    ② 它统计的是 `highest-1 → highest`，不是龙头明天的 `highest → highest+1`。
   */
  promotion: PromotionStep | null;
}

/** 条件式规划：只给「看什么 / 什么算触发 / 什么算失效」，不给买卖动作 */
export interface PlanDraft {
  sector: string;
  symbol: string;
  name: string;
  role: LeaderPick["role"];
  /** 由市场状态仓位上限决定；不是这里决定的 */
  allowance: "可参与" | "只观察" | "不参与";
  allowance_note: string;
  watch: string[];
  trigger: string[];
  invalidate: string[];
  sizing: string;
}

export interface OpportunityResult {
  date: string;
  clock: string;
  settled: boolean;
  /** 市场状态（联动闸门）：没有它就不给「可参与」 */
  market: {
    phase: MarketSignal["phase"];
    composite: number | null;
    position_cap_pct: number | null;
    risk_level: MarketSignal["risk_level"];
    can_open_position: boolean | null;
    gate_blockers: string[];
  } | null;
  sectors: SectorIgnition[];
  /** 盘中「此刻」读数；null = 端点没取到。收盘后它是定格的收盘值 */
  live: LiveEmotion | null;
  /** 情绪周期位置：只用来给「新启动」加时间背景，不参与档位计算。null = 端点没取到（它要回看 10 天，最慢） */
  cycle: CyclePosition | null;
  /** 打板反馈：封板质量 / 亏钱效应 / 各档昨日涨停股今天的去向。null = 端点没取到 */
  facts: MarketFacts | null;
  /**
   * 封板时间 → 次日表现。null = 端点没取到。
   * 与 facts 同源（同一批昨日涨停股），增量只有「最后封板时间」这一维。
   */
  seal_timing: SealTiming | null;
  /** 行业资金流只做旁证（题材名与行业名对不上，见文件头） */
  board_flow: {
    available: boolean;
    /** 净流入前列的行业（当日口径） */
    top: { name: string; net_yi: number | null; change_pct: number | null; note: string | null }[];
    note: string;
  };
  plans: PlanDraft[];
  /** 这一轮缺了什么、为什么缺 */
  gaps: string[];
  notes: string[];
  sources: string[];
}

// ─── 取数 ───────────────────────────────────────────────────────────────────────

const QUOTE_CHUNK = 50;

/** 代码 → 腾讯行情代码（6 开头沪市、8/4 开头北交所，其余深市） */
function quoteCodeOf(code: string): string {
  if (/^(6|9)/.test(code)) return `sh${code}`;
  if (/^(4|8)/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

function envelopeOf(r: FetchResult | null): Record<string, unknown> | null {
  if (!r) return null;
  const env = r.envelope as Record<string, unknown> | undefined;
  return env ?? null;
}

function resultOf(r: FetchResult | null): Record<string, unknown> | null {
  const env = envelopeOf(r);
  const extra = env?.extra as Record<string, unknown> | undefined;
  const res = extra?.result as Record<string, unknown> | undefined;
  return res ?? null;
}

function evidenceOf(r: FetchResult | null): Record<string, unknown>[] {
  const env = envelopeOf(r);
  const ev = env?.evidence;
  return Array.isArray(ev) ? (ev as Record<string, unknown>[]) : [];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v)
      : null;

// ─── ① 板块启动 ─────────────────────────────────────────────────────────────────

export interface RotationTopic {
  tag: string;
  series: (number | null)[];
  ranks: (number | null)[];
  today: number;
  active_days: number;
  top3_days: number;
  status: string | null;
}

function rotationTopics(r: FetchResult | null): RotationTopic[] {
  const rot = resultOf(r)?.rotation as Record<string, unknown> | undefined;
  const list = rot?.themes;
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    const o = x as Record<string, unknown>;
    const series = Array.isArray(o.series) ? (o.series as unknown[]).map(num) : [];
    const ranks = Array.isArray(o.ranks) ? (o.ranks as unknown[]).map(num) : [];
    return {
      tag: String(o.tag ?? ""),
      series,
      ranks,
      today: num(o.today) ?? 0,
      active_days: num(o.active_days) ?? 0,
      top3_days: num(o.top3_days) ?? 0,
      status: typeof o.status === "string" ? o.status : null,
    };
  }).filter((t) => t.tag);
}

export interface ThemeNode {
  tag: string;
  limit_up: number;
  first_boards: number;
  consec_boards: number;
  highest: number;
  /**
   * 该题材**涨停股中开板过**的只数。
   * 🔴 不是「炸板数」：炸板是没封住、根本不在涨停池里。这里统计的是封住了但中途开过板的。
   *    10/30 实测：全市场炸板 31 只（live），但题材内开板合计只有 2 只（商业航天）。
   *    早先把两个当一件事，页面上写「炸板 0」而全市场炸了 31 只 —— 标签错了。
   */
  broken: number;
  /** 该题材内的跌停只数：「三季报增长」15 只涨停同时有 2 只跌停 —— 内部已在分化 */
  limit_down: number;
  members: ThemeMember[];
  /** 昨日该题材的涨停只数（0 = 昨日这个题材不存在） */
  prev_limit_up: number;
  /** 昨日涨停股里今天仍涨停的只数 */
  prev_still_up: number;
  /** 昨日涨停股里今天炸板或下跌的只数 */
  prev_broken_or_down: number;
  /**
   * 延续率 = prev_still_up / prev_limit_up。
   * 🔴 null 的含义是「昨日这个题材一只涨停都没有」，**不是 0%**。
   *    0.273 才是「昨日有 11 只，今天只剩 3 只」。
   */
  continuation_rate: number | null;
  /** 上游状态词（扩散中 / 今日新出现 / 分歧加大）。
   *  与我方 `ignitionOf` 是**两套口径**，并列显示，不一致时不互相覆盖 */
  upstream_state: string | null;
  first_seal: string | null;
  last_seal: string | null;
}

export interface ThemeMember {
  code: string;
  name: string;
  boards: number;
  zt_stat: string | null;
  first_seal: string | null;
  broken_times: number | null;
}

/**
 * 昨日数据是否**确认覆盖完整**。
 * 题材结构端点会自报 `has_prev` / `prev_covered` / `prev_total` —— 三个都齐了才敢说
 * 「昨日这个题材一只涨停都没有」。否则那只是没取到，不能当结论。
 */
function prevReliableOf(r: FetchResult | null): boolean {
  const tree = resultOf(r)?.tree as Record<string, unknown> | undefined;
  if (!tree) return false;
  const covered = num(tree.prev_covered);
  const total = num(tree.prev_total);
  return tree.has_prev === true && covered != null && total != null && total > 0 && covered >= total;
}

/**
 * 题材结构（`cn_shortline_themes`）。
 * ⚠️ 两个截断要知道：
 *    - `members` 只给**前 8 只**（`limit_up` 可能是 15），但按板数降序 → 龙头一定在里面；
 *    - 题材只给前 12 个 + 最多 6 个「昨日有、今天没再涨停」的。
 */
function themeNodes(r: FetchResult | null): ThemeNode[] {
  const tree = resultOf(r)?.tree as Record<string, unknown> | undefined;
  const list = tree?.themes;
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    const o = x as Record<string, unknown>;
    const ms = Array.isArray(o.members) ? (o.members as Record<string, unknown>[]) : [];
    return {
      tag: String(o.tag ?? ""),
      limit_up: num(o.limit_up) ?? 0,
      first_boards: num(o.first_boards) ?? 0,
      consec_boards: num(o.consec_boards) ?? 0,
      highest: num(o.highest) ?? 0,
      broken: num(o.broken) ?? 0,
      limit_down: num(o.limit_down) ?? 0,
      // prev_members 是**数字**（昨日涨停数），不是成员数组 —— 别当数组去 map
      prev_limit_up: num(o.prev_members) ?? 0,
      prev_still_up: num(o.prev_still_up) ?? 0,
      prev_broken_or_down: num(o.prev_broken_or_down) ?? 0,
      continuation_rate: num(o.continuation_rate),
      upstream_state: typeof o.state === "string" ? o.state : null,
      first_seal: typeof o.first_seal === "string" ? o.first_seal : null,
      last_seal: typeof o.last_seal === "string" ? o.last_seal : null,
      members: ms.map((m) => ({
        code: String(m.code ?? ""),
        name: String(m.name ?? ""),
        boards: num(m.boards) ?? 0,
        zt_stat: typeof m.zt_stat === "string" ? m.zt_stat : null,
        first_seal: typeof m.first_seal === "string" ? m.first_seal : null,
        broken_times: num(m.broken_times),
      })).filter((m) => m.code),
    };
  }).filter((t) => t.tag);
}

// ─── 连板天梯 / 盘中此刻（两个补硬度的端点） ──────────────────────────────────────

/** 天梯里单只票的封板细节，按代码索引 */
interface SealInfo {
  seal_fund: number | null;
  float_cap: number | null;
  turnover: number | null;
  last_seal: string | null;
  tags: string[];
}

interface LadderRead {
  /** code → 封板细节 */
  sealByCode: Map<string, SealInfo>;
  /** 高度 → 该档晋级情况 */
  byBoards: Map<number, PromotionStep>;
}

/**
 * 连板天梯（`cn_shortline_board_ladder`）。它给两样别处拿不到的东西：
 *   ① 每只涨停股的**封单额 / 流通市值 / 换手 / 末封时间** → 「封得死不死」；
 *   ② 每一档高度的**晋级率 + 断板票去向**（炸板 / 跌停 / 没涨停，带当日涨跌幅）。
 * ② 是「板块龙头明天接不接得上」最直接的证据 —— 比任何我们拍的阈值都硬。
 */
function ladderOf(r: FetchResult | null): LadderRead {
  const out: LadderRead = { sealByCode: new Map(), byBoards: new Map() };
  const ladder = resultOf(r)?.ladder as Record<string, unknown> | undefined;
  const levels = ladder?.levels;
  if (!Array.isArray(levels)) return out;
  for (const raw of levels) {
    const lv = raw as Record<string, unknown>;
    const boards = num(lv.boards) ?? 0;
    const stocks = Array.isArray(lv.stocks) ? (lv.stocks as Record<string, unknown>[]) : [];
    const fellRaw = Array.isArray(lv.fell) ? (lv.fell as Record<string, unknown>[]) : [];
    for (const s of stocks) {
      const code = String(s.code ?? "");
      if (!code) continue;
      out.sealByCode.set(code, {
        seal_fund: num(s.seal_fund),
        float_cap: num(s.float_cap),
        turnover: num(s.turnover),
        last_seal: typeof s.last_seal === "string" ? s.last_seal : null,
        tags: Array.isArray(s.tags) ? (s.tags as unknown[]).map(String).filter(Boolean) : [],
      });
    }
    const base = num(lv.base);
    const promoted = num(lv.promoted);
    out.byBoards.set(boards, {
      boards,
      base: base ?? 0,
      promoted: promoted ?? 0,
      rate: base && base > 0 && promoted != null ? Math.round((promoted / base) * 1000) / 1000 : null,
      fell: fellRaw.map((f) => ({
        code: String(f.code ?? ""),
        name: String(f.name ?? ""),
        prev_label: typeof f.prev_label === "string" ? f.prev_label : null,
        outcome: String(f.outcome ?? ""),
        ret: num(f.ret),
      })).filter((f) => f.code),
    });
  }
  return out;
}

/** 盘中此刻读数（`cn_shortline_live`）。收盘后 phase = 「已收盘」，盘中是滚动值 */
function liveOf(r: FetchResult | null): LiveEmotion | null {
  const res = resultOf(r);
  const live = res?.live as Record<string, unknown> | undefined;
  if (!live) return null;
  return {
    phase: typeof res?.phase === "string" ? res.phase : null,
    settled: res?.settled === true,
    limit_up: num(live.limit_up),
    broken: num(live.broken),
    limit_down: num(live.limit_down),
    highest_board: num(live.highest_board),
    consec_count: num(live.consec_count),
    seal_rate: num(live.seal_rate),
    broken_rate: num(live.broken_rate),
    promotion_all: num(live.promotion_all),
    promotion_1to2: num(live.promotion_1to2),
    money_effect: num(live.money_effect),
    deep_loss: num(live.deep_loss),
    sample: num(live.sample),
    as_of: typeof res?.as_of === "string" ? res.as_of : null,
  };
}

/** "首板" / "3板" → 数字，用来排序 */
function tierBoards(tier: string): number {
  if (/首板/.test(tier)) return 1;
  const m = tier.match(/(\d+)\s*板/);
  return m ? Number(m[1]) : 99;
}

/**
 * 盘面事实（`cn_shortline_facts`）。10/30 实测 ~2 秒。
 * 它给的四个块里，本页只用其中三块：
 *   - `seal_quality` 封板质量（47 只里 26 只从没开过板、平均开板 1.81 次）→ 全局背景
 *   - `loss_effect` 亏钱效应（昨日涨停股今天跌超 5% 的比例、跌停只数、最差一只）→ 全局背景
 *   - `feedback.matrix` 各档昨日涨停股今天的去向 → **唯一与龙头档位正对应的证据**
 * 第四块 `themes` 是**申万行业口径**的涨停结构，与「题材口径」是两套划分，
 * 强塞进同一屏会让读者以为能互相替代，所以不接（结论记在文件头）。
 */
function factsOf(r: FetchResult | null): MarketFacts | null {
  const res = resultOf(r);
  if (!res) return null;
  const sq = res.seal_quality as Record<string, unknown> | undefined;
  const le = res.loss_effect as Record<string, unknown> | undefined;
  const fb = res.feedback as Record<string, unknown> | undefined;
  const matrix = fb?.matrix as Record<string, Record<string, unknown>> | undefined;
  if (!sq && !le && !matrix) return null;

  const order = Array.isArray(fb?.result_order) ? (fb!.result_order as unknown[]).map(String) : ["晋级涨停", "收红", "小跌", "跌超5%", "跌停"];
  const tiers: TierOutcome[] = matrix
    ? Object.entries(matrix).map(([tier, row]) => {
      const total = num(row["合计"]) ?? 0;
      const buckets = order
        .map((label) => ({ label, count: num(row[label]) ?? 0 }))
        .filter((b) => b.count > 0);
      const promoted = num(row["晋级涨停"]) ?? 0;
      return {
        tier,
        total,
        buckets,
        promoted,
        promotion_rate: total > 0 ? Math.round((promoted / total) * 1000) / 1000 : null,
        limit_down: num(row["跌停"]) ?? 0,
      };
    }).sort((a, b) => tierBoards(a.tier) - tierBoards(b.tier))
    : [];

  const bb = res.by_board as Record<string, unknown> | undefined;
  const boardsObj = bb?.boards as Record<string, Record<string, unknown>> | undefined;
  const byBoard = boardsObj
    ? Object.entries(boardsObj).map(([board, v]) => ({
      board,
      limit_up: num(v.limit_up),
      highest: num(v.highest),
      prev_base: num(v.prev_base),
      promoted: num(v.promoted),
      broken: num(v.broken),
      promotion_rate: num(v.promotion_rate),
    }))
    : [];

  return {
    prev_date: typeof res.prev_date === "string" ? res.prev_date : null,
    sample: num(fb?.sample),
    seal_quality: sq
      ? {
        total: num(sq.total),
        never_broken: num(sq.never_broken),
        never_broken_rate: num(sq.never_broken_rate),
        avg_broken_times: num(sq.avg_broken_times),
        late_seal: num(sq.late_seal),
        reopened: num(sq.reopened),
        ever_opened_rate: num(sq.ever_opened_rate),
      }
      : null,
    loss_effect: le
      ? {
        deep_loss_5_count: num(le.deep_loss_5_count),
        deep_loss_5_rate: num(le.deep_loss_5_rate),
        deep_loss_7_count: num(le.deep_loss_7_count),
        limit_down_count: num(le.limit_down_count),
        worst: num(le.worst),
      }
      : null,
    tiers,
    by_board: byBoard,
  };
}

/** "093000" / "0930" → 从 0 点起的分钟数。取不到返回 null（不猜） */
function minutesOf(hms: string | null | undefined): number | null {
  if (!hms) return null;
  const d = String(hms).replace(/\D/g, "");
  if (d.length < 4) return null;
  const h = Number(d.slice(0, 2));
  const m = Number(d.slice(2, 4));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * 封板时间的三个档。**刻意只分三档**，不是四档：
 * 10/30 实测四档（<10:00 / 10:00-11:30 / 11:30-14:00 / >14:00）里，
 * 中间两档方向相反（-2.3% 与 +5.3%），各只有 14 / 5 只 —— 拆开看是噪声。
 * 并成「10:00-14:00」后 n=19、再涨停 16%，两端与中间才构成单调。
 */
const SEAL_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "10:00 前", lo: 0, hi: 600 },
  { label: "10:00-14:00", lo: 600, hi: 840 },
  { label: "14:00 后", lo: 840, hi: 24 * 60 },
];

/**
 * 一批 rows（某一天的「昨日涨停股今天表现」）→ 三档。
 * 每个档位的比例都按**本档 n** 算，不是按全样本，否则档位之间不能横向比。
 */
function bucketsOf(rows: Record<string, unknown>[]): SealBucket[] {
  const buckets: SealBucket[] = [];
  for (const b of SEAL_BUCKETS) {
    const hit = rows.filter((x) => {
      const t = minutesOf(typeof x.seal_time === "string" ? x.seal_time : null);
      return t != null && t >= b.lo && t < b.hi;
    });
    if (!hit.length) continue;
    const rets = hit.map((x) => num(x.ret) ?? 0);
    const stillUp = hit.filter((x) => x.limit_up === true).length;
    const deep = rets.filter((v) => v <= -5).length;
    const n = hit.length;
    buckets.push({
      label: b.label,
      n,
      still_up: stillUp,
      still_up_rate: Math.round((stillUp / n) * 1000) / 1000,
      avg_ret: Math.round((rets.reduce((a, v) => a + v, 0) / n) * 100) / 100,
      win_rate: Math.round((rets.filter((v) => v > 0).length / n) * 1000) / 1000,
      deep_loss: deep,
      deep_loss_rate: Math.round((deep / n) * 1000) / 1000,
    });
  }
  return buckets;
}

/**
 * 把多天的三档按 n 加权合并。
 *
 * 🔴 不能用「各天的比率求平均」—— 一天 3 只、另一天 40 只，平均会把 3 只那天的话语权放大 13 倍。
 *    必须回到分子分母：Σ(比率 × n) / Σn。
 */
function aggregateBuckets(perDay: SealBucket[][]): SealBucket[] {
  const out: SealBucket[] = [];
  for (const b of SEAL_BUCKETS) {
    let n = 0, stillUp = 0, deep = 0, winSum = 0, retSum = 0;
    for (const day of perDay) {
      const hit = day.find((x) => x.label === b.label);
      if (!hit) continue;
      n += hit.n;
      stillUp += hit.still_up;
      deep += hit.deep_loss;
      winSum += hit.win_rate * hit.n;
      retSum += hit.avg_ret * hit.n;
    }
    if (!n) continue;
    out.push({
      label: b.label,
      n,
      still_up: stillUp,
      still_up_rate: Math.round((stillUp / n) * 1000) / 1000,
      avg_ret: Math.round((retSum / n) * 100) / 100,
      win_rate: Math.round((winSum / n) * 1000) / 1000,
      deep_loss: deep,
      deep_loss_rate: Math.round((deep / n) * 1000) / 1000,
    });
  }
  return out;
}

/**
 * 封板时间 → 次日表现（`cn_shortline_settled`，~2 秒）。
 *
 * 🔴 只取 `seal_time` 这一维，**不做行业聚合** —— 理由见 `SealBucket` 注释
 *    （39 只散在 32 个申万三级行业，聚合出来每行 1 只，没有意义）。
 */
function sealTimingOf(r: FetchResult | null): SealTiming | null {
  const res = resultOf(r);
  if (!res) return null;
  const rows = Array.isArray(res.rows) ? (res.rows as Record<string, unknown>[]) : [];
  if (!rows.length) return null;

  const buckets = bucketsOf(rows);
  if (!buckets.length) return null;

  return {
    date: typeof res.date === "string" ? res.date : null,
    prev_date: typeof res.prev_date === "string" ? res.prev_date : null,
    sample: num(res.sample) ?? rows.length,
    coverage_rate: num(res.coverage_rate),
    partial: res.partial === true,
    buckets,
    trend: null,
  };
}

/**
 * 情绪周期位置（`cn_shortline_cycle`）。10/30 实测 26.8 秒 —— 是全套里最慢的一个，
 * 只回看 10 个交易日的涨停 / 炸板池。挂了不影响前面任何判断，所以单独超时、单独报缺口。
 */
function cycleOf(r: FetchResult | null): CyclePosition | null {
  const c = resultOf(r)?.cycle as Record<string, unknown> | undefined;
  if (!c || c.available !== true) return null;
  const ser = Array.isArray(c.series) ? (c.series as Record<string, unknown>[]) : [];
  return {
    window: num(c.window) ?? 0,
    trough_date: typeof c.trough_date === "string" ? c.trough_date : null,
    trough_score: num(c.trough_score),
    current_score: num(c.current_score),
    current_date: typeof c.current_date === "string" ? c.current_date : null,
    day_n: num(c.day_n),
    rising: typeof c.rising === "boolean" ? c.rising : null,
    trend: typeof c.trend === "string" ? c.trend : null,
    pctile: num(c.pctile),
    series: ser.map((x) => ({
      date: String(x.date ?? ""),
      score: num(x.score),
      limit_up: num(x.limit_up),
      highest_consec: num(x.highest_consec),
      broken_rate: num(x.broken_rate),
    })).filter((x) => x.date),
  };
}

/**
 * 判「启动」的规则（互斥，按优先级取第一个命中的）。
 *
 * 主证据是**涨停只数 + 名次 + 昨日涨停股今天的延续率**这三个客观量 ——
 * 题材资金流拿不到（见文件头端点盘点），只能靠「有没有更多的票在同一个理由下涨停」来代理
 * 「钱是不是在进来」。这是代理，不是证据，所以每条规则都写成一句能被反驳的话，摆在页面上。
 *
 * @param t 轮动序列（含今日）
 * @param node 今日题材结构（涨停数对不上时以 node 为准，轮动序列可能含缺数）
 * @param prevReliable 昨日数据是否**确认覆盖完整**（题材结构端点的 has_prev && prev_covered === prev_total）。
 *   只有为 true 时，才允许把 `prev_limit_up === 0` 当成「昨日这个题材一只涨停都没有」这个结论。
 *   🔴 默认 false：宁可说「判断不了」，也不许把「没取到」读成「昨日是 0」。
 */
export function ignitionOf(
  t: RotationTopic,
  node: ThemeNode | null,
  prevReliable = false,
): { state: IgnitionState; evidence: string[] } {
  const s = t.series;
  const r = t.ranks;
  const today = node ? node.limit_up : t.today;
  // 序列最后一位可能就是今天；取前一位当昨日
  const prev = s.length >= 2 ? s[s.length - 2] : null;
  const prevRank = r.length >= 2 ? r[r.length - 2] : null;
  const todayRank = r.length >= 1 ? r[r.length - 1] : null;
  const ev: string[] = [];

  /**
   * 延续率的一句话：null 与 0% 是相反的两件事，措辞必须分开。
   *
   * 🔴 三个坑：
   *   ① `continuation_rate == null` 有两种含义 —— 「昨日这个题材不存在」和「昨日数据没覆盖」。
   *      只有 `prevReliable` 为 true 才能说前者；否则什么都不说。
   *   ② 即使 `prevReliable`，也**只有在没有轮动序列时**才用这条 ——
   *      两个端点的「昨日涨停数」会差 1~2 只（10/30 实测：三季报扭亏轮动说 1 只、结构说 0 只；
   *      商业航天轮动说 7 只、结构说 6 只）。有序列时以序列为准，同时写两句会自相矛盾。
   *   ③ 分母很小时（1 只）的 0% 不是「全灭」，只是样本太小，必须标出来。
   */
  const continuationNote = (hasSeries: boolean): string | null => {
    if (!node) return null;
    if (node.continuation_rate == null) {
      if (hasSeries) return null; // 序列已经给了昨日数字，别再用另一套口径覆盖它
      return node.prev_limit_up === 0 && prevReliable
        ? "昨日这个题材一只涨停都没有（昨日覆盖完整），是全新的方向"
        : null;
    }
    const pct = Math.round(node.continuation_rate * 1000) / 10;
    const parts = [
      `昨日 ${node.prev_limit_up} 只涨停股今日只有 ${node.prev_still_up} 只仍涨停`,
      `延续率 ${pct}%`,
    ];
    if (node.prev_broken_or_down > 0) parts.push(`${node.prev_broken_or_down} 只炸板或下跌`);
    const tail = node.prev_limit_up < 3
      ? `；⚠️ 样本只有 ${node.prev_limit_up} 只，这个比例参考意义很弱`
      : node.prev_still_up === 0
        ? "；昨日那批票一只都没接上"
        : "";
    return `${parts.slice(0, 1).join("")}（${parts.slice(1).join("，")}）${tail}`;
  };

  if (today === 0 && (prev ?? 0) > 0) {
    ev.push(`昨日 ${prev} 只涨停，今日 0 只`);
    return { state: "退潮", evidence: ev };
  }

  /**
   * 🔴 没有序列 ≠ 刚启动。轮动端点要抓 5 天涨停池（冷启 20 秒上下），挂了是常态；
   *    此时不能拿缺数当「昨天是 0」。
   *
   *    但**有另一条硬证据可以替代序列**：题材结构端点自己给了「昨日该题材涨停 0 只」，
   *    且它明确说昨日覆盖完整 —— 那就是真·新出现，不需要序列。
   *    早先这种情况一律落到「观察」，等于把已经拿到的证据丢了。
   */
  if (s.length < 2) {
    ev.push(`今日 ${today} 只涨停`);
    if (node) ev.push(`首板 ${node.first_boards} 只 / 连板 ${node.consec_boards} 只 / 最高 ${node.highest} 板`);
    const fresh = node != null && prevReliable && node.prev_limit_up === 0 && today >= 3;
    if (fresh) {
      ev.push("昨日这个题材一只涨停都没有（题材结构端点确认昨日覆盖完整）→ 全新方向");
      ev.push("但轮动端点缺数，看不到近 5 日名次变化，不给强度档位");
      return { state: "新启动", evidence: ev };
    }
    ev.push("没有近 5 日涨停只数序列（题材轮动缺数），判断不了是不是刚启动");
    return { state: "观察", evidence: ev };
  }

  // 新启动：今天突然放量 + 挤进前三，且**昨天确实有数据且很小**
  if (today >= 5 && prev !== null && prev <= 2 && (prevRank === null || prevRank > 3)) {
    ev.push(`今日 ${today} 只涨停，昨日 ${prev} 只`);
    if (prevRank === null) ev.push(`昨日不在榜单内，今日第 ${todayRank ?? "?"} 名`);
    else ev.push(`名次从第 ${prevRank} 名跳到第 ${todayRank ?? "?"} 名`);
    if (node && node.first_boards >= 3) ev.push(`其中首板 ${node.first_boards} 只（新资金扩散）`);
    const c = continuationNote(true);
    if (c) ev.push(c);
    return { state: "新启动", evidence: ev };
  }
  /**
   * 加速：本来就在榜，今天还更多。
   *
   * 🔴 但「只数变多」和「昨天的票接上了」是两件事，必须分开说：
   *    三季报增长 11→15 只、看着在放大，可昨日那 11 只只剩 3 只还涨停（27.3%），
   *    同时还有 2 只跌停 —— 那是**新票接力老票**，不是老票继续走。
   *    只报「连续放大」会让人以为是同一个方向在加强。
   */
  if (today >= 3 && prev !== null && today > prev && (todayRank ?? 99) <= 3) {
    ev.push(`今日 ${today} 只涨停，昨日 ${prev} 只，连续放大`);
    if (todayRank) ev.push(`今日第 ${todayRank} 名`);
    if (node && node.highest > 1) ev.push(`最高 ${node.highest} 板`);
    const c = continuationNote(true);
    if (c) {
      ev.push(c);
      if (node?.continuation_rate != null && node.continuation_rate < 0.4) {
        ev.push("只数在涨但昨日那批票没接上 → 是新票接力，不是老方向在加强");
      }
    }
    if (node && node.limit_down > 0) ev.push(`同题材内还有 ${node.limit_down} 只跌停（内部分化）`);
    return { state: "加速", evidence: ev };
  }
  // 高位拥挤：连续多日在榜、但今天没再放大
  if (t.top3_days >= 4 && today >= 3 && prev !== null && today <= prev) {
    ev.push(`已连续 ${t.active_days} 天有涨停，近 5 日 ${t.top3_days} 天进前三`);
    ev.push(`但今日 ${today} 只 ≤ 昨日 ${prev} 只，没有继续放大`);
    const c = continuationNote(true);
    if (c) ev.push(c);
    return { state: "高位拥挤", evidence: ev };
  }
  if (today > 0) {
    ev.push(`今日 ${today} 只涨停`);
    if (prev !== null) ev.push(`昨日 ${prev} 只`);
    if (t.top3_days >= 2) ev.push(`近 5 日 ${t.top3_days} 天进前三`);
    const c = continuationNote(true);
    if (c) ev.push(c);
    return { state: "延续", evidence: ev };
  }
  ev.push("今日无涨停");
  return { state: "观察", evidence: ev };
}

// ─── ② 板块内龙头 ───────────────────────────────────────────────────────────────

/**
 * 封单厚度的分界（封单 ÷ 流通市值，%）。
 *
 * 🔴 这不是拍脑袋的阈值，是 2026-10 回溯 14 个交易日（631 只 10cm 涨停股）实测出来的：
 *    - > 1.5%：次日再涨停 **42%**、中位 **+3.4%**
 *    - ≤ 1.5%：次日再涨停 **15%**、中位 **−2.1%**
 *    - > 3%：再涨停 **57%**、中位 **+9.97%**
 *    而且**按日配对，14/14 天方向完全一致**（含大跌日）—— 这是整套里唯一一个跨环境不翻面的因子。
 *    比封板时点更稳（那个 13/14 天，10/16 就翻过面）。
 *
 * 🔴 它**不进排序**（见 rankLeaders 注释），只做「这只封得硬不硬」的读数。
 *    因为封单是盘口快照、盘中会变，而排序键要跨时点可比。
 */
export const SEAL_GRADE_CUT = { hard: 3, mid: 1.5 };

export type SealGrade = "硬" | "中" | "软";

/** 封单厚度分档；null = 没拿到封单数据（不是「软」） */
export function sealGradeOf(ratio: number | null): SealGrade | null {
  if (ratio == null) return null;
  if (ratio >= SEAL_GRADE_CUT.hard) return "硬";
  if (ratio >= SEAL_GRADE_CUT.mid) return "中";
  return "软";
}

/**
 * 位置三层各管一段（都来自同一批回溯数据，别把其中任何一层当成「总分」）：
 *   - **门槛**：末封是否在 10:00 前 —— 实测次日再涨停 38%，而 10:00 之后各档只有 12~20%，
 *     且 10:00–11:30 反而最差（16%）。**不是「越早越好」的线性关系，是 10:00 一刀切。**
 *   - **强度**：封单占流通市值（`SEAL_GRADE_CUT`）—— 最强的一维，14/14 天方向一致。
 *   - **周期**：连板高度 —— 2 板是唯一负期望档（中位 −1.71%、跌停率 15%），3 板以上才转正。
 */

/**
 * 排龙头：**连板高度 → 开板次数 → 首封时间**，三级降序，没有加权。
 *
 * - 高度是「谁走得最远」，这是板块高度的定义；
 * - 同样高度时，开板次数少的更硬（一字 / 早封）；
 * - 还平就比首封时间，越早越卡位。
 *
 * 🔴 排序**不把封单额放进去**：封单是收盘时点的快照，盘中会反复变，
 *    拿它做跨时点的排序键，早盘和尾盘会排出一份不一样的名单。
 *    但封单占比会写进 `why` 和 `seal_ratio` 字段 —— 它说明「封得死不死」，是读数不是名次。
 *
 * 🔴 板块内只有 1~2 只涨停时不给「龙头」二字 —— 那是个股行为，不是板块效应。
 *    这种情况返回 role = "独苗"，并在 why 里写明原因。
 */
export function rankLeaders(node: ThemeNode, sealByCode?: Map<string, SealInfo>): LeaderPick[] {
  if (!node.members.length) return [];
  const sorted = [...node.members].sort((a, b) =>
    b.boards - a.boards
    || (a.broken_times ?? 99) - (b.broken_times ?? 99)
    || String(a.first_seal ?? "999999").localeCompare(String(b.first_seal ?? "999999")));

  const top = sorted[0]!;
  const sectorEffect = node.limit_up >= 3 && node.highest >= 2;

  return sorted.slice(0, 4).map((m, i) => {
    const seal = sealByCode?.get(m.code) ?? null;
    const seal_ratio = seal?.seal_fund != null && seal.float_cap != null && seal.float_cap > 0
      ? Math.round((seal.seal_fund / seal.float_cap) * 1000) / 10
      : null;
    const why: string[] = [];
    why.push(`${m.boards} 板${m.zt_stat ? `（${m.zt_stat}）` : ""}`);
    if (m.first_seal) why.push(`首封 ${fmtTime(m.first_seal)}`);
    if (m.broken_times != null) why.push(m.broken_times === 0 ? "未开板" : `开板 ${m.broken_times} 次`);
    // 封单占比：同一板块里两只都封板时，这个数才是「哪只更硬」的答案
    if (seal_ratio != null && seal?.seal_fund != null) {
      const grade = sealGradeOf(seal_ratio)!;
      why.push(
        `封单 ${(seal.seal_fund / 1e8).toFixed(2)} 亿＝流通 ${seal_ratio}%（${grade}${grade === "硬" ? "，历史同日次日再涨停过半" : grade === "软" ? "，不到 1.5% 交界" : ""}）`,
      );
    }
    if (seal?.turnover != null) why.push(`换手 ${seal.turnover.toFixed(1)}%`);
    if (seal?.last_seal && seal.last_seal !== m.first_seal) why.push(`末封 ${fmtTime(seal.last_seal)}`);

    let role: LeaderPick["role"];
    if (i === 0) {
      role = sectorEffect ? "龙头" : "独苗";
      /**
       * 🔴 「没效应」有两种完全不同的原因，不能说成同一句：
       *    - 只数不够（2 只）→ 是个股行为；
       *    - 只数够但**全是首板**（5 只、最高 1 板）→ 有扩散没高度，是一日游，也扛不起板块。
       *    早先两种都写成「板块仅 N 只涨停」，5 只涨停时说这句话是自相矛盾的。
       */
      if (!sectorEffect) {
        why.push(
          node.limit_up < 3
            ? `板块仅 ${node.limit_up} 只涨停，不足以称龙头`
            : `${node.limit_up} 只涨停但最高只有 ${node.highest} 板（没有高度，只是一日游扩散），扛不起板块`,
        );
      }
    } else if (m.boards === top.boards) {
      role = "跟风";
      why.push("与第一名同高度");
    } else if (m.boards <= 1) {
      role = "补涨";
    } else {
      role = "跟风";
    }
    return {
      code: m.code, name: m.name, boards: m.boards,
      first_seal: m.first_seal, broken_times: m.broken_times, zt_stat: m.zt_stat,
      role, why, quote: null,
      seal_fund_yi: seal?.seal_fund == null ? null : Math.round((seal.seal_fund / 1e8) * 100) / 100,
      seal_ratio,
      seal_grade: sealGradeOf(seal_ratio),
      last_seal: seal?.last_seal ?? null,
      reason_tags: seal?.tags ?? [],
    };
  });
}

/** "093000" → "09:30" */
function fmtTime(s: string | null): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  if (d.length < 4) return null;
  return `${d.slice(0, 2)}:${d.slice(2, 4)}`;
}

// ─── ③ 交易规划 ─────────────────────────────────────────────────────────────────

/**
 * 条件式规划 —— 只写「看什么、什么算数、什么算废」，**不写买还是卖**。
 *
 * 价位全部从真实字段算，不猜：
 *   - 涨停价、昨收来自 `tx_quotes_batch`（`limit_up_price` / `last_close`），
 *   - 触发位用「距涨停价的空间」，失效位用「收盘价 -5%」这种机械边界。
 *
 * 🔴 仓位这一格由**市场状态**的仓位上限派生，不由这里派生。
 *    上限 0% 时一律「只观察」——题材再好也不许绕过闸门（这正是 10/30 的情形：
 *    有题材在启动，但广度 15%、三闸门全挂，那天只能看）。
 */
export function planDraftOf(
  sector: SectorIgnition,
  leader: LeaderPick,
  market: OpportunityResult["market"],
  /** 盘面事实：只用来取「龙头这个板数的一档，昨日同档票今天去哪了」。不传就跳过这一条 */
  facts?: MarketFacts | null,
  /** 封板时间分档：只用来取「龙头这个末封时间的一档，昨日同档票今天怎样」。不传就跳过这一条 */
  sealTiming?: SealTiming | null,
): PlanDraft {
  const cap = market?.position_cap_pct ?? null;
  let allowance: PlanDraft["allowance"];
  let allowanceNote: string;
  /**
   * 🔴 这里**不自己拍档位**，只做翻译：能不能开新仓由 `market_state` 的 `can_open_position` 决定
   *    （它的口径是「上限 ≥40% 且风险不是 extreme」），这里再拍一个 40 就等于两套纪律。
   */
  if (market == null) {
    allowance = "只观察";
    allowanceNote = "市场状态没算出来（涨跌分布缺失），无法给仓位档位 → 一律只观察";
  } else if (cap == null) {
    allowance = "只观察";
    allowanceNote = "仓位上限未知 → 只观察";
  } else if (cap <= 0) {
    allowance = "不参与";
    allowanceNote = `市场状态「${market.phase ?? "—"}」·仓位上限 ${cap}%：闸门未过，这一轮只做记录`;
  } else if (market.can_open_position === true) {
    allowance = "可参与";
    allowanceNote = `市场状态「${market.phase ?? "—"}」·仓位上限 ${cap}%：可以按框架执行，单笔仍受上限约束`;
  } else {
    allowance = "只观察";
    allowanceNote = `市场状态「${market.phase ?? "—"}」·仓位上限 ${cap}%：这一档只够留住已有仓位，不够开新仓 → 先记录价位`;
  }

  const q = leader.quote;
  const close = q?.price ?? null;
  const lu = q?.limit_up_price ?? null;
  /**
   * 已封板 / 未封板是两套完全不同的看盘动作：
   *   - 已封板：今天的价格已经顶到涨停价，「距涨停还有 0.0%」「向上突破即封板」都是废话，
   *     真正要看的是**明日能不能再封一次**；
   *   - 未封板：才有「距涨停还有几个点」和「突破即封板」这回事。
   */
  const sealed = close != null && lu != null && lu > 0 && close >= lu - 0.005;
  const watch: string[] = [];
  const trigger: string[] = [];
  const invalidate: string[] = [];

  if (sealed) {
    watch.push(`今日已封板 ${close.toFixed(2)}，明日竞价看是否高开（低开 >2% 视为承接转弱）`);
  } else if (lu != null && close != null && lu > 0) {
    const room = ((lu - close) / close) * 100;
    watch.push(`距涨停价 ${lu.toFixed(2)} 还有 ${room.toFixed(1)}%`);
  }
  watch.push(`竞价量比（今日 ${q?.volume_ratio ?? "—"}，明日同口径对比）`);
  if (leader.first_seal) watch.push(`首封时间 ${fmtTime(leader.first_seal)}，明日是否更早`);
  if (leader.broken_times != null && leader.broken_times > 0) {
    watch.push(`今日开板 ${leader.broken_times} 次${leader.last_seal ? `（末封 ${fmtTime(leader.last_seal)}）` : ""}，明日封板是否一次到位`);
  }
  /**
   * 封单占比是「封得死不死」的直接量化，比开板次数更细：
   * 三季报增长的龙头 5 板换手 24.9%、封单只占流通 1.5%；上海沪工 3 板换手 3.2%、封单占 4.4%。
   * 两个都叫「封板」，硬度差三倍。
   */
  if (leader.seal_ratio != null) {
    /**
     * 🔴 封单厚度是这套里唯一跨环境不翻面的因子（14/14 天方向一致），
     *    所以要给出**分界**，不能只说「封单是多少」。
     *    同日回溯：>1.5% 次日再涨停 42%、≤1.5% 只有 15%、>3% 到 57%。
     */
    const grade = sealGradeOf(leader.seal_ratio);
    watch.push(
      `封单 ${leader.seal_fund_yi} 亿＝流通市值的 ${leader.seal_ratio}%（${grade}档），明日封单是否维持这个量级`,
    );
    if (grade === "软") {
      watch.push(
        `封单不到 1.5% 的交界 —— 同一天、同样涨停的票里，这一档次日再涨停只有 15%（厚封单那档 42%），需要明天看到封单增厚才谈得上接力`,
      );
    } else if (grade === "硬") {
      watch.push(`封单 ≥3% 属于厚档：同日回溯次日再涨停过半（57%），这是这只票最硬的一条读数`);
    }
  } else if (leader.seal_fund_yi == null) {
    watch.push("封单额没取到（连板天梯缺失），只能靠开板次数和换手侧看");
  }
  /**
   * 🔴 这里**刻意不给「2 板是坑」这类按高度的心得**。
   *
   *    整体中位数看，2 板确实是唯一负期望档（125 只、中位 −2.03%、跌停率 15%），
   *    但按日配对一查就散了：17 个交易日里只有 7 天（41%）「2 板比其余差」成立，接近抛硬币。
   *    原因是每天 2 板只有 3~14 只，单日中位数被一两只极端票决定 —— 10/15 中位 −9.59%、10/30 −8.54%，
   *    整体那个负中位就是被这几天拉出来的。
   *    ⇒ 高度这一维的**每日样本太薄**，撑不起写进规划的结论。只有封单厚度（每天 10~25 只）
   *      和末封时点（每天 10~20 只）在按日配对下站得住。
   */

  /**
   * 同档晋级率 + 断板票去向 —— **只做背景，不做触发条件**。
   *
   * 🔴 这里统计的是 `highest-1 → highest` 这一跳（今天 5 板的票，是昨天 4 板晋上来的），
   *    而龙头明天走的是 `highest → highest+1`。档位不同、难度不同，
   *    拿前者的胜率去承诺后者，就是拿别人的晋级率给这只票背书。
   *    所以它只放在「看什么」里，让读者知道当前这个高度今天有多难上。
   */
  const promo = sector.promotion;
  if (promo && promo.base > 0) {
    const rate = promo.rate == null ? "—" : `${Math.round(promo.rate * 1000) / 10}%`;
    const fell = promo.fell
      .slice(0, 3)
      .map((f) => `${f.name}${f.prev_label ? `(${f.prev_label})` : ""}→${f.outcome}${f.ret == null ? "" : ` ${f.ret > 0 ? "+" : ""}${f.ret.toFixed(1)}%`}`)
      .join("、");
    watch.push(
      `${promo.boards - 1} 板 → ${promo.boards} 板今日晋级 ${promo.promoted}/${promo.base}（${rate}）`
      + `${fell ? `，没接上的：${fell}` : ""}`
      + `；这是上一个档位的接力情况，龙头明天走的是 ${promo.boards} → ${promo.boards + 1}，档位不同不能直接套用`,
    );
  }

  /**
   * 🔴 同档反馈：这是全套里**唯一与龙头档位正对应**的证据。
   *
   *    `tier = "3板"` 统计「昨日 3 板的票今天表现如何」，所以我今天 3 板的龙头，
   *    明天走的就是这个分布。这和连板天梯的 `boards=3`（昨日 2 板→今日 3 板）不是一回事 ——
   *    那个是上一个档位，只能当「到达这个高度有多难」的背景。
   *
   *    10/30 实测：昨日 3 板 2 只**全部跌停**、昨日 2 板 6 只**3 只跌停**（50%）。
   *    没有这条，规划里就只剩「晋级率若干」，读者感受不到「打错了会怎样」。
   */
  const tierKey = leader.boards <= 1 ? "首板" : `${leader.boards}板`;
  const tier = facts?.tiers.find((t) => t.tier === tierKey) ?? null;
  if (tier && tier.total > 0) {
    const dist = tier.buckets.map((b) => `${b.label} ${b.count}`).join(" / ");
    const small = tier.total < 3;
    // 括号里只补晋级率：跌停只数已经在 ${dist} 里列过一遍，别写两遍
    watch.push(
      `昨日「${tierKey}」的 ${tier.total} 只今天：${dist}`
      + `（晋级 ${tier.promoted}/${tier.total}${tier.promotion_rate != null ? `＝${Math.round(tier.promotion_rate * 1000) / 10}%` : ""}）`
      + ` —— 龙头今天也是 ${leader.boards} 板，明日走的就是这一档的分布`
      + `${small ? `；⚠️ 样本只有 ${tier.total} 只，参考意义很弱` : ""}`,
    );
  } else if (facts) {
    // 一个已知档位都没有（matrix 没解析出来）→ 我们其实不知道昨日分布，别说「昨日最高只到 —」
    const known = facts.tiers.filter((t) => t.total > 0);
    if (known.length > 0) {
      watch.push(
        `昨日没有「${tierKey}」这一档的样本（昨日最高只到 ${known[known.length - 1].tier}）`
        + ` → 这只票明日没有同档分布可参考，等于在走没走过的高度`,
      );
    }
  }

  /**
   * 封板时间分档：龙头今天几点封的，同一时段的票历史表现如何。
   *
   *    ⚠️ 只描述「这个时段封板的票后来怎样」，不下「早封板更好」这种因果结论。
   *    🔴 **优先用多日累计**：单日一档只有十几只（14:00 后那天只有 6 只），
   *       说「0% 再涨停」其实是 6 只里的 0 只，没有统计意义。
   *       回溯 20 个交易日后每档几百只，才配放在规划里当参考。
   *    放在观察项里，和同档反馈是两条正交的线：一条按高度、一条按时点。
   */
  const sealMin = minutesOf(leader.last_seal);
  if (sealTiming && sealMin != null) {
    // 多日累计够厚就用它（每档至少 100 只），否则退回当日单日横截面
    const trend = sealTiming.trend && sealTiming.trend.buckets.some((b) => b.n >= 100) ? sealTiming.trend : null;
    const src = trend ? trend.buckets : sealTiming.buckets;
    const bucket = src.find((b) => {
      const def = SEAL_BUCKETS.find((d) => d.label === b.label);
      return def != null && sealMin >= def.lo && sealMin < def.hi;
    }) ?? null;
    const when = fmtTime(leader.last_seal);
    const scope = trend
      ? `近 ${trend.days} 个交易日（${trend.from_date}~${trend.to_date}）这一档累计 ${bucket?.n ?? 0} 只`
      : null;
    if (bucket) {
      watch.push(
        trend
          ? `今日末封 ${when}，落在「${bucket.label}」：${scope}，次日再涨停 ${bucket.still_up} 只`
            + `（${Math.round(bucket.still_up_rate * 100)}%）、平均 ${bucket.avg_ret > 0 ? "+" : ""}${bucket.avg_ret.toFixed(1)}%`
            + `、跌超5% ${bucket.deep_loss} 只（${Math.round(bucket.deep_loss_rate * 100)}%）`
            + ` —— 多日累计，比单日可信；仍是描述性统计，不是预测`
          : `今日末封 ${when}，落在「${bucket.label}」这一档：昨日同档 ${bucket.n} 只今天再涨停 ${bucket.still_up} 只`
            + `（${Math.round(bucket.still_up_rate * 100)}%）、平均 ${bucket.avg_ret > 0 ? "+" : ""}${bucket.avg_ret.toFixed(1)}%`
            + `、跌超5% ${bucket.deep_loss} 只`
            + `${bucket.n < 10 ? `；⚠️ 这一档只有 ${bucket.n} 只` : ""}`
            + ` —— 单日横截面（多日回溯没拿到），不是规律`,
      );
    } else {
      // 有分档表但没有这一档（例如全样本都落在别的时段）→ 明说没得比
      watch.push(
        `今日末封 ${when}，但没有落在同一时段的样本`
        + `（${trend ? `近 ${trend.days} 日` : "昨日"}分档：${src.map((b) => `${b.label} ${b.n} 只`).join(" / ")}）`
        + ` → 这个时点的封板质量没有同时段参照`,
      );
    }
  }

  /**
   * 板块延续率：昨日那批涨停票今天还剩几只。
   * 这是规划里唯一一条「板块内部有没有接力」的读数 —— 只数多不等于接力得上
   * （三季报增长 15 只涨停，昨日 11 只只剩 3 只）。
   * 只放观察项：什么比例算健康是因周期而变的，这里不拍阈值。
   */
  const cont = sector.continuation;
  if (cont.rate != null && cont.prev_limit_up >= 3) {
    const pct = Math.round(cont.rate * 1000) / 10;
    watch.push(
      `板块延续率 ${pct}%（昨日 ${cont.prev_limit_up} 只里 ${cont.still_up} 只仍涨停`
      + `${cont.broken_or_down > 0 ? `、${cont.broken_or_down} 只炸板或下跌` : ""}），明日看这个比例往上还是往下`,
    );
  }

  // 板块层面的延续条件（对已封板 / 未封板都适用）
  trigger.push(
    sector.consec_boards >= 2
      ? `板块内同高度个股明日仍有 2 只以上封板（现在 ${sector.consec_boards} 只连板）`
      : `板块涨停数不低于今日 ${sector.today} 只`,
  );
  if (sealed && lu != null) {
    trigger.push(`明日再封一次 ${lu.toFixed(2)}（连板才算延续）`);
  } else if (close != null) {
    trigger.push(`站稳今日收盘 ${close.toFixed(2)} 之上`);
    if (lu != null && lu > close) trigger.push(`向上突破 ${lu.toFixed(2)}（即封板）`);
  }

  if (sealed && lu != null) {
    /**
     * 封板票只有两种结局：再封一次（延续）或没封住（失效）。
     * 所以失效位就用涨停价本身，不去凑「-5%」——今天涨停、明天 -5% 等于跌 15%，
     * 那个位置对连板票没意义，等它触发时早就废了。
     */
    invalidate.push(`收盘低于 ${lu.toFixed(2)}（今日涨停价，不封板即失效）`);
  } else if (close != null) {
    invalidate.push(`跌破 ${(close * 0.95).toFixed(2)}（今日收盘 -5%）`);
  } else {
    invalidate.push("跌破今日收盘 -5%");
  }
  invalidate.push(`板块涨停数掉到 ${Math.max(1, Math.floor(sector.today / 2))} 只以下（今日 ${sector.today} 只）`);
  if (sector.highest >= 2) invalidate.push(`最高板 ${sector.highest} 板的票断板且不修复`);

  const sizing = cap == null || cap <= 0
    ? "不配置：仓位上限为 0 或未知"
    : `单笔不超过总仓的 ${Math.max(1, Math.round(cap / 2))}%（市场状态上限 ${cap}% 的一半）`;

  return {
    sector: sector.tag, symbol: leader.code, name: leader.name, role: leader.role,
    allowance, allowance_note: allowanceNote,
    watch, trigger, invalidate, sizing,
  };
}

// ─── 行情补齐 ───────────────────────────────────────────────────────────────────

async function fetchQuotes(
  ctx: ServiceContext,
  signal: AbortSignal,
  codes: string[],
  force = false,
): Promise<Map<string, QuoteLite>> {
  const out = new Map<string, QuoteLite>();
  if (!codes.length) return out;
  const chunks: string[][] = [];
  for (let i = 0; i < codes.length; i += QUOTE_CHUNK) chunks.push(codes.slice(i, i + QUOTE_CHUNK));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const r = await fetchEndpoint(ctx, {
        endpoint: "tx_quotes_batch",
        args: { codes: chunk.map(quoteCodeOf) },
        signal,
        timeout_ms: 25_000,
        // 🔴 行情是这一屏里变得最快的东西：它的键只由「这批代码」决定，不含时间，
        //    不给上限就会冻在第一次取数那一刻 —— 页面上的价、换手、「距涨停」全是那天的。
        consistency: consistencyFor("tx_quotes_batch", force),
      });
      const byCode = new Map<string, Record<string, unknown>>();
      for (const e of evidenceOf(r)) {
        const key = String(e.record_key ?? "").replace(/^(sh|sz|bj)/, "");
        if (!key) continue;
        const m = byCode.get(key) ?? {};
        m[String(e.field ?? "")] = e.value;
        byCode.set(key, m);
      }
      for (const [code, m] of byCode) {
        const price = num(m.price);
        const lu = num(m.limit_up_price);
        const ta = num(m.turnover_amount);
        out.set(code, {
          price,
          change_pct: num(m.change_pct),
          turnover_rate: num(m.turnover_rate),
          // 腾讯口径:成交额单位是「万元」→ 折成亿元
          turnover_amount_yi: ta == null ? null : Math.round((ta / 1e4) * 100) / 100,
          float_cap_yi: num(m.float_market_cap),
          volume_ratio: num(m.volume_ratio),
          limit_up_price: lu,
          last_close: num(m.last_close),
          to_limit_pct: price != null && lu != null && price > 0 ? Math.round(((lu - price) / price) * 1000) / 10 : null,
        });
      }
    } catch {
      // 补不到行情不影响主线判断：leader 照样能按涨停结构排，只是少几个数字
    }
  }));
  return out;
}

// ─── 行业资金流（旁证） ─────────────────────────────────────────────────────────

function boardFlowTop(r: FetchResult | null): OpportunityResult["board_flow"] {
  if (!r) return { available: false, top: [], note: "板块资金流没取到" };
  const env = envelopeOf(r);
  const status = String(env?.status ?? "");
  if (status === "failed") {
    const errs = (env?.errors as { error?: string }[] | undefined) ?? [];
    return { available: false, top: [], note: `板块资金流取数失败：${errs[0]?.error ?? "上游不可用"}` };
  }
  const rows = new Map<string, { name: string; net_yi: number | null; change_pct: number | null; note: string | null }>();
  for (const e of evidenceOf(r)) {
    const key = String(e.record_key ?? "");
    if (!key) continue;
    const note = typeof e.note === "string" ? e.note : null;
    const name = note ? (note.split(" ")[0] ?? key) : key;
    const cur = rows.get(key) ?? { name, net_yi: null, change_pct: null, note };
    const f = String(e.field ?? "");
    if (f === "board_net_sina") cur.net_yi = num(e.value) == null ? null : Math.round((num(e.value)! / 1e8) * 100) / 100;
    if (f === "board_change_pct_sina") cur.change_pct = num(e.value);
    rows.set(key, cur);
  }
  const top = [...rows.values()]
    .filter((x) => x.net_yi != null)
    .sort((a, b) => (b.net_yi ?? 0) - (a.net_yi ?? 0))
    .slice(0, 6);
  return {
    available: top.length > 0,
    top,
    note: "新浪口径（流入−流出，非东财主力净额），只有当日一档；行业名与题材名不是一套命名，仅作旁证",
  };
}

// ─── 入口 ───────────────────────────────────────────────────────────────────────

/** 回溯的交易日数。东财只保留约一个月，20 个交易日是稳妥上限 */
const SEAL_HISTORY_DAYS = 20;
/** 往前最多翻多少个工作日（20 个交易日 ≈ 28 自然日，留节假日余量） */
const SEAL_HISTORY_CANDIDATES = 30;
/** 回溯请求的并发上限（多数日期已缓存、8~15ms；未缓存的 3~15s，全并行会被上游限频） */
const SEAL_HISTORY_CONCURRENCY = 5;

/** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，凌晨会差一天） */
function ymdOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 封板时点的**多日累计**（近 20 个交易日，不含今天）。
 *
 * 🔴 为什么必须做这个：一日只有三四十只，一档十几只，说「昨日 14:00 后封板的再涨停 0%」
 *    其实是 **6 只里的 0 只**，没有统计意义。20 天累计后每档几百只才站得住。
 *
 * 🔴 **这不是「一天天攒」，是回溯。** `cn_shortline_settled` 带 `date` 参数，
 *    东财保留约一个月，已收盘日结果不变、长期缓存 —— 所以第一天就能算出 20 天。
 *    （早前把它写成「要攒 20 个交易日」是把「缓存越积越长」误读成了「只能从今天开始攒」。）
 *
 * 跳过周六周日；法定假日的日期会返回和前一交易日相同的 `res.date`，按 date 去重掉。
 */
async function sealHistory(
  ctx: ServiceContext,
  signal: AbortSignal,
  gaps: string[],
): Promise<SealTrend | null> {
  const now = new Date();
  const candidates: string[] = [];
  for (let i = 1; i <= 60 && candidates.length < SEAL_HISTORY_CANDIDATES; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    candidates.push(ymdOf(d));
  }

  const perDay = new Map<string, SealBucket[]>();
  let failed = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(SEAL_HISTORY_CONCURRENCY, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const date = candidates[cursor++];
      if (signal.aborted) return;
      try {
        const r = await fetchEndpoint(ctx, {
          endpoint: "cn_shortline_settled",
          args: { date },
          signal,
          timeout_ms: 45_000,
          // 🔴 这一处**故意不进 `SNAPSHOT_MAX_AGE_MS`、也不认 `force`**：键里带了具体日期，
          //    而过去某天的「昨日涨停明细」是**不可变**的 —— 加时效只会让一次刷新把 20 天
          //    全部重取一遍（每天约 2 秒 × 20）。不可变的键，永久缓存才是对的。
          //    已知代价：若某天清晨在数据尚未落定时取过一次并标 partial，那份会一直留在盘上。
        });
        const res = resultOf(r);
        if (!res || res.partial === true) { failed++; continue; }
        const rows = Array.isArray(res.rows) ? (res.rows as Record<string, unknown>[]) : [];
        const key = typeof res.date === "string" ? res.date : date;
        if (!rows.length) { failed++; continue; }
        const buckets = bucketsOf(rows);
        if (buckets.length) perDay.set(key, buckets);
        else failed++;
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(workers);

  if (!perDay.size) {
    gaps.push(`封板时点回溯失败（试了 ${candidates.length} 个日期）→ 只能用当日单日横截面，那个数字没有统计意义`);
    return null;
  }

  const dates = [...perDay.keys()].sort();
  const used = dates.slice(-SEAL_HISTORY_DAYS);
  const buckets = aggregateBuckets(used.map((d) => perDay.get(d)!));
  if (!buckets.length) return null;

  const sample = buckets.reduce((a, b) => a + b.n, 0);
  const skipped = candidates.length - perDay.size;
  if (skipped > 0) {
    // 只有失败多到影响覆盖时才提一句，避免正常节假日把缺口刷满
    if (used.length < Math.min(SEAL_HISTORY_DAYS, candidates.length) * 0.7) {
      gaps.push(`封板时点回溯只成功 ${used.length} 天（${skipped} 个日期没拿到）→ 累计样本偏少`);
    }
  }

  return {
    days: used.length,
    tried: candidates.length,
    from_date: used[0] ?? null,
    to_date: used[used.length - 1] ?? null,
    sample,
    buckets,
  };
}

const SOURCES = [
  "同花顺涨停揭秘 + 东财涨停池（cn_shortline_themes / cn_shortline_theme_rotation）",
  "东财连板天梯（cn_shortline_board_ladder：封单额 / 换手 / 末封时间 + 逐档晋级率与断板去向）",
  "东财盘中此刻情绪（cn_shortline_live：涨停 / 炸板 / 跌停 / 封板率 / 赚钱效应）",
  "东财情绪周期（cn_shortline_cycle：回看 10 天，给「今天在周期第几天」这层背景）",
  "东财盘面事实（cn_shortline_facts：封板质量 / 亏钱效应 / 各档昨日涨停股今天去向）",
  "东财昨日涨停逐只明细（cn_shortline_settled：只取最后封板时间，做「封板时点 → 次日表现」）",
  "新浪板块资金流（sina_board_flow，仅当日、仅旁证）",
  "腾讯批量行情（tx_quotes_batch，50 只/批，含涨停价与昨收）",
  "市场状态信号（market_state，决定仓位档位）",
];

// 快照时效与「刷新=True 就真取」统一在 `snapshot_ttl.ts` 里 —— 板块宽度（day_opportunity）
// 和这里共用同一张表，免得改了一处、漏了另一处（2026-11-06 的事故见那个文件的头注释）。

export async function opportunityScanAct(
  ctx: ServiceContext,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<OpportunityResult> {
  const { day, hms } = clockOf(new Date());
  const gaps: string[] = [];
  const notes: string[] = [];
  // 🔴 这个参数原来是 `_body`，从头到尾没人读 —— 页面的「刷新」按钮点了等于没点，
  //    永远读回同一份快照。缓存没有时效上限时，这就是「10-30 的题材一直挂到今天」的第二道门。
  const force = wantsFresh(body?.refresh);

  const one = async (endpoint: string, label: string, args: Record<string, unknown> = {}, timeoutMs = 60_000) => {
    try {
      const r = await fetchEndpoint(ctx, {
        endpoint,
        args,
        signal,
        timeout_ms: timeoutMs,
        consistency: consistencyFor(endpoint, force),
      });
      const env = envelopeOf(r);
      if (env?.status === "failed") {
        const errs = (env.errors as { error?: string }[] | undefined) ?? [];
        gaps.push(`${label}取数失败：${errs[0]?.error ?? "上游返回 failed"}`);
      } else if (env?.status === "partial") {
        notes.push(`${label}只是部分数据（上游标 partial）`);
      }
      return r;
    } catch (e) {
      gaps.push(`${label}取数失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const [themesR, rotationR, ladderR, liveR, cycleR, factsR, settledR, boardR, market, sealTrend] = await Promise.all([
    one("cn_shortline_themes", "题材结构", { top: 12 }),
    one("cn_shortline_theme_rotation", "题材轮动", { days: 5 }),
    // 连板天梯：封单额 / 换手 / 末封时间 + 逐档晋级率与断板去向（实测 8ms~2s，成本极低）
    one("cn_shortline_board_ladder", "连板天梯", {}, 45_000),
    // 盘中此刻：涨停 / 炸板 / 跌停 / 封板率 / 赚钱效应（实测 7s；收盘后 phase=「已收盘」）
    // 单独调用约 7 秒，但和另外 5 个端点并行时会明显变慢 —— 给足 45 秒，别让它成为唯一的缺口
    one("cn_shortline_live", "盘中此刻情绪", {}, 45_000),
    // 情绪周期位置：回看 10 天涨停/炸板池，10/30 实测 26.8 秒，是全套最慢的。只给「新启动」加时间背景
    one("cn_shortline_cycle", "情绪周期", {}, 55_000),
    // 盘面事实：封板质量 / 亏钱效应 / 各档昨日涨停股今天去向（实测 ~2 秒，性价比最高之一）
    one("cn_shortline_facts", "盘面事实", {}, 45_000),
    // 昨日涨停股逐只明细（实测 ~2 秒）：唯一增量是 `seal_time`（最后封板时间）。
    // 🔴 它的 `sector` 是申万三级、39 只散在 32 个行业 → 行业维度实测不可用，这里只取时点
    one("cn_shortline_settled", "昨日涨停明细", {}, 45_000),
    one("sina_board_flow", "板块资金流", {}, 30_000),
    marketStateAct(ctx, { refresh: force }, signal).catch((e) => {
      gaps.push(`市场状态取数失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
    // 封板时点多日回溯（近 20 个交易日）：单日一档只有十几只，没有统计意义。
    // 与上面并行，多数日期已缓存，不额外拖时间。
    sealHistory(ctx, signal, gaps),
  ]);

  const ladder = ladderOf(ladderR);

  const nodes = new Map(themeNodes(themesR).map((n) => [n.tag, n]));
  const topicByTag = new Map(rotationTopics(rotationR).map((t) => [t.tag, t]));
  const prevReliable = prevReliableOf(themesR);
  // 🔴 「题材结构」永远是**最近一个收盘档**：涨停原因（同花顺涨停揭秘 / 东财涨停池）只有收盘后才有，
  //    盘中根本不存在「当日题材」。所以这一屏天然是「今天此刻的涨停家数 + 昨天收盘的题材结构」两天的数，
  //    不写清楚就会像 2026-11-06 那样，把 10-30 的题材当成今天的摆一整天。
  const themesDate = String(resultOf(themesR)?.date ?? "") || null;
  if (themesDate && themesDate !== day) {
    notes.push(`题材结构与龙头封单/首末封取自 ${themesDate} 收盘档（涨停原因只有收盘后才有，盘中拿不到当日题材）—— 与今天此刻的涨停家数不是同一天的数`);
  }
  if (!topicByTag.size) {
    notes.push(
      prevReliable
        ? "题材轮动没取到 → 用题材结构端点的「昨日该题材涨停数」代替：昨日 0 只的才算新启动，其余一律「观察」"
        : "题材轮动没取到、且昨日覆盖不完整 → 判断不了「是不是刚启动」，全部按「观察」列出",
    );
  }

  /**
   * 候选板块 = 今日结构的 tag ∪ 轮动里今天有涨停的 tag。
   *
   * 🔴 不能只以轮动为准：那个端点冷启 20+ 秒、还常被上游标 partial，它一挂整屏就空了，
   *    可 `cn_shortline_themes` 明明拿到了今天所有题材的涨停结构 —— 「轮动缺数」不等于「没有机会」。
   */
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes.values()) {
    if (n.limit_up > 0 && !seen.has(n.tag)) { seen.add(n.tag); tags.push(n.tag); }
  }
  for (const t of topicByTag.values()) {
    if (t.today > 0 && !seen.has(t.tag)) { seen.add(t.tag); tags.push(t.tag); }
  }

  const sectors: SectorIgnition[] = tags.map((tag) => {
    const node = nodes.get(tag) ?? null;
    // 没有轮动数据时用空序列：ignitionOf 会明说「判断不了是不是刚启动」，不会拿缺数当 0
    const topic: RotationTopic = topicByTag.get(tag) ?? {
      tag, series: [], ranks: [], today: node?.limit_up ?? 0, active_days: 0, top3_days: 0, status: null,
    };
    const ign = ignitionOf(topic, node, prevReliable);
    const today = node ? node.limit_up : topic.today;
    const highest = node?.highest ?? 0;
    return {
      tag,
      state: ign.state,
      today,
      series: topic.series,
      ranks: topic.ranks,
      first_boards: node?.first_boards ?? 0,
      consec_boards: node?.consec_boards ?? 0,
      highest,
      broken: node?.broken ?? 0,
      limit_down: node?.limit_down ?? 0,
      continuation: node
        ? {
          prev_limit_up: node.prev_limit_up,
          still_up: node.prev_still_up,
          broken_or_down: node.prev_broken_or_down,
          rate: node.continuation_rate,
        }
        : { prev_limit_up: 0, still_up: 0, broken_or_down: 0, rate: null },
      upstream_state: node?.upstream_state ?? null,
      members_shown: node?.members.length ?? 0,
      diffusion: today > 0 && node ? Math.round((node.first_boards / today) * 100) / 100 : null,
      active_days: topic.active_days,
      top3_days: topic.top3_days,
      evidence: ign.evidence,
      leaders: node ? rankLeaders(node, ladder.sealByCode) : [],
      has_sector_effect: today >= 3 && highest >= 2,
      // 天梯按高度分档，不按题材分档：这里取的是「这个高度今天晋级得怎么样」，不是板块自己的晋级率
      promotion: highest > 0 ? ladder.byBoards.get(highest) ?? null : null,
    };
  }).sort((a, b) => b.today - a.today || b.highest - a.highest);

  // 排序用今日涨停只数（客观量），拿前 8 个板块展示
  const shown = sectors.slice(0, 8);
  if (sectors.length > shown.length) {
    notes.push(`今日有涨停的题材共 ${sectors.length} 个，这里只列涨停只数前 ${shown.length} 个（按只数降序，不做加权）`);
  }

  // 只对「有板块效应」的板块的龙头补行情，最多 30 只，避免无意义的批量请求
  const needCodes = shown
    .filter((s) => s.has_sector_effect)
    .flatMap((s) => s.leaders.filter((l) => l.role === "龙头" || l.role === "跟风").map((l) => l.code));
  const quotes = await fetchQuotes(ctx, signal, [...new Set(needCodes)].slice(0, 30), force);
  if (needCodes.length && quotes.size === 0) gaps.push("龙头个股行情没补上：价位与「距涨停」为空，其余判断不受影响");
  for (const s of shown) {
    for (const l of s.leaders) l.quote = quotes.get(l.code) ?? null;
  }

  const marketBrief: OpportunityResult["market"] = market
    ? {
      phase: market.phase,
      composite: market.composite,
      position_cap_pct: market.position_cap_pct,
      risk_level: market.risk_level,
      can_open_position: market.can_open_position,
      gate_blockers: market.gate_blockers,
    }
    : null;
  if (!marketBrief) gaps.push("市场状态没算出来：所有机会一律降为「只观察」——没有仓位档位就不能谈执行");

  // 盘面事实要在生成规划之前解析：规划的「同档反馈」一条要用它
  const facts = factsOf(factsR);
  if (!facts) gaps.push("盘面事实没取到 → 少了封板质量、亏钱效应和各档昨日涨停股今天的去向（这几项直接影响龙头明日胜率的参考）；板块与规划本身仍照出");

  // 封板时间分档同样要在规划之前：规划的「封板时点」一条要用它
  const sealTiming = sealTimingOf(settledR);
  if (!sealTiming) gaps.push("昨日涨停股明细没取到 → 少了「封板时点 → 次日表现」这一条（龙头封板早晚到底值多少）；其余照出");
  // 多日累计挂到当日结构上：规划的文案优先用它（样本量差一个量级）
  if (sealTiming) sealTiming.trend = sealTrend;

  /**
   * 每个板块只给「龙头」生成规划（独苗不给规划：它不是板块机会）。
   *
   * 🔴 同一只票可能是多个题材的龙头（实测：上海沪工同时是「三季报扭亏」的龙头和
   *    「商业航天」的成分），逐个题材各出一条就成了同一只票三张规划，读者会以为是三个机会。
   *    按 `shown` 的顺序（今日涨停只数降序）取第一个，后面的记一句说明。
   */
  const plans: PlanDraft[] = [];
  const planned = new Map<string, string>();
  for (const s of shown) {
    const lead = s.leaders.find((l) => l.role === "龙头");
    if (!lead) continue;
    const dup = planned.get(lead.code);
    if (dup) {
      notes.push(`${lead.name}（${lead.code}）同时是「${dup}」和「${s.tag}」的龙头，只按前面那个出规划，避免同一只票被算成两个机会`);
      continue;
    }
    planned.set(lead.code, s.tag);
    plans.push(planDraftOf(s, lead, marketBrief, facts, sealTiming));
  }

  if (!plans.length) {
    notes.push("这一轮没有「板块效应 + 龙头」的组合，因此没有生成规划 —— 独苗连板不算板块机会");
  }

  const live = liveOf(liveR);
  if (!live) gaps.push("盘中此刻读数没取到：看不到涨停 / 炸板 / 跌停的实时家数与封板率，板块判断仍可用");

  const cycle = cycleOf(cycleR);
  if (!cycle) gaps.push("情绪周期没取到（它要回看 10 天涨停池，最慢，55 秒也没回来）→ 少了「今天是周期第几天」这层背景，其余判断不受影响");

  return {
    date: day,
    clock: hms.slice(0, 5),
    settled: hms >= "15:00",
    market: marketBrief,
    sectors: shown,
    live,
    cycle,
    facts,
    seal_timing: sealTiming,
    board_flow: boardFlowTop(boardR),
    plans,
    gaps,
    notes,
    sources: [...SOURCES],
  };
}
