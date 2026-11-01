/**
 * 竞价与盘中路径 · 当下判断条（页面第一屏，紧跟 AI 盯盘）
 *
 * 一条带子回答「现在做不做」，三个灯分别说明为什么：
 *   封板率斜率 / 跌停家数 / 高位板竞价 —— 全部来自 `intradayVerdict.ts` 的纯函数。
 *
 * 🔴 配色纪律：这是**判断档位**，不是涨跌，所以不用红绿（danger / success 只留给价格）。
 *    报警用 warning、偏弱同色降透明、正常用 primary、没数据用 muted。
 */
import { cn } from "@/lib/utils";
import type { Lamp, LampTone, Verdict } from "./intradayVerdict";

const CARD: Record<LampTone, string> = {
  danger: "border-warning/45 bg-warning/[0.07]",
  warning: "border-info/40 bg-info/[0.05]",
  ok: "border-primary/35 bg-primary/[0.05]",
  unknown: "border-border/60 bg-muted/[0.12]",
};
const HEAD_INK: Record<LampTone, string> = {
  danger: "text-warning",
  warning: "text-info",
  ok: "text-primary",
  unknown: "text-muted-foreground",
};
const DOT: Record<LampTone, string> = {
  danger: "bg-warning",
  warning: "bg-warning/45",
  ok: "bg-primary/55",
  unknown: "bg-muted-foreground/25",
};
const READ_INK: Record<LampTone, string> = {
  danger: "text-foreground",
  warning: "text-foreground",
  ok: "text-foreground",
  unknown: "text-muted-foreground",
};

function LampCell({ l }: { l: Lamp }) {
  return (
    <div className="min-w-[10.5rem] flex-1" title={l.why}>
      <div className="flex items-center gap-1.5">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[l.tone])} />
        <span className="text-[13px] text-muted-foreground">{l.label}</span>
      </div>
      <div className={cn("mt-1 font-mono text-[15px] font-semibold tabular-nums", READ_INK[l.tone])}>{l.read}</div>
      <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{l.why}</div>
    </div>
  );
}

export function IntradayVerdictBar({ v }: { v: Verdict }) {
  return (
    <div className={cn("rounded-xl border px-4 py-3", CARD[v.tone])}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="flex flex-1 flex-wrap gap-x-6 gap-y-3">
          {v.lamps.map((l) => <LampCell key={l.key} l={l} />)}
        </div>
        <div className="shrink-0 border-t border-border/40 pt-2.5 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <div className="text-[12px] text-muted-foreground">现在做不做</div>
          <div className={cn("mt-0.5 text-[22px] font-semibold leading-tight", HEAD_INK[v.tone])}>{v.head}</div>
          <div className="mt-1 max-w-[16rem] text-[12px] leading-snug text-muted-foreground">{v.note}</div>
        </div>
      </div>
      {!v.known && (
        <p className="mt-2 border-t border-dashed border-border/50 pt-2 text-[12px] text-muted-foreground">
          判据不足时不给倾向 —— 宁可写「先攒时点」，也不靠一个读数猜方向。
        </p>
      )}
    </div>
  );
}
