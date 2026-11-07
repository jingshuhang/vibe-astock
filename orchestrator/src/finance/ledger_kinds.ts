/**
 * 金融垂类的**台账记录种类**。Core 只提供存储与校验(`src/ledger.ts`),种类与字段全在这里。
 *
 * 核心四种构成一个闭环:
 *   计划(thesis) → 判据(criterion) → 现状(position) → 到期要做的事(action)
 * **顺序是有意的**:先写下目标与判据,后面所有"偏离"才有参照物。
 * 另两种在闭环之外:`watch`(自选,还没到写论点的程度)与 `note`(研究记录,只留痕不判定)。
 *
 * 🔴 红线:这些是**用户自己写下的东西**,产品不替他生成建仓建议。
 *    界面只做两件事:把他写的原样呈现出来,以及把"哪条到期了"算出来。
 */
import type { LedgerKindDef } from "../plugin.ts";
import { CITED_MAX, MAX_CONDITIONS, REVIEW_SECTIONS, REVIEW_SECTION_IDS, REVIEW_SECTION_STATUSES, SECTION_TEXT_MAX, WEEKLY_SECTIONS, WEEKLY_SECTION_IDS } from "./shortline/review_defs.ts";
import { DIRECTIONS, DIRECTION_LABELS, VERIFY_METRICS, VERIFY_METRIC_KEYS } from "./shortline/verify_metrics.ts";
import { DEFAULT_RULES, PLAYBOOKS, isFractionRule, type RuleKey } from "./journal/defs.ts";
import { MAX_RATE } from "./journal/fees.ts";
import { MODE_CHANGES_MAX, MODE_NAME_MAX, MODE_TEXT_FIELDS, MODE_TEXT_MAX, MODE_VERSIONS_MAX } from "./journal/modes.ts";

/**
 * 主体代码的台账规范形:
 * A 股 `600519` / 港股 `00700.HK` / 美股 `AAPL` 或 `BRK.B`。
 * 界面负责把 `hk00700` 等常见写法归一化，台账只收唯一写法。
 */
const US_SYMBOL_VALUE = "(?:[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?)";
const SYMBOL_VALUE = `(?:[0-9]{6}|[0-9]{5}\\.HK|${US_SYMBOL_VALUE})`;
const SYMBOL = { type: "string", pattern: `^(?:${SYMBOL_VALUE})?$` };
const REQUIRED_SYMBOL = { type: "string", pattern: `^${SYMBOL_VALUE}$` };
/**
 * 日期:留空,或一个**真实存在的日历日**。
 * 🔴 只写 `^\d{4}-\d{2}-\d{2}$` 是不够的 —— `2026-99-99` / `2026-02-31` 都能过,
 *    然后进"到期清单"参与排序与提醒:**永远不触发,保存却报成功**。
 * `format: "date"` 由 Core 的 `ledger.ts` 自己注册(不依赖 ajv-formats 插件,
 * 所以不存在"没装就静默不校验"那种情况)。
 */
const DATE = { type: "string", anyOf: [{ maxLength: 0 }, { format: "date" }] };
/** 盘口时点 HH:MM(留空或合法时刻)。和 `DATE` 同一口径:空值是允许的"没填",不是校验放水 */
const TIME = { type: "string", anyOf: [{ maxLength: 0 }, { pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }] };
const TEXT = (max = 500) => ({ type: "string", maxLength: max });
const NONEMPTY = (max = 500) => ({ type: "string", minLength: 1, maxLength: max, pattern: "\\S" });
const COUNT = { type: "integer", minimum: 0 };

