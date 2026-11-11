/**
 * 竞价与盘中路径 · **当下判断**（纯函数，不过模型）。
 *
 * 为什么要有这个文件：
 *   这一页原本只给 6 个时点的横截面读数，「封板率 91.7% → 60.3% 是退潮」这种话要人自己心算斜率。
 *   盘中要的是「到点就知道、不看第二眼」，所以把三条最硬的判据算成灯，配一句五字结论。
 *
 * 🔴 三条铁律：
 *   1. **判据不进模型**。今天封板率掉 31pp 判「不加」，明天同样的读数必须判同样的结论。
 *      LLM 同输入不同输出，做不了这件事 —— 它只负责解释「为什么」和「接下来看什么」。
 *   2. **只看已存的快照，不插值、不补点**。没存的时点就是没有，宁可显示「时点不够」。
 *   3. **灯要带读数**。只给颜色等于让人猜；`91.7% → 60.3%（-31.4pp）` 才是能核对的东西。
 *
 * ⚠️ 下面的阈值是**初始值，未回测**（`SEAL_DROP_*` / `LIMIT_DOWN_*`）。
 *    先用一段时间对照历史跑一遍再定稿，别把当前值当成验证过的结论。
 */
import type { IntradayResult, Slot, SlotRow } from "./watchTypes.ts";

const SLOTS: Slot[] = ["09:25", "09:35", "10:00", "11:30", "14:00", "15:00"];

/** 判据阈值（⚠️ 初始值，未回测） */
const SEAL_DROP_STEP_PP = 5; // 相邻两档掉超过这么多记一次
const SEAL_DROP_TOTAL_PP = 15; // 累计掉这么多判退潮
const SEAL_DROP_STEPS = 3; // 或者有这么多档都在掉
const LIMIT_DOWN_HOT = 30; // 跌停过这么多家就不做
const LIMIT_DOWN_JUMP = 1.5; // 且比上一时点涨了 50% 以上 = 恐慌加速

export type LampTone = "danger" | "warning" | "ok" | "unknown";

export interface Lamp {
  key: "seal" | "limitdown" | "highboard";
  label: string;
  tone: LampTone;
  /** 读数本身，例如 `91.7% → 60.3%（-31.4pp）` */
  read: string;
  /** 为什么判这一档 —— 一句话，让人能复核 */
  why: string;
}

export interface Verdict {
  /** 数据够不够判；不够时 head 是「先攒时点」，不给任何倾向 */
  known: boolean;
  tone: LampTone;
  /** 结论只有五个字左右，不写句子 */
  head: string;
  /** 一句话补充：最尖锐的那条读数；三盏灯都没报警时，说明「按什么执行」的条件状态 */
  note: string;
  lamps: Lamp[];
  /** 三盏灯都没报警时给一个「明日验证」入口；报警时不开链接，别把注意力从风险挪走 */
  verifyLink: boolean;
}

const saved = (r: IntradayResult): SlotRow[] =>
  SLOTS.map((s) => r.slots.find((x) => x.slot === s))
    .filter((x): x is SlotRow => !!x && x.state === "saved" && !!x.snapshot);

const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

/** ① 封板率斜率：看过程，不看某一点的水平值 */
function sealLamp(r: IntradayResult): Lamp {
  const steps = saved(r).filter((s) => s.snapshot!.live?.seal_rate != null);
  if (steps.length < 2) {
    return { key: "seal", label: "封板率斜率", tone: "unknown", read: "时点不够", why: "至少要有两个盘中的时点快照（09:25 是竞价，没有封板率）" };
  }
  const rate = (s: SlotRow) => s.snapshot!.live!.seal_rate!;
  const first = rate(steps[0]!);
  const last = rate(steps[steps.length - 1]!);
  const dropPp = (first - last) * 100;
  let drops = 0;
  for (let i = 1; i < steps.length; i++) {
    if ((rate(steps[i - 1]!) - rate(steps[i]!)) * 100 > SEAL_DROP_STEP_PP) drops++;
  }
  const tone: LampTone = dropPp >= SEAL_DROP_TOTAL_PP || drops >= SEAL_DROP_STEPS
    ? "danger"
    : dropPp > 0 ? "warning" : "ok";
  return {
    key: "seal",
    label: "封板率斜率",
    tone,
    read: `${pct1(first)} → ${pct1(last)}（${signed(-dropPp)}pp）`,
    why: dropPp >= 0
      ? `相邻两次比较里有 ${drops} 次单档掉超 ${SEAL_DROP_STEP_PP}pp`
      : `封板率在回升，说明封住的票越拿越稳`,
  };
}

