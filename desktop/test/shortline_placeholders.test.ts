/**
 * 「短线机会」页：没数据要留白，不许显示成 0。
 *
 * 同一屏已经写着「实测 —」和「置信(未佐证)」，旁边却跟了
 * `(n={sample ?? 0})` 和 `置信(未佐证):{confidence ?? 0}` —— 「没统计过」
 * 被画成「样本 0 家 / 置信度 0」，读起来像真算过一遍、结果为零。
 * 与「涨跌分布占位 0」同类，只是在另一个页面。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../src/verticals/finance/pages/ShortlineOpportunities.tsx", import.meta.url), "utf8");

test("[结构] 样本数与置信度缺值时显示「—」，不是 0", () => {
  assert.match(src, /cell\?\.sample \?\? "—"/, "没样本要留白");
  assert.match(src, /o\.pattern\?\.confidence \?\? "—"/, "没佐证的置信度要留白");
  assert.doesNotMatch(src, /sample \?\? 0/, "不许退回样本 0");
  assert.doesNotMatch(src, /confidence \?\? 0/, "不许退回置信度 0");
});

test("[结构] 留白文案要与同屏的「实测 —」「未佐证」保持一致", () => {
  assert.ok(src.includes("实测 —"), "同一分支本来就用「—」表示没实测,别一处留白一处填 0");
  assert.ok(src.includes("置信(未佐证)"), "没佐证这件事要继续说清楚");
});