/** AI 复盘 / 周报的一段:正文 + 数字核对(三档分开)+ 引到的证据行(「查看依据」) */
const reviewSection = (ids: readonly string[]) => ({
  type: "object", additionalProperties: false, required: ["id", "label", "status"],
  properties: {
    id: { type: "string", enum: ids },
    label: TEXT(20),
    status: { type: "string", enum: REVIEW_SECTION_STATUSES },
    text: TEXT(SECTION_TEXT_MAX),
    error: TEXT(500),
    /** 这一段的资料包里有多少条证据 */
    evidence_count: COUNT,
    audit: {
      type: "object", additionalProperties: false, required: ["total", "bound", "derived", "loose", "bad_math"],
      properties: {
        total: COUNT, bound: COUNT, derived: COUNT, loose: COUNT,
        bad_math: {
          type: "array", maxItems: 20,
          items: { type: "object", additionalProperties: false, required: ["raw", "stated", "recomputed"], properties: { raw: TEXT(200), stated: { type: "number" }, recomputed: { type: "number" }, percent: { type: "boolean" } } },
        },
      },
    },
    cited: {
      type: "array", maxItems: CITED_MAX,
      items: { type: "object", additionalProperties: false, required: ["id", "line"], properties: { id: { type: "string", pattern: "^ev-[0-9a-f]{6,}$" }, line: TEXT(600) } },
    },
    /** 引了、但资料包里没有的编号 */
    unknown_cites: { type: "array", maxItems: 40, items: TEXT(60) },
  },
});

/**
 * 字段键 / 枚举值的**中文显示名**。
 *
 * 🔴 这些以前写死在 Core 的表单组件里 —— "cost=成本""decision_point=裁决点"
 *    只在这个行业成立,换个垂类就得改 Core。而前端的纯净度棘轮词表里恰好
 *    没有"成本 / 账户 / 裁决点"这几个词,于是**一路绿灯**。
 *    ⇒ 教训与后端那条一样:词表挡不住它没收录的词,别拿"棘轮是绿的"当边界证明。
 *
 * ⚠️ 不必登记全部字段:界面对没登记的退回**原键名**照常渲染。
 */
export const FINANCE_FIELD_LABELS: Record<string, string> = {
  symbol: "代码", name: "名称", account: "账户", shares: "数量", cost: "成本",
  opened_at: "建立日期", note: "备注", title: "标题", statement: "内容",
  review_by: "复核日期", status: "状态", type: "类型", thesis_id: "关联论点",
  due: "到期日", ref: "关联", tag: "分组", category: "分类", body: "正文",
  judged_at: "判定日", verdict_note: "判定说明",
  date: "日期", price: "价格", fee: "费用", amount: "金额", ratio: "比例", migrated_from: "迁移自", written_at: "当初写下时间",
  metric: "读数", direction: "预期方向", reason: "理由",
  trade_id: "所属交易", playbook: "打法", as_planned: "按计划", planned_stop: "计划止损价", planned_target: "计划目标价",
  plan_id: "关联计划", thesis: "为什么做这笔", planned_entry: "计划入场价", position_pct: "计划占仓 %",
  watch: "观察条件", next_check: "下一次检查点", valid_until: "有效期至", round_ref: "关联那一轮",
  pnl_pct: "盈亏 %", planned_at: "标注时间",
  code: "代码", boards: "连板数", sector: "行业", seal_time: "封板时间", pattern_type: "模式",
  pattern_confidence: "原始置信度", regime: "情绪环境", seal_bucket: "封板分档", in_main_sector: "主线行业",
  market_phase: "市场相位", settled: "已对账", next_ret: "次日涨跌 %", next_limit_up: "次日再板", settled_date: "对账日",
  call: "交易倾向", trigger: "触发条件", trigger_metric: "触发读数", trigger_op: "比较", trigger_value: "触发阈值",
  breadth_pct: "广度 %", amount_yi: "两市成交额 亿", limit_up: "涨停家数", limit_down: "跌停家数",
  // market_call 的次日涨跌停家数带 _count 后缀:裸的 next_limit_up 已被 opportunity_track 占作「次日再板」(boolean) ——
  // 同一字段名两个语义会让页面/导出出现两个不同的数,这里从字段名起就分开
  next_breadth_pct: "次日广度 %", next_amount_yi: "次日成交额 亿", next_limit_up_count: "次日涨停家数", next_limit_down_count: "次日跌停家数",
  trigger_hit: "触发条件命中", basis: "依据", html_path: "全景报告",
  commission_rate: "佣金费率", commission_min: "单笔佣金最低", stamp_tax_rate: "印花税", transfer_fee_rate: "过户费",
  max_loss_per_trade_pct: "单笔最大亏损 %", max_loss_per_day_pct: "单日最大亏损 %", max_positions: "最多同时持仓",
  max_trades_per_day: "单日最多开仓", pause_after_losses: "连亏几笔后停手", max_unplanned_ratio: "计划外占比上限", equity_base: "账户规模",
  versions: "版本", version: "版本号", since: "生效日", changes: "改了什么", saved_at: "保存时间",
  setup: "什么情况下做", entry: "怎么进", exit: "怎么出", sizing: "仓位", phase: "适用的情绪阶段",
};

