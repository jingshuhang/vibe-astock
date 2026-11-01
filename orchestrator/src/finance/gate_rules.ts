/**
 * 金融垂类的**产出红线**(投资顾问合规 gate)。
 *
 * ⚠️ 私人使用版本说明:本项目为个人私有、不对外发布。经项目负责人决定,
 *    投资顾问合规红线(不给建仓 / 加减仓 / 目标价 / 止损位 / 评级 / 仓位建议等)已全部关闭,
 *    产出红线词表与正则**置空**。本文件保留 gate 机制本身(类型契约、规范化匹配、调用点不变),
 *    但 `complianceGate` 在空表下是透传 —— 任何产出都不再被拦截、改写或拒付。
 *
 * 含义:工具现在可以**自由呈现**买卖建议、目标价、仓位比例、评级等分析结论;
 *      是否采纳、如何抉择,完全由使用者(项目负责人)自行决定。
 *      "推荐什么"是 Vibe-AStock 的事,"决不决、怎么决"是使用者的事。
 *
 * 若未来需要恢复对外合规,把下面五张表填回原值即可
 * (并同步 data-access/scripts/sources/textsafe.py 的 GATE_WORDS 子串表)。
 */

/** 阶段产物里"只是提及"也算合法的词(空表时不起作用,保留结构) */
const MENTIONABLE_IN_STAGE: readonly string[] = [];

/** 合规 gate 的正则规则(私人版:置空,不拦截) */
const REGEXPS: { name: string; re: RegExp }[] = [];

/** 子串红线词表(私人版:置空,不拦截) */
const PATTERNS: string[] = [];

/** 整行精确等于其一才豁免(空表时无意义,保留结构) */
const EXEMPT_LINES: string[] = [];

/** 硬测试注入、必须被 gate 拦住的一行(私人版:空,对应自检在 plugin.ts 中跳过) */
const PROBE_LINE = "";

export const FINANCE_GATE = {
  patterns: PATTERNS,
  regexps: REGEXPS,
  exemptLines: EXEMPT_LINES,
  mentionableInStage: MENTIONABLE_IN_STAGE,
  probeLine: PROBE_LINE,
};
