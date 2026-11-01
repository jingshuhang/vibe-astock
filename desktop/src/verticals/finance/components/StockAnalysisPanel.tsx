/**
 * 个股分析卡片 — 主力行为 + 技术面评分（本地规则引擎）
 *
 * 数据全部由 Vibe-AStock 自己的端点计算(tx_kline 日 K + 腾讯批量行情),不依赖任何外部服务。
 * 点「刷新」重取,不自动轮询(个股分析是按需触发的深度研判,不是实时行情)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert, Activity } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

export interface StockAnalysisResult {
  symbol: string;
  name: string;
  main_capital: {
    score: number;
    stage: string;
    confidence: string;
    advice: string;
    factors: string[];
  };
  technical: {
    score: number;
    trend_score: number;
    volume_score: number;
    position_score: number;
    factors: string[];
  };
  composite: number;
  /** 取不到 / 算不出的项,如实列出;不算成 0 */
  gaps?: string[];
  /** 数据够不够支撑评分;false 时弱化读数 */
  sufficient?: boolean;
}

function ScoreBar({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = Math.round((value / max) * 100);
  const color = pct >= 70 ? "text-danger" : pct >= 40 ? "text-warning" : "text-success";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-mono font-semibold", color)}>{value}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted/40">
        <div
          className={cn("h-full rounded-full transition-all",
            pct >= 70 ? "bg-danger" : pct >= 40 ? "bg-warning" : "bg-success"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StageBadge({ stage, confidence }: { stage: string; confidence: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    "吸筹": { cls: "bg-success/15 text-success border-success/30", label: "吸筹中" },
    "洗盘": { cls: "bg-warning/15 text-warning border-warning/30", label: "洗盘中" },
    "主升": { cls: "bg-danger/15 text-danger border-danger/30", label: "主升浪" },
    "出货": { cls: "bg-muted text-muted-foreground border-border", label: "出货中" },
  };
  const s = map[stage] ?? { cls: "bg-muted text-muted-foreground border-border", label: stage };
  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", s.cls)}>
      <Activity className="h-3 w-3" />
      <span className="font-medium">{s.label}</span>
      {confidence !== "高" && <span className="text-[10px] opacity-70">· 置信{confidence}</span>}
    </div>
  );
}

export function StockAnalysisPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<StockAnalysisResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    setError("");
    if (!refresh) setData(null);
    try {
      const r = await backend.stockAnalysis(symbol);
      if (my !== seq.current) return;
      setData(r);
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    void load(false);
    return () => { seq.current++; };
  }, [load]);

  if (!symbol) return null;

  return (
    <GlassCard className="mb-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4 text-primary" />
          个股分析（本地引擎）
        </h3>
        <button type="button" onClick={() => void load(true)} disabled={loading} className={BTN} title="重新取数">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 刷新
        </button>
      </div>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        主力行为阶段判定（规则引擎）+ 技术面三维评分。数据由 Vibe-AStock 引擎实时计算。
      </p>

      {error && <p role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
      {loading && !data && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>正在分析 {symbol}…</span>
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {data.sufficient === false && (
            <div className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2">
              <p className="text-[11px] font-medium text-warning">数据不足以给出可信评分,以下读数请谨慎看待</p>
              {data.gaps?.length ? (
                <ul className="mt-1 space-y-0.5">
                  {data.gaps.map((g, i) => (
                    <li key={i} className="text-[11px] leading-4 text-muted-foreground">• {g}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {/* 综合评分 + 主力阶段 */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border/50 px-3 py-2.5 space-y-2">
              <p className="text-[11px] text-muted-foreground">综合评分</p>
              <div className="flex items-baseline gap-2">
                <span className={cn(
                  "text-2xl font-bold font-mono",
                  data.composite >= 70 ? "text-danger" : data.composite >= 40 ? "text-warning" : "text-success"
                )}>
                  {data.composite}
                </span>
                <span className="text-xs text-muted-foreground">/ 100</span>
              </div>
              <div className="mt-2 space-y-2">
                <ScoreBar value={data.technical.trend_score} label="趋势" />
                <ScoreBar value={data.technical.volume_score} label="量能" />
                <ScoreBar value={data.technical.position_score} label="位置" />
              </div>
            </div>

            <div className="rounded-lg border border-border/50 px-3 py-2.5 space-y-2">
              <p className="text-[11px] text-muted-foreground">主力行为</p>
              <StageBadge stage={data.main_capital.stage} confidence={data.main_capital.confidence} />
              <p className="mt-2 text-xs leading-5 text-foreground">{data.main_capital.advice}</p>
              {data.main_capital.factors?.length > 0 && (
                <div className="mt-2 space-y-1">
                  {data.main_capital.factors.map((f, i) => (
                    <p key={i} className="text-[11px] leading-4 text-muted-foreground">• {f}</p>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 技术面因子 */}
          {data.technical.factors?.length > 0 && (
            <div className="rounded-lg border border-border/50 px-3 py-2.5">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">技术信号</p>
              <div className="space-y-1">
                {data.technical.factors.map((f, i) => (
                  <p key={i} className="text-xs leading-5 text-foreground">• {f}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </GlassCard>
  );
}
