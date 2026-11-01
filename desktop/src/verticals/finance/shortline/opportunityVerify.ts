/**
 * 超短线机会发现 · **验证流**（纯函数，不过模型）。
 *
 * 为什么要有这个文件：
 *   「机会发现」只回答「今天有哪些模式候选」，回答不了「今天能不能做」——
 *   同一个「首板爆发」，主升期是机会、退潮期是接盘。盯盘三页（实时动态 / 市场实时概况 / 竞价与盘中路径）
 *   已经把环境读成了动态结论，这里只做一件事：**把环境结论盖到每个候选上**，给出 支持 / 观察 / 降级 / 回避。
 *
 * 🔴 三条铁律（跟 intradayVerdict.ts 同一套）：
 *   1. **判据不进模型**。今天判断条判「退潮」，清单就全部回避；明天同样的读数必须给同样的裁决。
 *   2. **不另算一套**。判断条的灯直接取 `intradayVerdict()` 的结果（跟竞价页同一个函数、同一份快照），
 *      梯队承接直接取 `ladderStats()`（跟实时动态同一个函数）—— 两页各数一遍，迟早出现
 *      「这页写上涨 1、那页写红盘率 50%」这种对不上的数字，比没有数字更害人。
 *   3. **佐证取不到就不给倾向**。宁可总裁决写「佐证不足，只看不加」、个股全部「观察」，
 *      也不拿模式置信度冒充环境判断 —— 置信度是「这只票像不像模式」，不是「今天能不能做」。
 *
 * ⚠️ 阈值（`SUPPORT_MIN_CONF` / `LADDER_WEAK_UP_RATE`）是**初始值，未回测**。
 *    上线后拿历史对照跑一遍再定稿。
 * ⚠️ 个股置信度已改为**从本地实证按「环境×模式」查表**（见 patternPrior.ts）——
 *    不再用 opportunities.ts 里拍脑袋的常数。历史均值为负的格子直接回避。
 */
import { intradayVerdict, auctionTag, type LampTone, type Verdict } from "./intradayVerdict";
import { ladderStats } from "./ladderFacts";
import { rescoreOpportunity, type RescoreResult } from "./patternPrior";
import type { IntradayResult, WatchView } from "./watchTypes";
import type { MarketStateResult } from "@/lib/marketState";
import type { StockOpportunity, ShortlineOpportunityResult } from "@/lib/shortlineOpportunities";

/** 模式置信度过这条线、且环境不反对，才判「支持」（⚠️ 初始值，未回测） */
const SUPPORT_MIN_CONF = 70;
/** 昨日梯队今天红盘低于这个比例 = 没承接，接力类降级（⚠️ 初始值，未回测） */
const LADDER_WEAK_UP_RATE = 0.3;
/** 这几个模式吃「昨日涨停今天的承接」，首板爆发不吃（它是今天的首板） */
const RELAY_PATTERNS = new Set(["弱转强", "龙头接力", "N字反包", "分歧转一致"]);

/** 一条佐证：来自哪一页、读数是什么、为什么这么判 */
export interface VerifyGate {
  key: string;
  /** 来源页面 —— 佐证必须能追溯到源头，不然没法复核 */
  from: string;
  label: string;
  tone: LampTone;
  /** 读数本身（mono 展示），例如 `25 → 82 家` */
  read: string;
  why: string;
}

/** 个股裁决。档位语不是买卖建议，是「环境对这个模式的态度」 */
export type OppCall = "支持" | "观察" | "降级" | "回避";
/** 清单排序用：支持排最前 */
export const CALL_ORDER: Record<OppCall, number> = { 支持: 0, 观察: 1, 降级: 2, 回避: 3 };

export interface TaggedOpp {
  opp: StockOpportunity;
  call: OppCall;
  /** 一句话，能对着页面上的读数复核 */
  why: string;
  /** 查表得到的先验（置信度、证据、风险提示）；个股裁决用的就是它 */
  prior: RescoreResult;
}