export const FINANCE_ENUM_LABELS: Record<string, string> = {
  active: "进行中", paused: "暂停", closed: "已结束",
  decision_point: "裁决点", falsifier: "证伪条件",
  pending: "待判", met: "已达成", broken: "已触发", dropped: "已放弃",
  open: "待办", done: "已完成",
  planned: "待执行", executed: "已成交", abandoned: "已放弃",
  review: "复盘", highlight: "今日要点", ask: "问 Agent", debate: "多空辩论", audit: "反思审计",
  backtest: "回测", compare: "研究对比",
  opening: "期初持仓", buy: "买入", sell: "卖出", dividend: "现金分红", split: "送转 / 拆股",
  加仓: "加仓", 持有: "持有", 减仓: "减仓", 观望: "观望",
  偏多: "偏多", 中性偏多: "中性偏多", 中性: "中性", 中性偏空: "中性偏空", 偏空: "偏空",
  above: "≥", below: "≤",
  ...DIRECTION_LABELS,
  ...Object.fromEntries(VERIFY_METRICS.map((m) => [m.key, m.label])),
};

/**
 * 🔴 `hiddenFromAssistant: true` 的六种(清仓、交易流水、持有、交易标注、交易日志设置、模式卡)是用户自己的成交与持仓,
 *    **不交给模型**:聊天助手读台账时看不到它们,页面也不把它们放进发给 AI 的页面上下文(沿用旧版 VA「个人交易记录不接入任何 AI」)。
 *    自选、笔记、论点、判据、复盘这些可以给模型看。新增种类时想清楚放哪边。
 */
