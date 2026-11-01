/**
 * AI 盯盘 · 竞价与盘中路径版
 *
 * 跟「实时动态」那版同样 10 分钟一轮、只显示最新一轮；但喂进去的东西完全不同：
 *   - 那边是**异动事件流**（急拉/急跌/封板/开板），让模型串故事；
 *   - 这边是**一天 6 个时点的横截面**（昨日涨停股中位、封板率、跌停、分板位），
 *     已经是结构化读数，模型不该重算判据，只该**解释规则判据说明了什么、下一个时点看哪一条**。
 *
 * 🔴 所以 prompt 里明确要求「别推翻规则判据」：三盏灯是纯函数算的（见 intradayVerdict.ts），
 *    模型的工作是把它讲成人话并给出下一时点的观察点，而不是自己另算一套分。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { hasLlm, chatStream, type ChatMsg } from "@/lib/llm";
import { isMarketTrading } from "@/lib/marketSymbol";
import type { IntradayResult } from "./watchTypes.ts";
import { verdictDigest } from "./intradayVerdict.ts";

const POLL_INTERVAL_MS = 10 * 60 * 1000;

const PROMPT = `你是盘中节奏分析师。下面给的是同一天里已经存下的若干时点快照（09:25 竞价 + 盘中各时点），
以及前端用固定规则算出的三条判据和它们的判定结果。

硬性约束:
- 只依据上面给的读数推断,不得引用任何外部信息,不得预测涨跌,不得给买卖建议。
- **不要推翻规则判据**。三盏灯是固定阈值算出来的；你的任务是解释它说明了什么，不是自己另算一套结论。
- 数字只能来自上面，缺的写"—"，严禁编造。
- 只讲今天已经发生的路径，不讲"明天会怎样"。

请输出 Markdown，严格两段：

### 现在是什么节奏
用 2-3 句话说清这条路径的性质：是一路走弱、还是探底回升、还是数量在涨质量在掉（诱多）。
必须落到具体读数上（哪两个时点之间、从多少到多少）。

### 接下来盯什么
列 2-3 条编号要点，格式「时点 → 看哪条读数 → 越过什么就算变盘」。例：
1. 14:00 → 封板率 → 若跌破 65% 且跌停过 30 家，今天就不做了。
每条一行，简短。`;

export interface IntradayAiState {
  loading: boolean;
  summary: string;
  error: string | null;
  lastRunAt: number | null;
  needConfig: boolean;
  intraday: boolean;
  run: () => void;
}

export function useIntradayAiWatch(r: IntradayResult | null): IntradayAiState {
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [intraday, setIntraday] = useState(false);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // 每轮渲染同步最新数据；run 只读 ref，避免 effect 因 r 换引用而重触发（r 每分钟重新取一次）
  const rRef = useRef<IntradayResult | null>(null);
  rRef.current = r;
  const firstDeltaRef = useRef(true);

  const run = useCallback(() => {
    if (runningRef.current) return;
    if (!hasLlm()) { setNeedConfig(true); return; }
    const cur = rRef.current;
    // 盯盘只管「当下这一天」：翻历史日期时让页面 AI 去答，别拿收盘后的定格当成盘中在跑
    if (!cur || !cur.today || !isMarketTrading("CN")) return;
    // 一张快照都没有 = 没有可分析的东西，别拿空表去问模型
    if (!cur.slots.some((s) => s.state === "saved")) return;

    runningRef.current = true;
    setLoading(true);
    setError(null);
    setNeedConfig(false);
    firstDeltaRef.current = true;

    const ctl = new AbortController();
    abortRef.current = ctl;
    const msg: ChatMsg = { role: "user", content: `${PROMPT}\n\n${verdictDigest(cur)}` };

    chatStream([msg], "", {
      onDelta: (t) => {
        setSummary((prev) => (firstDeltaRef.current ? t : prev + t));
        firstDeltaRef.current = false;
      },
    })
      .then(() => setLastRunAt(Date.now()))
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

  // 依赖取「今天开不开市 + 存到第几张」这种离散量：r 本身每分钟换引用，放进依赖会把 10 分钟节奏架空
  const savedCount = r?.today && r.trading_day !== false ? r.slots.filter((s) => s.state === "saved").length : 0;
  useEffect(() => {
    const on = isMarketTrading("CN") && savedCount > 0;
    setIntraday(on);
    if (!on) return;
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
  }, [savedCount, run]);

  return { summary, loading, error, lastRunAt, needConfig, intraday, run };
}
