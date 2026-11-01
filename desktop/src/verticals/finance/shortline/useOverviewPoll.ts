/**
 * 盯盘 · 市场实时概况的轮询。做法同 useWatchPoll:页面开着才取,切走就停,失败退避。
 * 概况以快照为主、变化不快,默认按后端回的 poll_ms(15 秒)刷新。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "@/lib/backend";
import { cleanReason } from "./api";
import type { OverviewView } from "./watchTypes";

const BASE_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const HIDDEN_HEARTBEAT_MS = 15_000;

export interface OverviewPoll {
  data: OverviewView | null;
  error: string | null;
  live: boolean;
  receivedAt: number | null;
  refresh: () => void;
}

export function nextDelay(okMs: number | null, failures: number): number {
  if (failures <= 0) return okMs && okMs > 0 ? okMs : BASE_MS;
  return Math.min(BASE_MS * 2 ** failures, MAX_BACKOFF_MS);
}

export function useOverviewPoll(): OverviewPoll {
  const [data, setData] = useState<OverviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const kick = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let ctl: AbortController | null = null;
    let failures = 0;
    let lastMs: number | null = null;
    let inFlight = false;
    const clear = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };

    const loop = async () => {
      if (cancelled || inFlight) return;
      clear();
      if (document.hidden) {
        setLive(false);
        timer = window.setTimeout(loop, HIDDEN_HEARTBEAT_MS);
        return;
      }
      setLive(true);
      inFlight = true;
      ctl = new AbortController();
      try {
        const v = await backend.shortlineOverviewPoll<OverviewView>(ctl.signal);
        if (cancelled) return;
        setData(v);
        setError(null);
        setReceivedAt(Date.now());
        failures = 0;
        lastMs = v.poll_ms;
      } catch (e) {
        if (cancelled) return;
        failures += 1;
        setError(cleanReason(e instanceof Error ? e.message : String(e)) || "原因不明");
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      timer = window.setTimeout(loop, nextDelay(lastMs, failures));
    };
    kick.current = () => { void loop(); };
    void loop();

    const onVisible = () => { if (!document.hidden && !cancelled) void loop(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clear();
      ctl?.abort();
      kick.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const refresh = useCallback(() => kick.current?.(), []);
  return { data, error, live, receivedAt, refresh };
}
