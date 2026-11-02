/**
 * 失败记忆(短窗口负缓存):同一个端点刚失败过,别让下一次请求再白等一遍。
 *
 * 为什么需要:2026-11-02 实测某个上游数据源直接断连(`exit=3 status=failed`, `RemoteDisconnected`),
 * 它当然不该进快照缓存(没数据),
 * 可结果是**每打开一次页面就等它失败 6 秒**。「市场状态」一屏六个源并行,最慢那个决定整页 ——
 * 上游抖一下,页面就慢一截,而且每次刷新都重来一遍。
 *
 * 三条边界,缺一条就会帮倒忙:
 *   1. **只记真正的失败**(进程跑了但没拿到可用数据),不记我们自己的参数错、不记符号链接拒写。
 *   2. **刷新必须真取**。用户点「刷新」就是不信这份缓存,记忆必须让路。
 *   3. **窗口要短**。默认 60 秒:够挡住同一屏的反复重试与轮询,又不至于上游恢复后还一直报旧错。
 *      `VRA_FETCH_FAIL_TTL=0` 可整体关掉。
 */

/** 默认记住多久。够挡住一屏内的反复请求,又不至于让恢复延迟太久 */
export const DEFAULT_FAIL_TTL_MS = 60_000;

/**
 * 只记**慢**的失败(默认 2 秒以上)。
 *
 * 🔴 这条是被既有测试逼出来的:「取不到的那天,第二次还要再去取」是写在测试里的意图。
 * 无差别记忆会把「立即重试」这件事一并禁掉,而那并不全是坏事 —— **要省的只是白等**。
 * 失败得又快又便宜(参数错、信封坏、上游秒回 500),再取一次毫无代价,没必要拦;
 * 真正让人难受的是那种要等 6 秒才报错的,那才是这条记忆存在的理由。
 */
export const DEFAULT_SLOW_FAIL_MS = 2_000;

/** 多慢的失败才值得记。`VRA_FETCH_FAIL_MIN_MS` 可改(设 0 = 任何失败都记),非法值退回默认 */
export function slowFailMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.VRA_FETCH_FAIL_MIN_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_SLOW_FAIL_MS;
  return Number(raw);
}

export interface RecentFailure {
  /** 失败所属的错误码,原样还给调用方,便于上层按码分支 */
  code: string;
  /** 给用户看的原因(来自信封 errors / missing,不是我们编的) */
  message: string;
  /** 失败发生的时刻 */
  at: number;
}

export interface FailureRecall extends RecentFailure {
  /** 已经过去多久 */
  ageMs: number;
  /** 还剩多久解禁 */
  remainMs: number;
}

export function failTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.VRA_FETCH_FAIL_TTL ?? "").trim();
  if (!raw) return DEFAULT_FAIL_TTL_MS;
  if (!/^\d+$/.test(raw)) return DEFAULT_FAIL_TTL_MS;
  return Number(raw) * 1000;
}

export class FailureMemory {
  private readonly map = new Map<string, RecentFailure>();
  private readonly ttl: () => number;
  constructor(ttl: () => number = () => DEFAULT_FAIL_TTL_MS) { this.ttl = ttl; }

  /** 还在窗口内就返回记忆,过期的顺手清掉(不让 Map 无限长) */
  recall(key: string, now = Date.now()): FailureRecall | null {
    const f = this.map.get(key);
    if (!f) return null;
    const ttl = this.ttl();
    const ageMs = now - f.at;
    if (ttl <= 0 || ageMs >= ttl) { this.map.delete(key); return null; }
    return { ...f, ageMs, remainMs: ttl - ageMs };
  }

  remember(key: string, code: string, message: string, now = Date.now()): void {
    if (this.ttl() <= 0) return; // 关掉时不留任何记忆
    this.map.set(key, { code, message, at: now });
  }

  forget(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}

/**
 * 从一次取数结果里读失败原因。**只用端点自己给的字段**,读不到就说读不到,不编。
 * 信封结构见 `.agents/skills/data-access/scripts/common.py`。
 */
export function failureReasonOf(envelope: unknown): string {
  const env = envelope as { errors?: { error?: unknown; source?: unknown }[]; missing?: { reason?: unknown }[]; status?: unknown };
  const err = (env?.errors ?? []).map((e) => e?.error).find((x): x is string => typeof x === "string" && x.length > 0);
  if (err) return err;
  const miss = (env?.missing ?? []).map((m) => m?.reason).find((x): x is string => typeof x === "string" && x.length > 0);
  if (miss) return miss;
  return typeof env?.status === "string" ? `取数状态 ${env.status}` : "取数失败";
}

/** 快失败时给用户的话:说清「这次没重试」「多久后才会再试」「怎么立刻重试」 */
export function recentFailureMessage(label: string, r: FailureRecall): string {
  const sec = Math.max(1, Math.round(r.remainMs / 1000));
  const ago = Math.max(1, Math.round(r.ageMs / 1000));
  return `${label}取数失败(${ago} 秒前):${r.message}。${sec} 秒内不再重试,先按「没取到」处理;要立刻重试请点刷新。`;
}
