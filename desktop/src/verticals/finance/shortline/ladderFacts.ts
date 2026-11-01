/**
 * 昨日梯队的承接统计。
 *
 * 从 LiveTab 移出来是因为「超短线机会发现」的验证流也要数这一份：
 * 两处各写一遍的话,一边「上涨 1」、另一边「红盘率 50%」迟早对不上 —— 而对不上的数字比没有数字更害人。
 */
import type { LadderWatchRow } from "./watchTypes";
import { finite } from "./format";

/** 昨日涨停的票今天怎么样:只数行情时间是今天的;封住与否后端不说(午休、竞价、休市)时是 null,不当 0 */
export function ladderStats(rows: LadderWatchRow[]) {
  const today = rows.filter((r) => r.today && finite(r.pct) !== null);
  return {
    total: rows.length, sample: today.length,
    up: today.filter((r) => r.pct! > 0).length,
    down: today.filter((r) => r.pct! < 0).length,
    sealed: rows.some((r) => r.at_limit !== null) ? rows.filter((r) => r.at_limit === true).length : null,
  };
}
