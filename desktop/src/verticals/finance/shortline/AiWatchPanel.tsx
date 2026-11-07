/**
 * AI 盯盘面板 — 流式展示 AI 分析结果
 *
 * 同一个面板给两页用（实时动态 / 竞价与盘中），差别只在标题和「非交易时段」那句提示：
 * 两页的 state 形状一致（loading / summary / error / needConfig / intraday / run），
 * 所以不必抄第二份渲染逻辑 —— 抄一份就会出现「一边改了 markdown 样式、另一边还是旧的」。
 */
import { BrainCircuit, Loader2, RefreshCw, AlertCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { noRemoteImages } from "../../../core/ai/noRemoteImages";

/** 两版 hook 的公共形状（useAiWatch / useIntradayAiWatch） */
export interface AiPanelState {
  loading: boolean;
  summary: string;
  error: string | null;
  needConfig: boolean;
  intraday: boolean;
  run: () => void;
}

export function AiWatchPanel({ state, title = "AI 盯盘", pausedHint }: {
  state: AiPanelState;
  title?: string;
  /** 非交易时段显示什么；默认沿用实时动态那句 */
  pausedHint?: string;
}) {
  const { loading, summary, error, needConfig, intraday, run } = state;

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      {/* 头部 */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full",
            intraday ? "bg-primary/15" : "bg-muted/30"
          )}>
            <BrainCircuit className={cn("h-4 w-4", intraday ? "text-primary" : "text-muted-foreground")} />
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="ml-2 text-[11px] text-muted-foreground">
              {intraday ? "盘中自动 · 3 分钟更新" : "非交易时段"}
            </span>
          </div>
        </div>
        {intraday && (
          <button
            onClick={run}
            disabled={loading}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
              loading
                ? "cursor-not-allowed text-muted-foreground"
                : "hover:bg-primary/10 text-primary"
            )}
          >
            {loading
              ? <><Loader2 className="h-3 w-3 animate-spin" />分析中...</>
              : <><RefreshCw className="h-3 w-3" />刷新</>
            }
          </button>
        )}
      </div>

      {/* 状态提示 */}
      {needConfig && (
        <div className="mb-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
          <div className="flex items-center gap-2 text-sm text-warning">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>请先在「设置」中配置 AI 模型，才能使用 AI 盯盘功能。</span>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
          <div className="flex items-center gap-2 text-sm text-danger">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* 非盘中提示 */}
      {!intraday && !loading && !summary && !error && !needConfig && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span>{pausedHint ?? "当前非交易时段，AI 盯盘已暂停"}</span>
        </div>
      )}

      {/* 分析结果 */}
      {summary && (
        <div className="rounded-md border border-primary/20 bg-background/60 p-3">
            <div className="prose prose-sm max-w-none text-foreground">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  ...noRemoteImages,
                  h3: ({ children }) => <h3 className="mb-1 mt-2 text-[15px] font-bold text-foreground first:mt-0">{children}</h3>,
                  p: ({ children }) => <p className="mb-1.5 last:mb-0 text-sm leading-[1.1] text-foreground">{children}</p>,
                  ul: ({ children }) => <ul className="mb-1.5 list-disc pl-4 space-y-1 text-foreground">{children}</ul>,
                  ol: ({ children }) => <ol className="mb-1.5 list-decimal pl-4 space-y-1 text-foreground">{children}</ol>,
                  li: ({ children }) => <li className="text-sm leading-[1.1] text-foreground">{children}</li>,
                  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                }}
              >
              {summary}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">AI 正在分析当前盘面…</span>
        </div>
      )}
    </div>
  );
}