export interface VerifyFlow {
  /** 佐证能不能给出倾向；false 时总裁决是「只看不加」，个股全部「观察」 */
  known: boolean;
  tone: LampTone;
  /** 五个字左右，不写句子 */
  head: string;
  note: string;
  /** 盘中判断条的灯（竞价与盘中路径页同一份）；没取到盘中数据时 null */
  lamps: Verdict["lamps"] | null;
  gates: VerifyGate[];
  tagged: TaggedOpp[];
  counts: Record<OppCall, number>;
}

const pct0 = (v: number) => `${Math.round(v * 100)}%`;

export function verifyOpportunities(input: {
  /** 机会发现层的清单（本页端点的输出） */
  opps: ShortlineOpportunityResult;
  /** 竞价与盘中路径页的数据；null = 没取到 */
  intra: IntradayResult | null;
  /** 实时动态页的数据；null = 没取到（非交易时段也不取） */
  watch: WatchView | null;
  /** 市场状态信号（市场实时概况页与「市场状态」页同一份）；null = 没取到 */
  mkt: MarketStateResult | null;
}): VerifyFlow {
  const { opps, intra, watch, mkt } = input;
  // 判断条：跟竞价页同一个函数、同一份快照 —— 这里的灯和那一页的灯必然一字不差
  const verdict = intra ? intradayVerdict(intra) : null;
  const sig = mkt?.signal ?? null;

  const gates: VerifyGate[] = [];

  // ── 佐证① 市场状态闸门（仓位上限是最硬的一道：0 就是一股都不开） ──
  const cap = sig?.position_cap_pct ?? null;
  const closed = cap === 0 || sig?.can_open_position === false;
  const phase = sig?.phase ?? null;
  if (sig) {
    const tone: LampTone = closed ? "danger"
      : phase === "退潮期" || phase === "冰点期" ? "warning" : "ok";
    gates.push({
      key: "mktstate", from: "盯盘 · 市场实时概况", label: "市场状态闸门", tone,
      read: `综合 ${sig.composite ?? "—"} · ${phase ?? "相位没算出"} · 仓位上限 ${cap == null ? "不设" : `${cap}%`}`,
      why: closed
        ? (sig.gate_blockers?.[0] ?? "三道门没过，信号把上限压到了 0")
        : sig.base_note ?? (phase ? `五维加权判的${phase}` : "相位没算出来，这里只显示分数"),
    });
  }

  // ── 佐证②③④ 盘中判断条的三盏灯（竞价与盘中路径页同源） ──
  if (verdict) {
    for (const l of verdict.lamps) {
      gates.push({ key: `lamp_${l.key}`, from: "盯盘 · 竞价与盘中路径", label: l.label, tone: l.tone, read: l.read, why: l.why });
    }
  }

  // ── 佐证⑤ 竞价方向（做首板还是做接力，竞价分板位说了算） ──
  const auction = intra ? auctionTag(intra) : null;
  const tiers = intra?.auction?.cohort.by_tier;
  if (auction && tiers) {
    const hi = tiers["3板及以上"];
    const first = tiers["首板"];
    gates.push({
      key: "auction", from: "盯盘 · 竞价与盘中路径", label: "竞价方向", tone: auction.tone, read: auction.text,
      why: `首板中位 ${first ? `${first.median >= 0 ? "+" : ""}${first.median.toFixed(1)}%（${first.sample} 只）` : "没样本"}`
        + ` · 3板以上中位 ${hi ? `${hi.median >= 0 ? "+" : ""}${hi.median.toFixed(1)}%（${hi.sample} 只）` : "没样本"}`,
    });
  }

  // ── 佐证⑥ 昨日梯队承接（实时动态页的读数） ──
  let ladderGate: VerifyGate | null = null;
  if (watch?.ladder) {
    const ls = ladderStats(watch.ladder.rows);
    const upRate = ls.sample > 0 ? ls.up / ls.sample : null;
    const tone: LampTone = upRate == null ? "unknown"
      : upRate < LADDER_WEAK_UP_RATE ? "danger"
      : upRate < 0.5 ? "warning" : "ok";
    ladderGate = {
      key: "ladder", from: "盯盘 · 实时动态", label: "昨日梯队承接", tone,
      read: upRate == null ? "今天还没取到行情" : `红盘 ${pct0(upRate)}（${ls.up}/${ls.sample} 只）`,
      why: ls.sample === 0 ? "样本是昨日涨停股，今天还没行情（竞价时段 / 非交易日）"
        : ls.sealed == null ? "封住几只后端这轮没说"
        : ls.sealed > 0 ? `其中 ${ls.sealed} 只又封回涨停` : "一只都没封住",
    };
    gates.push(ladderGate);
  }

  // ── 总裁决 ──
  // 优先级：仓位上限（市场状态页）> 盘中判断条（竞价与盘中路径页）> 佐证不足
  // 判断条能给结论时**抄它的 head**，不另造词 —— 两页看到的必须是同一句话
  let tone: LampTone;
  let head: string;
  let note: string;
  let known: boolean;
  if (closed) {
    known = true; tone = "danger"; head = "环境关闭，不加";
    note = cap === 0 ? "市场状态把仓位上限压到 0 —— 下面的清单只是备选，不是今天要做" : "信号判了不能开新仓";
  } else if (verdict?.known) {
    known = true; tone = verdict.tone; head = verdict.head; note = verdict.note;
  } else {
    known = false; tone = "unknown"; head = "佐证不足，只看不加";
    note = verdict ? verdict.note : "竞价与盘中路径的数据没取到（这一页要当天的盘中快照）";
  }

  // ── 个股裁决 ──
  // 置信度来自 patternPrior 的实证查表（环境×模式→历史胜率），不用 opportunities.ts 拍脑袋的常数
  // phase 复用上面市场状态闸门段的同一份（不另算一套）
  const mainSectors = opps.main_sectors ?? [];
  const highLamp = verdict?.lamps.find((l) => l.key === "highboard") ?? null;
  const tagged: TaggedOpp[] = opps.opportunities.map((opp) => {
    const type = opp.pattern?.type ?? "";
    const prior = rescoreOpportunity(opp, { phase, mainSectors });
    // 环境明确反对时，模式再漂亮也是接盘
    if (tone === "danger") {
      return { opp, prior, call: "回避" as const, why: closed ? "仓位上限 0%，环境不给开仓" : `环境判「${head}」` };
    }
    if (!known) {
      return { opp, prior, call: "观察" as const, why: "盘中佐证不够，只能看模式本身" };
    }
    // 数据驱动的回避：这个环境×类别的历史均值为负 = 亏钱效应，不做（比一刀切更准，不误伤高标·情绪中 +3.25%）
    if (prior.avg < 0) {
      return { opp, prior, call: "回避" as const, why: `${prior.category}·${prior.regime} 历史均值 ${prior.avg}%（亏钱效应）` };
    }
    const isHigh = type === "龙头接力" || opp.boards >= 3;
    if (isHigh && highLamp && (highLamp.tone === "danger" || highLamp.tone === "warning")) {
      return { opp, prior, call: "降级" as const, why: `高位板竞价 ${highLamp.read} —— 高位这条线今天不通` };
    }
    if (auction?.text.includes("只做首板") && type !== "首板爆发") {
      return { opp, prior, call: "降级" as const, why: "竞价方向是「只做首板」，接力类今天没有环境支持" };
    }
    if (ladderGate?.tone === "danger" && RELAY_PATTERNS.has(type)) {
      return { opp, prior, call: "降级" as const, why: `${ladderGate.read} —— 昨日涨停没有承接，接力类先放` };
    }
    const conf = prior.confidence;
    return conf >= SUPPORT_MIN_CONF
      ? { opp, prior, call: "支持" as const, why: `${type} 置信 ${conf}，环境「${head}」` }
      : { opp, prior, call: "观察" as const, why: `置信 ${conf}（< ${SUPPORT_MIN_CONF}），环境没反对但模式不够硬` };
  });

  // 清单按裁决排序：支持最前。回避不删 —— 删了人会以为「今天一只都没有」，而事实上模式是匹配到的
  const order = [...tagged].sort((a, b) => CALL_ORDER[a.call] - CALL_ORDER[b.call]
    || b.prior.confidence - a.prior.confidence);

  const counts: Record<OppCall, number> = { 支持: 0, 观察: 0, 降级: 0, 回避: 0 };
  for (const t of tagged) counts[t.call]++;

  return { known, tone, head, note, lamps: verdict?.lamps ?? null, gates, tagged: order, counts };
}
