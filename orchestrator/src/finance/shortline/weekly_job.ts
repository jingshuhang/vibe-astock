/**
 * 「AI 周报」(情绪复盘页 · AI 周报)的**定时触发器**。
 *
 * 周报本身不在这里写:`shortline/weekly_review.ts` 早就有整套(取资料包 → 四段各写一段 →
 * 程序核对数字和证据编号 → 存台账 `shortline_weekly_review`,每次一版)。这里只做三件事:
 *   ① 到了周五 19:10 才跑(用户没点按钮的那天);
 *   ② 这一周已经写过就不再写(同一周重跑会多出一版几乎一样的);
 *   ③ 等它写完再报结果 —— 定时任务说「完成了」,就必须真的落进台账了。
 *
 * 🔴 和周报页面上点「开始」写出来的是**同一张表、同一套核对**:不另存一份。
 * 🔴 没接 AI 是**配置状态**,不是失败:说一句就结束,不重试(重试三次也只是三句一样的话)。
 * 🔴 必须等它跑完(不是点完就报成功):写失败时台账里没有这一版,任务状态要说「没写成」。
 */
import type { JobContext, JobResult } from "../../notify.ts";
import { localClock } from "../../notify.ts";
import { ServiceError, ledgerList } from "../../service.ts";
import { SCHEDULE_TZ, weekdayOf } from "../schedule.ts";
import { cancelRun, reviewFinished, type TurnFn } from "./review.ts";
import { LEDGER_KIND, startWeeklyReview, weekStart } from "./weekly_review.ts";

/** 没接 AI 属于配置状态,不是今天的失败(与每日复盘那边同一份判据) */
const CONFIG_CODES = /^(?:ai_source_not_configured|agent_required|bad_llm|bad_template|provider_renamed|model_not_supported|no_model)$/;
/** 台账里「写的 AI」这一栏:定时任务写的要能一眼看出不是自己点出来的 */
const AI_LABEL = "定时任务";

export async function weeklyReviewJob(j: JobContext, deps: { turn?: TurnFn } = {}): Promise<JobResult> {
  const { day } = localClock(j.now, SCHEDULE_TZ);
  if (weekdayOf(j.now) !== 5) return { messages: [], note: "今天不是周五:AI 周报只在周五写" };

  const ws = weekStart(day);
  const existing = (ledgerList(j.ctx, LEDGER_KIND)[LEDGER_KIND] ?? []).filter((r) => r.week_start === ws);
  if (existing.length && !j.manual) {
    return { messages: [], note: `${ws} 起这一周已经有 ${existing.length} 版 AI 周报,今天不再写` };
  }

  let started;
  try {
    started = await startWeeklyReview(j.ctx, { date: day, ai: AI_LABEL }, j.signal, j.now, deps.turn);
  } catch (e) {
    if (e instanceof ServiceError && CONFIG_CODES.test(e.code)) return { messages: [], note: `没写:${e.message}` };
    throw e;
  }

  let run;
  try {
    run = await reviewFinished(started.id);
  } catch (e) {
    // 定时任务被掐掉(超时)时它自己不知道:停掉这次,否则下一拍重试会再起一份、写出两版
    try { cancelRun(started.id, LEDGER_KIND, "周报"); } catch { /* 已经结束了 */ }
    throw e;
  }

  // 成功与否只看「落没落进台账」:部分段失败但有正文存下来了(completed_with_errors)也算写成了,
  // 只是要在消息里说清哪几段没写成 —— 那是内容不完整,不是整篇没有
  const bad = run.stages.filter((s) => s.status === "failed");
  if (!run.saved_id) {
    const why = bad.map((s) => `${s.label}:${s.error ?? "没写完"}`).join(";") || run.save_error || run.gaps[0] || run.outcome;
    throw new Error(`AI 周报没写成:${String(why).slice(0, 200)}`);
  }

  const done = run.stages.filter((s) => s.status === "done");
  const skipped = run.stages.filter((s) => s.status === "skipped");
  const chars = done.reduce((n, s) => n + (s.text?.length ?? 0), 0);
  return {
    messages: [{
      title: `AI 周报 ${ws} 这一周已写完并存档`,
      lines: [
        `写到 ${run.date};${done.length} 段写成了${skipped.length ? `,${skipped.length} 段跳过(${skipped.map((s) => s.label).join("、")})` : ""}${bad.length ? `,${bad.length} 段没写成(${bad.map((s) => s.label).join("、")})` : ""},合计 ${chars} 字`,
        run.gaps.length ? `资料包有 ${run.gaps.length} 处缺口,周报里按缺口写了(不代表市场没有)` : "资料包没有缺口",
        "正文与数字核对结果都在台账里(情绪复盘 · AI 周报),每一版都留着",
      ],
      link: "/shortline/weekreview",
      dedupeKey: `weekly_ai:${ws}`,
    }],
    note: `${ws} 起这一周的 AI 周报已存档`,
  };
}