export const FINANCE_LEDGER_KINDS: Record<string, LedgerKindDef> = {
  /** 用户手动记录已发生的清仓，不下单、不自动扣减另一张持有台账。 */
  closed_position: {
    label: "清仓记录",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      closed_at: { type: "string", format: "date" },
      note: TEXT(1000),
      price: { type: "number", exclusiveMinimum: 0 },
      shares: { type: "number", exclusiveMinimum: 0 },
      cost: { type: "number" },
    },
    required: ["symbol", "closed_at", "price", "shares", "cost"],
  },
  /**
   * 交易流水:持仓页的唯一真相。持有多少、成本、已实现盈亏、分红都由 `holdings.ts` 按日期重放算出,不另存。
   * 各类型要哪些字段(买卖要数量和成交价、分红要金额、送转要比例)由重放逐条检查,不对的写原因、不参与计算 ——
   * 这里只做类型与范围校验(台账校验不支持「按类型要求字段」)。
   * `migrated_from`:从旧 `position` 记录迁移来的期初持仓,记原记录 id,迁移据此去重。
   */
  trade: {
    label: "交易流水",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      account: TEXT(40),
      type: { type: "string", enum: ["opening", "buy", "sell", "dividend", "split"] },
      date: { type: "string", format: "date" },
      shares: { type: "number", exclusiveMinimum: 0 },
      /** 期初持仓的每股成本可以是负数(分红 / 送转摊薄后),买卖成交价由重放要求大于 0 */
      price: { type: "number" },
      fee: { type: "number", minimum: 0 },
      /** 现金分红到账金额(税后,用户账户实际收到的) */
      amount: { type: "number", exclusiveMinimum: 0 },
      /** 送转拆股:每 1 股变成几股(10 转 5 = 1.5,1 拆 4 = 4,10 合 1 = 0.1) */
      ratio: { type: "number", exclusiveMinimum: 0 },
      note: TEXT(1000),
      migrated_from: TEXT(80),
    },
    required: ["symbol", "type", "date"],
  },
  /**
   * 旧的持有记录(一只一条:数量 + 均价)。现在只当**收件箱**:Agent / MCP / 导入仍可往这里写,
   * 持仓页打开时迁成一笔期初持仓流水(先备份)。还没迁的照样算「持有」(见 `holdings.ts` heldFromLedger)。
   * 成本与数量是用户自己的事实,产品不猜也不改。
   * ⚠️ 显示名保持「持有」:截图导入的提示词用它(「把资料转写成「持有」记录」)。
   */
  position: {
    label: "持有",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      account: TEXT(40),
      shares: { type: "number", minimum: 0 },
      // 🔴 **成本不设下限**：分红 / 送转吃够了之后，成本价变成负数是真实存在的持仓状态
      //    （开源版 Vibe-Research issue #3 就是用户拿这个来报的）。卡一个 `minimum: 0`
      //    的后果是这类持仓**根本录不进来**，而盈亏本来就按 (现价 − 成本) × 股数 算，
      //    成本为负照样算得出正确结果 —— 拦它换不来任何正确性。
      cost: { type: "number" },
      opened_at: DATE,
      note: TEXT(1000),
    },
    required: ["symbol", "shares", "cost"],
  },

  /** 论点:为什么持有 / 为什么关注。**这是经营闭环的地基** —— 没有它就谈不上"偏离" */
  thesis: {
    label: "论点",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(120),
      statement: TEXT(4000),
      review_by: DATE,
      status: { type: "string", enum: ["active", "paused", "closed"] },
      note: TEXT(1000),
    },
    required: ["title"],
  },

  /**
   * 判据:到期必裁的**裁决点**,或写死的**证伪条件**。
   * 两者共用一种记录、靠 `type` 区分 —— 它们的生命周期完全一样(写下 → 到期 → 判定),
   * 拆成两种只会让"到期清单"要去合并两张表。
   */
  criterion: {
    label: "判据",
    properties: {
      symbol: SYMBOL,
      thesis_id: TEXT(80),
      type: { type: "string", enum: ["decision_point", "falsifier"] },
      statement: NONEMPTY(1000),
      /** 到期日:裁决点通常有,证伪条件可以没有(它是随时可能触发的条件,不是日程) */
      due: DATE,
      status: { type: "string", enum: ["pending", "met", "broken", "dropped"] },
      note: TEXT(1000),
      /** 判定那天与判定时写的理由(事件日历页「判据回看」写入;改回待判时清掉) */
      judged_at: DATE,
      verdict_note: TEXT(1000),
    },
    required: ["type", "statement"],
  },

  /**
   * 自选:只是"我盯着它",还没到写论点的程度。
   *
   * 🔴 与产品自带的**研究线**(界面里那几个可展开的分组)是两回事:
   *    那是随产品发的默认清单(让新用户一打开就知道这一页是干嘛的),
   *    这里是**用户自己加的**。两者混成一张表的话,产品更新默认清单就会动到用户的数据。
   * ⚠️ 自选里出现过不代表持有 —— 持有是 `position`,两张表刻意不互相推断。
   */
  watch: {
    label: "自选",
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      /** 用户自己的分组名(想按什么分就按什么分,产品不给固定选项) */
      tag: TEXT(40),
      note: TEXT(1000),
    },
    required: ["symbol"],
  },

  /**
   * 研究记录:把复盘 / 要点 / 问 Agent 的结果沉淀下来,回头能翻。
   *
   * 🔴 分类字段叫 `category` 而**不是 `kind`** —— `kind` 是 Core 的信封键
   *    (`LEDGER_ENVELOPE_KEYS`),重名会被注册期当场拒。这不是风格问题:
   *    真让它重名,记录的"种类"与"分类"会在同一个键上打架。
   * ⚠️ 与判据 / 论点的区别:那两种是**要拿来对账的**(有到期日、有状态);
   *    这里是**留痕**,不参与任何自动判定。
   */
  note: {
    label: "研究记录",
    properties: {
      symbol: SYMBOL,
      category: { type: "string", enum: ["review", "highlight", "ask", "debate", "audit", "backtest", "compare"] },
      title: NONEMPTY(160),
      /** markdown 正文；回测 / 多空辩论会保留完整多阶段报告，不能沿用短笔记的 2 万字上限。 */
      body: TEXT(100000),
      /** 从旧版导入的(个股深挖),记旧数据的来源,重复导入据此跳过 */
      migrated_from: TEXT(80),
    },
    required: ["title"],
  },

  /**
   * 明日验证条件:复盘那晚写下「下一个交易日用哪个市场读数检验今晚的判断」,一条一个读数(移植自 VA)。
   * `date` 是写下条件的那个复盘日,对账用它的下一个交易日。
   * 只收市场层面读数(涨停家数、炸板率……),不涉及个股、点位或买卖时机。
   * 对账、基准发生率和战绩在 `shortline/verification.ts`;下一场开盘竞价后才写 / 改的条件在那里标「事后」、不计入战绩。
   */
  verification: {
    label: "验证条件",
    // 只能从「明日验证」页面写(shortline/verification.ts 的 act):那里按 09:15 开盘竞价锁删除、判「事后」;
    // 通用台账接口能直接写 written_at、删条目,就绕过了这把锁
    managedWrites: true,
    properties: {
      date: { type: "string", format: "date" },
      metric: { type: "string", enum: VERIFY_METRIC_KEYS },
      direction: { type: "string", enum: DIRECTIONS },
      reason: TEXT(200),
      /** 从旧版导入的条件:记旧数据来源,重复导入据此跳过 */
      migrated_from: TEXT(80),
      /**
       * 旧版里这条条件当初写下的时间(旧版那晚复盘写完的时刻)。只对从旧版导入、导入后没改过的条件生效,
       * 用来判「事后」;不然导入那一刻就成了写下时间,全部算事后。见 shortline/verification.ts itemsByDate。
       */
      written_at: TEXT(40),
    },
    required: ["date", "metric", "direction"],
  },

  /**
   * 制度事件:涨跌幅改制、注册制、号段启用这类规则变化,人工登记(移植自 VA 的制度日历)。
   * 「结构变化」视图把它和数据断点放在一起看;系统**不从数据反推**制度变化。
   * 日期可以是周末(规则常周末公布)也可以是未来(提前公布、还没施行的,视图标出来)。
   */
  regime_event: {
    label: "制度事件",
    properties: {
      date: { type: "string", format: "date" },
      title: NONEMPTY(120),
      note: TEXT(500),
    },
    required: ["date", "title"],
  },

  /**
   * AI 复盘(五段式,移植自 VA):每次生成存一版,不覆盖旧版。
   * 正文、数字核对结果和引到的证据行一起存:回头翻能看到当时依据了什么(资料包本身不存,太长)。
   * 由「情绪复盘 · AI 复盘」写入(shortline/review.ts)。`conditions` 只是 AI 的建议,用户点了才写进 `verification`。
   */
  shortline_review: {
    label: "AI 复盘",
    managedWrites: true, // 只由 AI 复盘自己写(连同数字核对结果),不许经通用接口改
    properties: {
      date: { type: "string", format: "date" },
      /** 写的时候那一天收盘了没有;false = 盘中写的,数字后来还会变 */
      settled: { type: "boolean" },
      /** 用的哪个 AI(界面显示名) */
      ai: TEXT(80),
      started_at: TEXT(40),
      finished_at: TEXT(40),
      sections: { type: "array", minItems: 1, maxItems: REVIEW_SECTIONS.length, items: reviewSection(REVIEW_SECTION_IDS) },
      gaps: { type: "array", maxItems: 80, items: TEXT(400) },
      conditions: {
        type: "array", maxItems: MAX_CONDITIONS,
        items: {
          type: "object", additionalProperties: false, required: ["metric", "direction"],
          properties: { metric: { type: "string", enum: VERIFY_METRIC_KEYS }, direction: { type: "string", enum: DIRECTIONS }, reason: TEXT(200) },
        },
      },
      /** 建议没采用的原因(格式不对、读数不在清单里……) */
      conditions_note: TEXT(300),
      /** 从旧版导入的那一版:记旧数据来源,重复导入据此跳过;页面据此标「旧版导入、没按新版核对」 */
      migrated_from: TEXT(80),
    },
    required: ["date", "sections"],
  },

  /** AI 周报:一周(周一起)的情绪走势、题材轮动、明日验证对账回看 + 汇总。只看市场数据,不含个人交易 */
  shortline_weekly_review: {
    label: "AI 周报",
    managedWrites: true,
    properties: {
      /** 写到哪一天为止(这一周里的最后一个交易日,或写的那天) */
      date: { type: "string", format: "date" },
      /** 这一周的周一:同一周写的几版按它归在一起 */
      week_start: { type: "string", format: "date" },
      /** 这一周算进来的交易日 */
      days: { type: "array", maxItems: 7, items: { type: "string", format: "date" } },
      settled: { type: "boolean" },
      ai: TEXT(80),
      started_at: TEXT(40),
      finished_at: TEXT(40),
      sections: { type: "array", minItems: 1, maxItems: WEEKLY_SECTIONS.length, items: reviewSection(WEEKLY_SECTION_IDS) },
      gaps: { type: "array", maxItems: 80, items: TEXT(400) },
    },
    required: ["date", "week_start", "sections"],
  },

  /**
   * 交易计划:**下单之前**写下的一笔承诺。闭环断的那一环就在这里 ——
   * 过去只剩 `journal_tag`(成交之后才补的记录),于是"这单算不算计划内"只能靠用户事后自己勾一个布尔,
   * 交易日志也只能在**持仓之后**抱怨一句「没写计划止损」。计划先于成交存在,才有办法把
   * 「止损写了吗 / 仓位超没超」放到**买入之前**问,而不是亏完才问。
   * 关联方式:成交后把这条计划的 id 写进 `journal_tag.plan_id`,「交易计划」视图据此做对照。
   * 🔴 仍然是**用户自己写的**:产品不替他生成价位建议,只把他写的原样保存、把到期 / 缺项算出来。
   */
  trade_plan: {
    label: "交易计划",
    // 和交易标注同一档:个人下单价位不让模型看见(沿用「个人交易记录不接入任何 AI」)
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      playbook: { type: "string", enum: PLAYBOOKS },
      /** 为什么做这笔(论点);计划的地基,空着就没法事后检验"理由还在不在" */
      thesis: TEXT(2000),
      /**
       * 计划入场价 / 止损价 / 目标价。
       * 🔴 字段名刻意带 `planned_` 前缀:一是和 `journal_tag` 那套「下单时写下的」同口径,
       *    二是本项目字段标签按**字段名全局复用** —— 裸的 `entry` 已被模式卡占作「怎么进」(正文),
       *    复用会让价格输入框显示成「怎么进」。
       */
      planned_entry: { type: "number", exclusiveMinimum: 0 },
      planned_stop: { type: "number", exclusiveMinimum: 0 },
      planned_target: { type: "number", exclusiveMinimum: 0 },
      /** 计划占仓 %(不是股数:同一套规矩在账户规模变了之后还成立) */
      position_pct: { type: "number", exclusiveMinimum: 0, maximum: 100 },
      /** 观察条件:触发前先看这几条成立没有(最多 5 条,逼自己收敛) */
      watch: { type: "array", maxItems: 5, items: TEXT(200) },
      /** 下一次检查点 HH:MM;到点该计划会被顶到「今天」清单里 */
      next_check: TIME,
      /** 复核日 */
      due: DATE,
      /**
       * 有效期:过了还没成交 = 作废(计划是有时限的念头,不是永久有效的待办)。
       * 🔴 「已过期」是**按今天推导**出来的,不入库 —— 存成 `expired` 会越攒越多且永远不会自己变回来。
       */
      valid_until: DATE,
      status: { type: "string", enum: ["planned", "executed", "abandoned"] },
      /**
       * 成交的那一轮(交易日志那行的 key)。计划页面上「关联这笔交易」就写它 ——
       * 有了它,计划视图才拿得到实际成交价去做事后对照,闭环合得上。
       */
      round_ref: TEXT(80),
      note: TEXT(1000),
    },
    required: ["symbol"],
  },

  /**
   * 交易标注(交易日志用,移植自 VA 的交易记录):给「一笔交易」(同一代码从买进到卖光的一轮,由交易流水推出)
   * 写打法、是否按计划、下单时的计划止损 / 目标、备注。成交本身只在 `trade` 里,这里不存数量和价格。
   * `trade_id` 填这一轮里任意一笔流水的 id;留空 = 没有成交明细的补记(只填盈亏 %,`date` 必填,由交易日志检查)。
   * 🔴 `planned_stop` 必须是**下单时**写下的:在险资金按它算,事后补填会让这个口径失真 ——
   *    `planned_at` 记第一次写下止损 / 目标的时间,晚于买入日的页面标「事后补填」。
   * `as_planned` 不写 = 未标注(不是「计划外」)。
   */
  journal_tag: {
    label: "交易标注",
    hiddenFromAssistant: true,
    properties: {
      symbol: REQUIRED_SYMBOL,
      name: TEXT(40),
      trade_id: TEXT(80),
      /**
       * 这笔出自哪条计划(`trade_plan` 的 id)。**这就是闭环缺的那一环** ——
       * 没有它,交易和计划是两张互不相识的表,`as_planned` 只能是用户自己勾的布尔、无从核对。
       * 留空 = 没从计划来(计划视图会把它列为「待认领」候选,让用户自己挂上)。
       */
      plan_id: TEXT(80),
      date: DATE,
      playbook: { type: "string", enum: PLAYBOOKS },
      as_planned: { type: "boolean" },
      planned_stop: { type: "number", exclusiveMinimum: 0 },
      planned_target: { type: "number", exclusiveMinimum: 0 },
      /** 只用于没有成交明细的补记;有明细的按流水算出的为准 */
      pnl_pct: { type: "number", minimum: -100, maximum: 1000 },
      note: TEXT(500),
      planned_at: TEXT(40),
      migrated_from: TEXT(80),
    },
    required: ["symbol"],
  },

  /**
   * 交易日志设置:费率、风险规矩、账户规模。只认一条(多条时取最后修改的那条,页面提示)。
   * 费率四项要么都不填(用默认、标「默认」),要么都填;只填一部分由交易日志报出来,不拿默认值补。
   * 规矩不填的那项用默认值(VA 同口径)。账户规模不填就不算任何「占账户的比例」,产品不替用户估。
   */
  journal_settings: {
    label: "交易日志设置",
    hiddenFromAssistant: true,
    properties: {
      commission_rate: { type: "number", minimum: 0, maximum: MAX_RATE },
      commission_min: { type: "number", minimum: 0 },
      stamp_tax_rate: { type: "number", minimum: 0, maximum: MAX_RATE },
      transfer_fee_rate: { type: "number", minimum: 0, maximum: MAX_RATE },
      ...Object.fromEntries((Object.keys(DEFAULT_RULES) as RuleKey[]).map((k) => [k,
        k === "max_unplanned_ratio" ? { type: "number", minimum: 0, maximum: 1 }
          : isFractionRule(k) ? { type: "number", exclusiveMinimum: 0 }
            : { type: "integer", minimum: 1 }])),
      equity_base: { type: "number", exclusiveMinimum: 0 },
    },
    required: [],
  },

  /**
   * 模式卡:自己写下的打法,带版本。一张卡一条,版本只追加不覆盖(交易日志页的「模式卡」负责开新版本)。
   * 卡片文字全由用户写,系统只存、不校验内容;打法也进版本(决定哪些交易归这张卡)。
   */
  mode_card: {
    label: "模式卡",
    hiddenFromAssistant: true,
    properties: {
      name: NONEMPTY(MODE_NAME_MAX),
      playbook: { type: "string", enum: PLAYBOOKS },
      versions: {
        type: "array", minItems: 1, maxItems: MODE_VERSIONS_MAX,
        items: {
          type: "object", additionalProperties: false, required: ["version", "since", "playbook"],
          properties: {
            version: { type: "integer", minimum: 1 },
            since: { type: "string", format: "date" },
            changes: TEXT(MODE_CHANGES_MAX),
            playbook: { type: "string", enum: PLAYBOOKS },
            ...Object.fromEntries(MODE_TEXT_FIELDS.map((k) => [k, TEXT(MODE_TEXT_MAX)])),
            saved_at: TEXT(40),
          },
        },
      },
      migrated_from: TEXT(80),
    },
    required: ["name", "playbook", "versions"],
  },

  /** 行动:待办。可由判据到期生成,也可以自己写 */
  action: {
    label: "行动",
    properties: {
      symbol: SYMBOL,
      title: NONEMPTY(200),
      due: DATE,
      status: { type: "string", enum: ["open", "done", "dropped"] },
      /** 关联的判据 / 论点 / 研究运行 id —— 只存字符串,不做外键约束 */
      ref: TEXT(120),
      note: TEXT(1000),
    },
    required: ["title"],
  },

  /**
   * 机会清单台账(P0「机会清单收盘落台账」):收盘后快照当日短线机会清单,次日收盘自动对账每只。
   * 🔴 与前端 patternPrior.ts 的先验表是**两回事**:先验表(PRIOR)是写死的经验概率,存在前端;
   *    这里存的是**本页实测**结果(收红/涨幅/再板),两者在页面上并排显示、互不覆盖。
   * `managedWrites: true`:只由收盘快照/对账任务写入(opportunity_track.ts),通用台账接口不许改 ——
   *    事后手改结算结果会让「实测胜率」失真。
   * 字段口径:category/regime/seal_bucket/in_main_sector 与前端 rescoreOpportunity 同口径镜像;
   * `pattern_confidence` 是清单自带的**原始**置信度(重打分后的在前端,不入库);
   * `market_phase` 是 MarketPhase 六档(冰点/退潮/修复/主升/高潮/极度高潮),算不出时存空串 ——
   *    不用 `phase` 键:它已被模式卡占作「适用的情绪阶段」(字段标签按字段名全局复用)。
   * `settled=false` 的行只快照未结算;`next_ret`/`next_limit_up`/`settled_date` 由次日对账补齐。
   */
  opportunity_track: {
    label: "机会清单台账",
    managedWrites: true,
    properties: {
      date: { type: "string", format: "date" },
      code: NONEMPTY(12),
      name: TEXT(40),
      boards: COUNT,
      sector: TEXT(40),
      seal_time: TIME,
      pattern_type: TEXT(20),
      pattern_confidence: { type: "integer", minimum: 0, maximum: 100 },
      category: { type: "string", enum: ["首板", "连板", "高标"] },
      regime: { type: "string", enum: ["情绪强", "情绪中", "情绪弱", "环境未覆盖"] },
      seal_bucket: TEXT(20),
      in_main_sector: { type: "boolean" },
      market_phase: TEXT(12),
      settled: { type: "boolean" },
      next_ret: { type: "number" },
      next_limit_up: { type: "boolean" },
      settled_date: { type: "string", format: "date" },
    },
    required: ["date", "code", "boards", "category", "regime", "settled"],
  },

  /**
   * 大盘判断台账:WorkBuddy 大盘全景(收盘档)的「交易倾向」快照 + 次日对账。
   * 全景侧把结构化结论写成 `<dataRoot>/inbox/market_call/YYYY-MM-DD.json`(HTML 报告之外的机器交接件),
   * 定时任务(16:05)扫描落账、次日收盘后对账触发条件。
   * 🔴 与 opportunity_track 同一纪律:managedWrites 只许任务写;同日重跑幂等;
   *    触发条件带结构化读数(threshold)+原文(trigger),机器判命中、原文留给人复核。
   *    档位四档口径来自全景 skill §5.1;本台账只存全景产出的判断,**不由本系统生成建议**。
   */
  market_call: {
    label: "大盘判断台账",
    managedWrites: true,
    properties: {
      date: { type: "string", format: "date" },
      call: { type: "string", enum: ["加仓", "持有", "减仓", "观望"] },
      direction: { type: "string", enum: ["偏多", "中性偏多", "中性", "中性偏空", "偏空"] },
      /** 一句话定性(全景报告正文的那句) */
      basis: TEXT(120),
      /** 触发条件原文(如「广度破 45% 转减」) */
      trigger: TEXT(120),
      /** 结构化触发条件:哪个读数、朝哪边、阈值多少 —— 有它机器才能判命中;缺省 = 只留原文不判 */
      trigger_metric: { type: "string", enum: ["breadth_pct", "limit_up", "limit_down", "amount_yi"] },
      trigger_op: { type: "string", enum: ["above", "below"] },
      trigger_value: { type: "number" },
      /** 写下判断那天的读数快照(对照用;广度 = 上涨家数占比 0~100) */
      breadth_pct: { type: "number" },
      amount_yi: { type: "number" },
      limit_up: COUNT,
      limit_down: COUNT,
      /** 对账:次一交易日的同四项读数 */
      settled: { type: "boolean" },
      settled_date: { type: "string", format: "date" },
      next_breadth_pct: { type: "number" },
      next_amount_yi: { type: "number" },
      /** 带 _count 后缀:裸的 next_limit_up 被 opportunity_track 占作「次日再板」(boolean),不共用字段名 */
      next_limit_up_count: COUNT,
      next_limit_down_count: COUNT,
      /** 结构化条件命中没有(true=触发了 / false=没触发 / 缺省=判不了或没给结构化条件) */
      trigger_hit: { type: "boolean" },
      /** 全景 HTML 报告路径(交接件里的 html 字段;断链不拦落账) */
      html_path: TEXT(500),
    },
    required: ["date", "call", "direction", "settled"],
  },
};