/** ② 跌停家数：绝对家数 + 增速，两个都要 */
function limitDownLamp(r: IntradayResult): Lamp {
  const rows = saved(r).filter((s) => s.snapshot!.live?.limit_down != null);
  if (!rows.length) {
    return { key: "limitdown", label: "跌停家数", tone: "unknown", read: "没取到", why: "盘中情绪端点这一轮没回来" };
  }
  const last = rows[rows.length - 1]!.snapshot!.live!.limit_down!;
  const prevRow = rows.length > 1 ? rows[rows.length - 2]! : null;
  const prev = prevRow ? prevRow.snapshot!.live!.limit_down! : null;
  const jumped = prev != null && prev > 0 && last >= prev * LIMIT_DOWN_JUMP;
  const tone: LampTone = last >= LIMIT_DOWN_HOT && (jumped || prev == null || prev === 0)
    ? "danger"
    : last >= LIMIT_DOWN_HOT ? "warning" : "ok";
  return {
    key: "limitdown",
    label: "跌停家数",
    tone,
    read: prev == null ? `${last} 家` : `${prev} → ${last} 家`,
    why: last < LIMIT_DOWN_HOT
      ? `没过 ${LIMIT_DOWN_HOT} 家这条线`
      : jumped ? `过 ${LIMIT_DOWN_HOT} 家且在加速（比上一时点涨超 ${Math.round((LIMIT_DOWN_JUMP - 1) * 100)}%）` : `过 ${LIMIT_DOWN_HOT} 家，但没在加速`,
  };
}

/**
 * ③ 高位板竞价：昨日 3 板及以上的中位涨幅。
 *    分板位比全样本中位数更能说明问题 —— 首板高开、高位板低开 = 资金从高处往低处切。
 */
function highBoardLamp(r: IntradayResult): Lamp {
  const t = r.auction?.cohort.by_tier?.["3板及以上"];
  if (!t || t.sample === 0) {
    return { key: "highboard", label: "高位板竞价", tone: "unknown", read: "没有样本", why: "昨日没有 3 板及以上的票，这一档不适用" };
  }
  const tone: LampTone = t.median < -2 ? "danger" : t.median < 0 ? "warning" : "ok";
  return {
    key: "highboard",
    label: "高位板竞价",
    tone,
    read: `中位 ${signed(t.median)}%（${t.sample} 只）`,
    why: `高开占比 ${pct1(t.up_rate)}${t.median < 0 ? " —— 高位票在竞价就被卖，高度已经断了" : ""}`,
  };
}

/**
 * 三盏灯都没亮红 / 黄时，说明「按什么执行」。
 *
 * 旧版写死「按触发清单执行即可」，但判断条上没有清单、也没有入口 —— 那份条件是复盘那晚
 * 自己写在「明日验证」里的，而且常常是空的（2026-11-11 实机：set_date=2026-11-10、items=0）。
 * 现在按 checks 三态分流：有条件 → 报条数；有基准日但没写 → 明说去哪补；条件没读到 → 留白不编。
 */
function noAlarmNote(r: IntradayResult): string {
  const checks = r.checks;
  const items = checks && Array.isArray(checks.items) ? checks.items : null;
  if (items && items.length > 0) {
    return `三条判据都没报警；按昨晚写的 ${items.length} 条验证条件执行（盘中只是临时对照，成不成立以收盘为准）`;
  }
  if (items && checks.set_date) {
    return `三条判据都没报警；${checks.set_date} 晚上没写验证条件，这一轮没有条件可对照；下一轮的去「明日验证」写`;
  }
  return "三条判据都没报警；昨晚的验证条件没读到，按哪几条执行这里不写";
}

