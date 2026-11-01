/**
 * AI 盯盘 · 实时动态版
 *
 * 基于 LiveTab 的 WatchView（持仓/自选/异动/梯队/大票），每 10 分钟触发一次
 * 瞬时分析，只显示最新一轮的结果，历史存档仅供连续性判断。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { hasLlm, chatStream, type ChatMsg } from "@/lib/llm";
import type { WatchView, AlertKind } from "./watchTypes";

const POLL_INTERVAL_MS = 10 * 60 * 1000;

const INTRADAY_PHASES = new Set(["morning", "afternoon", "auction", "closing_auction"]);

const PROMPT = `你是盘面异动分析师。下面只提供今天盘中实时产生的「异动」事件(急拉 / 急跌 / 封板 / 开板),每条含时间、个股、3 分钟涨跌幅与今日涨跌幅。

硬性约束:
- 只依据上面这些事件推断,不得引用任何外部信息,不得预测涨跌,不得给买卖建议。
- 只分析今天实时产生的数据;历史或盘前信息不纳入。
- 证据不足的论断写"—",严禁编造数字或个股。
- 输入已按【板块主线】【情绪温度】【时间节奏】【个股动作序列】【风险信号】预聚合,优先依据这些聚合结论串逻辑,原始事件仅用于核对细节。

请输出「今日盘面核心逻辑」,用 Markdown,严格两段:

### 逻辑链条
用一句话把今天异动串成因果或轮动链条(例:早盘急拉集中在 X → 随后高位 Y 急跌 → 封板陆续开板)。信号不足时只写"暂未形成清晰主线"。

### 关键判断
列 2-4 条编号要点,每条先抛一个判断问题再给结论,例如:
1. 资金在进攻还是撤退?——急跌条数明显多于急拉且集中于高位票,偏向获利了结。
2. 封板质量如何?——封板 N 只、开板 M 只,开板占比高说明追板意愿弱。
3. 异动是否集中在某题材 / 梯队?——点出出现最多的板块或"昨日 N 板"标签。
每条一行、文字简短,让人在面板上能一眼看清。`;

/** 只取盘中异动事件喂给模型;持仓按产品规则不发 AI,只因持仓才盯的异动整条剔除。
 *  输出结构:预聚合(板块主线 / 情绪温度 / 时间节奏 / 个股序列 / 风险信号) + 原始事件全量附录。
 *  先给模型骨架再附全量,避免扁平长串时抓不住重点,同时不裁剪任何数据。 */
