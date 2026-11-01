/**
 * 金融产品任务入口的额外注册项。
 *
 * 六阶段 CLI 只需要 `register.ts` 的 Plugin；Deep 任务解析器会依赖服务层与 Codex Deep 适配器，
 * 因而只在真正提供统一任务 API 的 composition root 加载。把两者混在同一个副作用入口里，
 * 会让实验 Direct CLI 即使完全不走 Deep，也在模块加载时拉入 Codex SDK。
 */
import "./register.ts";

import { registerDeepTargetResolver } from "../deep_target_registry.ts";
import { FinanceDeepTargetResolver } from "./deep_target.ts";
import { registerSchedule } from "../notify.ts";
import { FINANCE_SCHEDULE } from "./schedule.ts";
import { registerView } from "../views.ts";
import { eventCalendar } from "./events.ts";
import { verdictReview } from "./verdicts.ts";
import { candidatePool } from "./candidates.ts";
import { abnormalWatch } from "./abnormal.ts";
import { reviewTiers } from "./review_tiers.ts";
import { earningsBrief } from "./earnings_brief.ts";
import { shareCard } from "./share_card.ts";
import { holdingsAct, holdingsPerf, holdingsView } from "./holdings_view.ts";
import { marketStateAct, marketStateViewAct } from "./market_state.ts";
import { marketCallViewAct } from "./market_call.ts";
import { tradePlansViewAct } from "./plans.ts";
import { shortlineOpportunitiesAct } from "./shortline/opportunities.ts";
import { opportunityTrackView } from "./shortline/opportunity_track.ts";
import { opportunityScanAct } from "./opportunity.ts";
import { dayOpportunityAct } from "./day_opportunity.ts";
import "./shortline/register.ts";
import "./journal/register.ts";

registerDeepTargetResolver((dataRoot) => new FinanceDeepTargetResolver(dataRoot));
// 定时提醒同样只在提供 API 的入口注册;真正开始按点运行的是 api.ts 的 main()
registerSchedule(FINANCE_SCHEDULE);
registerView({ id: "calendar", label: "事件日历", run: eventCalendar });
registerView({ id: "verdicts", label: "判据回看", run: verdictReview });
registerView({ id: "candidates", label: "候选池", run: candidatePool });
registerView({ id: "abnormal", label: "异动接近度", run: abnormalWatch });
registerView({ id: "review_tiers", label: "涨停分档", run: reviewTiers });
registerView({ id: "earnings_brief", label: "财报前瞻与复盘", run: earningsBrief });
registerView({ id: "share_card", label: "研究分享卡", run: shareCard });
registerView({ id: "holdings", label: "持仓", run: holdingsView, act: holdingsAct });
registerView({ id: "holdings_perf", label: "持仓收益率", run: holdingsPerf });
registerView({ id: "market_state", label: "市场状态信号", run: marketStateAct });
registerView({ id: "market_state_view", label: "市场状态视图", run: marketStateViewAct });
registerView({ id: "trade_plans", label: "交易计划", run: tradePlansViewAct });
registerView({ id: "shortline_opportunities", label: "超短线机会发现", run: shortlineOpportunitiesAct });
registerView({ id: "shortline_opportunity_track", label: "机会清单战绩", run: opportunityTrackView });
registerView({ id: "market_call", label: "大盘判断台账", run: marketCallViewAct });
registerView({ id: "opportunity_scan", label: "板块机会链（启动板块→龙头→规划）", run: opportunityScanAct });
registerView({ id: "day_opportunity", label: "当日机会发现（宽度优先：板块在动但还没成涨停潮）", run: dayOpportunityAct });