export function intradayVerdict(r: IntradayResult): Verdict {
  const lamps = [sealLamp(r), limitDownLamp(r), highBoardLamp(r)];
  const danger = lamps.filter((l) => l.tone === "danger").length;
  const known = lamps.filter((l) => l.tone !== "unknown").length >= 2;

  if (!known) {
    return { known: false, tone: "unknown", head: "先攒时点", note: "至少两个判据有读数才给结论；现在只够看原始数字", lamps, verifyLink: false };
  }
  const head = danger >= 3 ? "退潮中，不加"
    : danger === 2 ? "走弱，别追"
    : danger === 1 ? "分化，选方向"
    : "没亮红灯";
  const tone: LampTone = danger >= 2 ? "danger" : danger === 1 ? "warning" : "ok";
  // note 只取最尖锐的一条（跌停家数 > 封板率斜率 > 高位板竞价），别堆成小作文
  const PRIORITY: Lamp["key"][] = ["limitdown", "seal", "highboard"];
  const worst = PRIORITY.map((k) => lamps.find((l) => l.key === k))
    .find((l) => l && (l.tone === "danger" || l.tone === "warning")) ?? null;
  const note = worst ? `${worst.label}：${worst.read}` : noAlarmNote(r);
  return { known: true, tone, head, note, lamps, verifyLink: !worst };
}

// ─── 区块内联结论（也是纯函数，跟灯同源，不许另算一套） ──────────────────────

export interface InlineTag { text: string; tone: LampTone }

/** 竞价块右上角：分板位告诉你做哪一档 */
export function auctionTag(r: IntradayResult): InlineTag | null {
  const tiers = r.auction?.cohort.by_tier;
  if (!tiers) return null;
  const high = tiers["3板及以上"];
  const first = tiers["首板"];
  if (high && high.sample > 0 && high.median < 0) {
    return first && first.median > 0
      ? { text: "高位崩、低位还行 → 只做首板", tone: "warning" }
      : { text: "高位崩、低位也弱 → 今天不接力", tone: "danger" };
  }
  if (first && first.median < 0) return { text: "首板都不高开 → 承接弱", tone: "warning" };
  return { text: "竞价没报警", tone: "ok" };
}

/** 情绪路径块右上角：涨停数与封板率背离 = 诱多 */
export function pathTag(r: IntradayResult): InlineTag | null {
  const rows = saved(r).filter((s) => s.snapshot!.live?.limit_up != null);
  if (rows.length < 2) return null;
  const lu = rows.map((s) => s.snapshot!.live!.limit_up!);
  const sr = rows.map((s) => s.snapshot!.live?.seal_rate ?? null);
  const peak = Math.max(...lu);
  const lastLu = lu[lu.length - 1]!;
  const firstSr = sr.find((x) => x != null);
  const lastSr = [...sr].reverse().find((x) => x != null);
  if (firstSr != null && lastSr != null && peak >= lastLu && (firstSr - lastSr) * 100 >= SEAL_DROP_TOTAL_PP) {
    return { text: "涨停新高但封板率新低 → 诱多，别追", tone: "danger" };
  }
  if (firstSr != null && lastSr != null && lastSr > firstSr) return { text: "封板率在修复", tone: "ok" };
  return null;
}

/** 给 AI 的结构化摘要：把灯和读数一起给，让模型解释而不是自己另算一套 */
export function verdictDigest(r: IntradayResult): string {
  const v = intradayVerdict(r);
  const rows = saved(r).filter((s) => s.snapshot);
  const path = rows.map((s) => {
    const c = s.snapshot!.cohort;
    const l = s.snapshot!.live;
    return `${s.slot} 昨日涨停股中位 ${signed(c.median)}%（红盘 ${pct1(c.up_rate)}）`
      + (l ? `；全市场涨停 ${l.limit_up ?? "—"} 炸板 ${l.broken ?? "—"} 跌停 ${l.limit_down ?? "—"} 封板率 ${l.seal_rate == null ? "—" : pct1(l.seal_rate)}` : s.slot === "09:25" ? "；竞价时还没有涨停/炸板池" : "；全市场家数没取到");
  });
  const tiers = r.auction?.cohort.by_tier;
  const tierText = tiers
    ? Object.entries(tiers).map(([k, t]) => `${k} 中位 ${signed(t.median)}%（${t.sample} 只，高开 ${pct1(t.up_rate)}）`).join("；")
    : "竞价分板位没取到";
  return [
    `【规则判据（前端纯函数算的，别推翻它，只解释）】`,
    ...v.lamps.map((l) => `- ${l.label}：${l.read}｜${l.why}｜判定 ${l.tone === "danger" ? "报警" : l.tone === "warning" ? "偏弱" : l.tone === "ok" ? "正常" : "没数据"}`),
    `结论：${v.head}（${v.note}）`,
    ``,
    `【09:25 竞价分板位】${tierText}`,
    `【盘中路径】${path.length ? path.join("\n") : "还没存到时点快照"}`,
  ].join("\n");
}