function alertsOnlySummary(v: WatchView): string {
  const HOLDING_TAG = "持仓";
  const KIND_KEYS: AlertKind[] = ["封板", "开板", "急拉", "急跌"];
  const NO_SECTOR = "（无板块标签）";

  const alerts = v.alerts.flatMap((a) => {
    if (!a.sources.includes(HOLDING_TAG)) return [a];
    const sources = a.sources.filter((s) => s !== HOLDING_TAG);
    return sources.length ? [{ ...a, sources }] : [];
  });

  const header = `北京时间 ${v.date} ${v.clock},${v.phase_label}${v.detecting ? ",正在判断异动" : ""}。`;
  if (!alerts.length) return `${header}\n今天还没记下异动。`;

  const kindTotal: Record<AlertKind, number> = { 封板: 0, 开板: 0, 急拉: 0, 急跌: 0 };
  const sectorMap = new Map<string, { kinds: Record<AlertKind, number>; names: Set<string>; morn: number; aft: number }>();
  const timeBucket = new Map<string, number>();
  const byCode = new Map<string, { name: string; seq: { t: string; kind: AlertKind }[] }>();
  const sectorFirstSeal = new Map<string, { t: string; name: string; code: string }>();

  const hhmm = (ts: string): string => {
    const m = ts.match(/(\d{1,2}):(\d{2})/);
    if (!m) return ts;
    return `${m[1]!.padStart(2, "0")}:${m[2]!}`;
  };
  const bucketLabel = (ts: string): string => {
    const t = hhmm(ts);
    const parts = t.split(":");
    const h = parseInt(parts[0] ?? "0", 10);
    const min = parseInt(parts[1] ?? "0", 10);
    const start = min < 30 ? 0 : 30;
    let eh = h, em = start + 30;
    if (em === 60) { em = 0; eh = h + 1; }
    return `${String(h).padStart(2, "0")}:${String(start).padStart(2, "0")}-${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
  };
  // 早盘 = 9:30–11:30,其余(13:00–15:00)算午后;午间休市无交易,无需特判
  const isMorn = (ts: string): boolean => {
    const parts = hhmm(ts).split(":");
    const h = parseInt(parts[0] ?? "0", 10);
    const m = parseInt(parts[1] ?? "0", 10);
    return h < 11 || (h === 11 && m <= 30);
  };

  for (const a of alerts) {
    kindTotal[a.kind] += 1;

    // 板块主线用真实行业板块(sectors);没有真实行业的票归到「无板块标签」,不把选股名单标签(昨日N板/大票等)当板块混进来
    const sectorKeys = a.sectors.length ? a.sectors : [NO_SECTOR];
    const morn = isMorn(a.ts);
    for (const s of sectorKeys) {
      if (!sectorMap.has(s)) sectorMap.set(s, { kinds: { 封板: 0, 开板: 0, 急拉: 0, 急跌: 0 }, names: new Set(), morn: 0, aft: 0 });
      const e = sectorMap.get(s)!;
      e.kinds[a.kind] += 1;
      e.names.add(a.name);
      if (morn) e.morn += 1; else e.aft += 1;
      if (a.kind === "封板") {
        const t = hhmm(a.ts);
        const cur = sectorFirstSeal.get(s);
        if (!cur || t < cur.t) sectorFirstSeal.set(s, { t, name: a.name, code: a.code });
      }
    }

    timeBucket.set(bucketLabel(a.ts), (timeBucket.get(bucketLabel(a.ts)) ?? 0) + 1);

    if (!byCode.has(a.code)) byCode.set(a.code, { name: a.name, seq: [] });
    byCode.get(a.code)!.seq.push({ t: hhmm(a.ts), kind: a.kind });
  }

  // 维度1 板块主线
  const sectorRows = [...sectorMap.entries()]
    .map(([s, e]) => ({ s, total: KIND_KEYS.reduce((n, k) => n + e.kinds[k], 0), e }))
    .sort((x, y) => y.total - x.total)
    .slice(0, 10);
  const sectorText = sectorRows
    .map(({ s, e }) => {
      const names = [...e.names].slice(0, 3).join("、");
      return `${s}(封${e.kinds.封板}/拉${e.kinds.急拉}/跌${e.kinds.急跌}/开${e.kinds.开板}${names ? ` [${names}]` : ""})`;
    })
    .join(" ");
  // 板块轮动:早盘主力 → 午后接棒
  const mornTop = [...sectorMap.entries()].filter(([s]) => s !== NO_SECTOR).sort((a, b) => b[1].morn - a[1].morn).slice(0, 3);
  const aftTop = [...sectorMap.entries()].filter(([s]) => s !== NO_SECTOR).sort((a, b) => b[1].aft - a[1].aft).slice(0, 3);
  // 早盘尚无午后活动时不挂"午后接棒"一截,避免让人误以为下午数据混了进来
  const aftActive = aftTop.some(([, e]) => e.aft > 0);
  const rotationText = mornTop.length
    ? `轮动:早盘主力[${mornTop.map(([s, e]) => `${s}(${e.morn})`).join("、")}]` + (aftActive ? ` → 午后接棒[${aftTop.map(([s, e]) => `${s}(${e.aft})`).join("、")}]` : "")
    : "";

  // 维度2 情绪温度
  const sealRate = kindTotal.封板 + kindTotal.开板 > 0
    ? Math.round((kindTotal.封板 / (kindTotal.封板 + kindTotal.开板)) * 100)
    : null;
  const rateLabel = sealRate === null ? "无封/开板样本" : sealRate >= 70 ? "高" : sealRate >= 40 ? "中" : "低";
  const sentimentText = `封板${kindTotal.封板} 开板${kindTotal.开板} 急拉${kindTotal.急拉} 急跌${kindTotal.急跌};封板率${sealRate === null ? "—" : sealRate + "%"}(${rateLabel})`;

  // 维度3 时间节奏
  const timeText = [...timeBucket.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}(${n}起)`)
    .join(" ");

  // 维度4/5 个股动作序列(出现≥2次) + 动作三态(封板未开·强势 / 封板后开板·分歧 / 开板回封·弱转强)
  const codeFlags = new Map<string, { openAfterSeal: boolean; reSealAfterOpen: boolean }>();
  for (const [code, x] of byCode) {
    const seq = [...x.seq].sort((a, b) => a.t.localeCompare(b.t));
    let seenSeal = false, opened = false, openAfterSeal = false, reSealAfterOpen = false;
    for (const s of seq) {
      if (s.kind === "封板") {
        if (opened) { reSealAfterOpen = true; opened = false; } // 开板后再次封板 = 弱转强
        seenSeal = true;
      }
      if (seenSeal && s.kind === "开板") { openAfterSeal = true; opened = true; }
    }
    codeFlags.set(code, { openAfterSeal, reSealAfterOpen });
  }
  const repeats = [...byCode.entries()].filter(([, x]) => x.seq.length >= 2)
    .map(([code, x]) => {
      const seq = [...x.seq].sort((a, b) => a.t.localeCompare(b.t));
      const sealed = seq.some((s) => s.kind === "封板");
      const f = codeFlags.get(code)!;
      let tag: string;
      if (f.reSealAfterOpen) tag = " [开板回封·弱转强]";
      else if (f.openAfterSeal) tag = " [封板后开板·分歧]";
      else if (sealed) tag = " [封板未开·强势]";
      else tag = "";
      return { name: x.name, seqStr: seq.map((s) => `${s.t}${s.kind}`).join("→"), tag, n: seq.length };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, 15);
  const repeatText = repeats.length
    ? repeats.map((r) => `${r.name}:${r.seqStr}${r.tag}`).join("\n  ")
    : "无（每只票仅 1 次异动）";
  // 身位龙头:板块内最早封板,且后续未开板(干净封板身位)
  const leaderEntries = [...sectorFirstSeal.entries()].filter(([, x]) => {
    const f = codeFlags.get(x.code);
    return !f || !f.openAfterSeal;
  });
  const leaderText = leaderEntries.length
    ? `身位龙头候选(板块内最早封板且未开板):${leaderEntries.map(([, x]) => x.name).join("、")}`
    : "暂无封板";

  // 维度6 风险信号
  const dropSectors = [...sectorMap.entries()].filter(([, e]) => e.kinds.急跌 > 0).map(([s]) => s).filter((s) => s !== NO_SECTOR);
  const openAfterSealCount = [...codeFlags.values()].filter((f) => f.openAfterSeal && !f.reSealAfterOpen).length;
  const risks: string[] = [];
  if (dropSectors.length >= 3) risks.push(`急跌跨板块扩散(涉及${dropSectors.length}个板块):${dropSectors.slice(0, 8).join("、")}`);
  if (openAfterSealCount > 0) risks.push(`封板后开板${openAfterSealCount}起(高位情绪松动)`);
  const riskText = risks.length ? risks.join(";") : "暂无显著风险信号";

  // 原始附录(全量,不裁剪)
  const raw = alerts.map((a) => `${a.ts} ${a.kind} ${a.name}(${a.code}) ${a.msg}${a.sources.length ? ` [${a.sources.join("、")}]` : ""}`).join(";");

  return [
    header,
    `【板块主线】${sectorText}${rotationText ? "\n  " + rotationText : ""}`,
    `【情绪温度】${sentimentText}`,
    `【时间节奏】${timeText}`,
    `【个股动作序列(≥2次)】\n  ${repeatText}\n${leaderText}`,
    `【风险信号】${riskText}`,
    `【原始异动事件(全量,新→旧)】${raw}`,
  ].join("\n");
}

function buildPrompt(v: WatchView): ChatMsg {
  return { role: "user", content: `${PROMPT}\n\n${alertsOnlySummary(v)}` };
}

export interface AiWatchState {
  loading: boolean;
  summary: string;
  error: string | null;
  lastRunAt: number | null;
  needConfig: boolean;
  intraday: boolean;
  run: () => void;
}

export function useAiWatch(v: WatchView | null): AiWatchState {
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [intraday, setIntraday] = useState(false);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const vRef = useRef<WatchView | null>(null);
  vRef.current = v; // 每轮渲染同步最新数据;run 只读这个 ref,避免 effect 因 v 每 3 秒换引用而重触发
  const firstDeltaRef = useRef(true); // 本轮首个增量到达前不清旧内容;首段替换、其后追加,避免空白期也不拼接

  const run = useCallback(() => {
    if (runningRef.current) return;
    if (!hasLlm()) { setNeedConfig(true); return; }
    const cur = vRef.current;
    if (!cur || !INTRADAY_PHASES.has(cur.phase)) return;

    runningRef.current = true;
    setLoading(true);
    setError(null);
    setNeedConfig(false);
    firstDeltaRef.current = true; // 等新一轮首个增量到了再替换旧内容,生成期间一直显示上一轮

    const ctl = new AbortController();
    abortRef.current = ctl;

    const msg = buildPrompt(cur);
    chatStream([msg], "", {
      onDelta: (t) => {
        setSummary((prev) => (firstDeltaRef.current ? t : prev + t));
        firstDeltaRef.current = false;
      },
    })
      .then(() => {
        setLastRunAt(Date.now());
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "分析失败");
      })
      .finally(() => {
        runningRef.current = false;
        setLoading(false);
        abortRef.current = null;
      });
  }, []);

  useEffect(() => {
    // 只在「交易时段」内跑:进入盘中立即分析一次,之后严格每 10 分钟一次。
    // 依赖用 v?.phase 而非 v 本身 —— v 每 3 秒换引用,放进依赖会每 3 秒重触发,把 10 分钟节奏架空。
    const isNowIntraday = !!v && INTRADAY_PHASES.has(v.phase);
    setIntraday(isNowIntraday);
    if (!isNowIntraday) return;

    if (!document.hidden) void run();
    const id = setInterval(() => {
      if (!document.hidden && !runningRef.current) void run();
    }, POLL_INTERVAL_MS);

    const onVisible = () => {
      if (!document.hidden && !runningRef.current) void run();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      abortRef.current?.abort();
    };
  }, [v?.phase, run]);

  return { summary, loading, error, lastRunAt, needConfig, intraday, run };
}
