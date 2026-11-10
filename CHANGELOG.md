# CHANGELOG

格式遵循 Keep a Changelog，并采用语义化版本。v1.1.3 及更早的条目保留旧版原文。
底座（Vibe Research）此前的变化见 [Vibe Research 的 CHANGELOG](https://github.com/simonlin1212/Vibe-Research/blob/main/CHANGELOG.md)。

## [未发布]

三件事：收盘后的三个 AI 任务改成用**你在「接入 AI」里保存的那份配置**（此前它们读的是另一个地方，界面上看不出来）、盘中异动改成**后台常驻采集**（页面关着也照采），以及修 Windows 上取数字段的中文**整段变替换符**。

### 新增

- **逆市改判叠加层：环境关闭时，落在正期望格子的票不再一律挂「回避」**（2026-11-10，用户拍板「改」；承接下面「逆市候选」条的留白①）。
  - **改了什么**：上一轮只做并列第二视图 —— 顶部写「环境关闭，不加」、清单 40 只全回避，逆市候选栏却有 5 只带正期望证据，同一只票上下两套说法。本轮把它接成**展示层叠加**：落在过线格子的票从「回避」改判「逆市观察（闸门外）」，其余不动；顶部闸门结论（`head / note / tone / gates / phase`）原样保留。`verifyOpportunities()` 的判据本体与「环境反对时全部回避」的既有回归测试**一字未动** —— `mergeCounterTrendCalls()` 刻意放在它之外，只重算 `tagged` / `counts`，不回写原对象。
  - **收口时抓到并修掉的三处口子 / 读反**：
    ① **真口子：叠加层原本不分环境开闭**。`buildCounterTrend()` 只要样本和清单在就产出 rows，初版 `mergeCounterTrendCalls()` 也没有闸门判据，导致闸门**开着**时，一只因「模式历史均值为负」被判回避的票也会被贴上「逆市观察（闸门外）」，而闸门根本没关。修法：`VerifyFlow` 新增 `gateClosed`（从同一个 `closed` 局部变量带出，不另算一套），叠加层 `if (!v.gateClosed) return v`。市场状态没取到（`mkt=null`）同样不介入、不猜；盘中判断条报警（`tone === "danger"`，如「退潮中，不加」）但闸门没关也不介入 —— **不靠 tone / head 字符串反推闸门**。
    ② **过期文案**：`CounterTrendCard` 顶部仍写「环境关闭时下面清单照旧全部回避」，与已上线的改判直接打架。改成按 `rejudged` 只数分两态显示，并加 `doesNotMatch` 结构断言钉住不许回来。
    ③ **第四次踩「自写注释触发自写断言」**：新写的文件头注释复述了那句旧文案，被自己刚加的护栏判成回归；改成描述性措辞。判据一律避开在注释里复刻旧字面量。
  - **实机两态回灌**（2026-11-10，取运行中服务的 `/view/market_state_view`、`/view/shortline_opportunities`、`/view/shortline_samples?date=2026-11-10&days=90`）：93 只涨停 / 45 只候选（31 首板 + 9 连板 + 5 高标），样本已滚到 **25 个交易日** 9/30–11/10、切点 175.8/267.1。
    - **闸门关闭**（用户 14:12 截图那一刻的实机读数 `cap:20 / can_open_position:false / composite:75 / 修复期`）：`verify` = 45 回避 → `merged` = **5 观察 / 40 回避**；改判 002578（7 板）/ 002310 / 600327 / 601188 / 603366（均 3 板），格子 `情绪中·高标接力` n=32 / 71.9% / +4.32% / 最差 −10.02%；`首板打板 47.2%`、`连板接力 53.3%` 因胜率 <55% 被挡并写明原因。逐股理由带「闸门外 / 不是放行也不是建议」，顶部仍是「环境关闭，不加」。
    - **闸门开启**（当前实机 `cap:40 / can_open_position:true / composite:71`）：`gateClosed=false`，`merge` **严格返回同一对象**，counts 不变。
    - ⚠️ 探针刻意不接盘中两路（`intra/watch=null`），闸门开时那 45 个「观察」只是探针档位，**不代表线上完整裁决**；本对照验证的只是「叠加层介不介入」与「关闭时改判几只」。闸门开启那档另有 `gate.all_pass:false`、`gate_unknown:["量能(没有 20 日均额或今日成交额)"]`、`incomplete_legs:["板块共振"]` —— cap 40 含数据缺腿压仓成分，不是三道门全过。
  - **测试**：`shortline_opportunities.test.ts` 新增 8 条（改判作用域 / 闸门结论不动 / 理由文案带真实数字 / 各种原样返回 / **闸门开不介入** / **tone=danger 但闸门没关不介入** / **闸门没取到不猜** / 只改回避不覆盖已判支持），`counter_trend.test.ts` 结构断言补 4 条（`gateClosed: closed`、`!v.gateClosed`、`rejudged={ctRejudged}`、过期文案不许回来）并修正一条已过期的测试标题。定向 **26/26**、两端 `tsc --noEmit` 0 错、desktop 全量 **491/491**（上轮 483，本轮 +8）、`npm run test:delta` 基线 45 → 本次 41 / **无新增失败** / 退出码 0。
  - **诚实留白**：① 仍是**展示层**改判 —— 没动 `positionCapOf()` / 40% 门槛 / 置信度表 / 任何策略判据；「逆市观察」不是「支持」，更不是买入建议。用户拍板的是**产品口径**（给区分度），不是策略判据变更，**回测三关仍未做**。② 这一栏用的仍是**市场现象统计**，不是按闸门关闭日分组的可信样本（台账仅 2 天可配对），不能证明「闸门关了照样赚钱」；`regimeOf(phase)` 映射未回测。③ `patternPrior.ts` 冻结 18 日表与实机 25 日表分叉仍在，滚动更新属 P1。④ 收盘快照 + 次日对账闭环已存在但台账仍空，这 5 只改判票的真实次日表现要等积累。⑤ **没有重启用户自己启动的 API 服务**，前端改动需 Vite 热更新 / 刷新才可见；没 push。
- **逆市候选：环境关闭时的第二视图**（2026-11-10 14:42，用户要「哪怕环境关闭，也能逆市吃溢价的短线机会」）。
  - **取证先行**（`/view/shortline_samples?date=2026-11-10&days=90`，24 个交易日 9/30–11/9）：`情绪中·高标接力` n=37 / 胜率 **67.6%** / 均值 **+3.74%** / 中位 +9.98% / 最差 −10.02% / 再板率 54.1%；`情绪弱·首板早封` n=67 / 65.7% / +3.11%；`情绪中·首板打板` n=301 / 44.5% / +0.33% / 中位 −1.19%。10-30 研究设计稿的「发现 A：情绪中是最差环境，不是情绪弱」在更大样本上仍成立 —— 一刀切把正期望格子也盖掉了，是**信息损失**而非风控必需。
  - **但三个硬边界不绕过**：① 「环境关闭」是量能 / MA20 闸门，与「情绪分档」不是同一维度；`.local/ledger/market_call.json` 只有 7 天，能配对的偏空入场日仅 **2 天**，没有按闸门关闭日分组的可信统计。② 数字是**市场现象统计**：样本为前一天收盘还封住的票，含一字板买不进、没排除排队买不到，收益前收→今收等权、无成交模拟 / 滑点，原文 caveat 写明「不能推出真实收益或打法期望」。③ `patternPrior.ts` 是 10-30 的 18 日冻结快照（截图里 `n=24` 就是它），实机已滚到 24 日、切点 175.8/221.8 → 170/267.1 —— 页面用的置信度数字已过时。
  - **实现口径（并列，不放宽风控）**：验证流顶部仍写「环境关闭，不加」，`counts.回避` 与 `tone === "danger"` 一刀切**一字未动**，清单里每只票照旧挂「回避」。新增 `counterTrend.ts` 纯函数 + `CounterTrendCard`，单独取**实机** `shortline_samples`（不读冻结 PRIOR），按 `boards` 固定映射 `首板打板 / 连板接力 / 高标接力`（与 samples 的 `prev_boards` 对齐），查 `by_regime[regime]`。严格门槛 **n≥30 且历史均值 >0 且胜率 ≥55%** 才进排序；被挡的格子逐条写明原因，样本不足标「待验证」，样本没取到标 `failed` + 留白（「不等于今天没有逆市机会」）。**刻意不用首封时间分档**：`seal_time` 是首封，samples 的「早封」是最后封板时间，混用会系统性高估。每条并列胜率 / 均值 / 中位 / **最差一只** / 样本数 / 再板率；`sample_caveat`、`regime_note`（映射未回测、两维度不同）、`disclaimer`（不是买卖建议、闸门仍以验证流为准）随结果一起返回并带进 AI 上下文。
  - **修掉一处相位口径坑**：机会页 `ShortlineOpportunityResult.phase` 是后端按封板率派生的「强势 / 温和 / 分歧 / 震荡」，与 `MarketPhase`（修复期 / 退潮期 / …）不是一套标签；拿它查 regime 会全部落到「环境未覆盖」。`VerifyFlow` 现在带出 `phase`（与验证流同源的 `mkt.signal.phase`），页面用它，并加结构断言钉住不许改回去。
  - **实机回灌（15:04）**：93 只涨停 / 45 只候选，`修复期 → 情绪中`，只有「高标接力」过线 → **5 只**逆市候选（002578 闽发铝业 7 板、002310 东方新能、600327 大东方、601188 龙江交通、603366 日出东方，均 3 板），共用格子 n=37 / 67.6% / +3.74%；「首板打板 44.5%」「连板接力 51.2%」被挡并写明原因。⚠️ 这是**格子**的历史统计，不是这 5 只票的预测，也不是买卖建议。
  - **测试**：新增 `counter_trend.test.ts` 10 条（严格门槛 / 换环境结论随数据变 / 排序 / 首封时间不参与分档 / 小样本待验证 / 取数失败留白 / 口径说明随结果带出 / AI 摘要同源 / 常量与安全映射 / 不许推翻一刀切），`shortline_opportunities.test.ts` 补 1 条相位同源。定向 26/26、两端 `tsc --noEmit` 0 错、desktop 全量 **483/483**、文档一致性 20/20、`npm run test:delta` 基线 45 → 本次 41 / **无新增失败** / 退出码 0。
  - **诚实留白**：① 仍**不给**「明天哪只会溢价」的推荐，也不给买卖建议；要真放行闸门、把部分票改判「支持/观察」属策略判据变更，需回测与实机验证后单独拍板。② 没有按闸门关闭日分组的可信样本（2 天），这一栏**不能**证明「闸门关了照样能赚钱」。③ `patternPrior.ts` 冻结 18 日表仍在给验证流供数，与这一栏的实机 24 日表**分叉**，已在页面与文档写明，滚动更新属 P1。④ 收盘快照 + 次日 `cn_shortline_settled` 对账闭环已存在但台账仍空，影子样本要等清单非空后积累。⑤ 没重启用户自己启动的 API 服务、没 push。
  - **顺带修一处假阳性护栏**：`orchestrator/test/readme_numbers.test.ts` 的 `/可用 \d+ 个|默认停用/` 把新写的「当前可用 24 个交易日」误判成旧的停用端点说明。收紧成 `/可用 \d+ 个端点|默认停用/`，并补 1 条测试证明「可用 N 个端点 / 默认停用」仍抓得住、「可用 N 个交易日 / 可用 N 个格子」不再误伤。修的是正则过宽，不是放宽护栏。

### 修复

- **「整页 40 只全写着回避」里的那句「仓位上限 0%」是编的，实际是 20%**（2026-11-10 14:12，来自用户截图）。
  - 先分清两层：**全回避本身是对的，不是 bug**。实机 `/view/market_state_view` 为 `composite:75 / phase:修复期 / gate_blockers:["量能 -9.6% vs 20 日均额,需 ≥+10%","上证 3667.48 ≤ MA20 3679.81"] / position_cap_pct:20 / can_open_position:false`，且 `gate_unknown / incomplete_legs / stale_dimensions` 全空 —— 数据齐，不是「算不出来被当 0」。`market_state.ts:497` 的 `canOpenPosition = positionCapPct >= 40 && riskLevel !== "extreme"`，20 < 40 所以不给开新仓，两个字段自洽。`opportunityVerify.ts:97` 的 `closed = cap === 0 || can_open_position === false` 因此为真，按 `:175`「环境明确反对时，模式再漂亮也是接盘」把 40 只全部判回避 —— 这正是 `docs/超短线机会发现思路_研究设计_2026-10-30.md:137`「环境不对，模式再漂亮也不做」与既有测试「清单一只不留地全部回避」的预期。
  - 截图里「证据:历史胜率 66.7%、均值 +3.3%、比大盘高 28.3pp」是 `prior.evidence`，即**这个模式在历史上、这个情绪环境下的统计**，跟今天能不能开仓不是一层；页面把两层上下并排，只用「证据 / 佐证」区分，从清单中段看很容易读成「证据这么好凭什么回避」。这属于可读性欠账，见下方留白。
  - **真 bug**：`:176` 把 `closed`（两个成因的或）当成等价于 `cap === 0`，逐股一律写死「仓位上限 0%，环境不给开仓」。同一页 `gate.read`（`:104`）用真实 cap 写「仓位上限 20%」，`note`（`:158`）走的是 `cap === 0 ? … : "信号判了不能开新仓"` —— 三处口径打架。漏测原因：`desktop/test/shortline_opportunities.test.ts` 的 `MKT_CLOSED` fixture 默认 `position_cap_pct: 0`，只覆盖「上限真压到 0」这一支，从没覆盖「上限 20% 但信号不给开新仓」。
  - 修法：**不动任何判据**。抽 `closedWhy` 与顶部 `note` 共用同一个成因判据，按真实 cap 三态分流（0 / 有值 / 没取到），逐股 `why` 复用它；今天会显示「仓位上限 20%，信号判不能开新仓」。新增 1 条行为测试，用 20% + `can_open_position:false` 复现，断言每只票的 `why` 不许出现 0%、必须出现 20%、且与顶部佐证读数同口径。
  - 验证：desktop 定向 **7/7**、`tsc --noEmit` 0 错、全量 **472/472**（本轮 +1 条）。
  - **留白（待拍板，本轮没动）**：① 清单顶部没有一句「本轮 40 只全回避，原因是环境关闭，与个股历史先验无关」，而逐股重复 40 次同一句全局原因，信息量为零；② 「证据」建议改叫「历史先验（不是今天判断）」；③ 要不要在 `can_open_position:false` 时仍给「观察」而非「回避」、或放宽 40% 门槛，属策略判据变更，需回测与实机验证，不能顺手改。**没有重启用户自己启动的 API 服务**，也没 push。
- **超短线机会发现「一直没有标的」：整条取数链死了却不报错**（2026-11-10 盘中实机取证；P0 只修数据链，不改判据、不改产品口径）。
  - 现象：`GET /view/shortline_opportunities` 恒返回 HTTP 200 + `limit_up_count:0 / opportunities:[] / seal_rate:null / broken_rate:null / notes:[] / phase:"震荡"`，页面据此写「今天没有匹配到模式的机会」。同一时刻 `POST /fetch em_zt_pool date=20261110` 实取 53 只涨停股 / 425 条 evidence —— **上游有数据，下游把取数故障伪装成合法空结果**。连带 18:45 的 `opportunity_track` 快照因空清单不落盘，「本页战绩」也永远为空。
  - 五处断链（逐份核过 mapper 的真实信封）：① `em_zt_pool` 的 `date` 传 `YYYY-MM-DD`，端点只认 `YYYYMMDD`（带横线实测 exit 3 / failed）；② 涨停池按自造字段名 `code / name / limit_up_time / tags / sector` 解析，实际是 `pool_limit_days / pool_amount / pool_turnover / …` 且 `record_key` 才是代码、名称行业首封时间写在 `note` 里 → `ztRows` 恒空；③ 只判 `Promise.allSettled` 的 fulfilled，不判 `envelope.status === "failed"` → 失败信封被吞、notes 恒空；④ `em_limit_up_sentiment` 给的是三池计数，代码却读 `seal_rate / broken_rate / limit_up` → 恒 null、phase 恒「震荡」；⑤ ladder / firstboard 的 `extra.result` 是**含 `stocks` 的对象**被当数组读，且 `boards` 从未赋值 → 五种模式有四种不可达。
  - 修法：`opportunities.ts` 按真实契约重写为「五路并行取数 + 纯函数组装」，新增 `OpportunityStatus`（`ok / partial / failed`）、`gaps`（本轮缺口）、`notes`（同源兼容别名，供台账快照与老前端读）、`envelopeUsable()` / `opportunityDayArgs()` / `parseZtPool()` / `parseLadder()` / `parseFirstboard()` / `parseRates()` / `assembleOpportunities()`。封板率主源 `cn_shortline_daily.broken_rate`、备源三池计数，**两路都没有就留白不写 0**；`allSettled` 的 rejected 原因也写进缺口。**`classifyPattern()` 的判据与 confidence 数值一字未动**，`ShortlineOpportunities.tsx` 副标题仍是「只列客观模式和条件，不给买卖建议」。
  - 前端：`shortlineOpportunities.ts` 新增 `emptyOpportunityHint()` 真区分「这一轮涨停池没取到」/「有数据缺口」/「真的没匹配到」；页面把 `gaps + notes` 合并去重后带进 AI 上下文与降级提示，`failed` 时概览标「没取到，不是 0 家」。老后端没有 `status` 时用 `notes` 兜底，不把有降级提示的一轮当成 `ok`。
  - **修复前后同日同源对照**（2026-11-10 11:59，都是真实端点信封）：用户自己启动的旧进程 `GET /view/shortline_opportunities?refresh=1` → `limit_up_count:0 / opportunities:0 / status:null / notes:[]`；新 `assembleOpportunities()` 喂同一批五路信封 → `status:"partial" / limit_up_count:51 / seal_rate:0.708 / broken_rate:0.292 / opportunities:41 / main_sectors:["汽车零部","通用设备"] / gaps:["每日情绪读数还没收盘定稿(partial)，封板率是盘中值"]`。字段覆盖 41/41 有首封时间、行业、模式，32/41 有涨停原因（另 9 只是连板股，首板名单本就无归因 —— 核对过不是新断链）；模式分布 首板爆发 32 / N字反包 9。⚠️ 数字是**盘中读数**，不是收盘定稿，也不是任何次日溢价预测。
  - 测试：`orchestrator/test/shortline_opportunity_contract.test.ts` 18 条，用 11-10 实机信封形状做 fixture，含「旧版假字段名解析不出有效行」「`extra.result` 当数组」「`failed` 信封被吞」「封板率三态」「失败 ≠ 今天没有机会」等回归护栏；`desktop/test/shortline_opportunity_status.test.ts` 8 条（3 条真跑 `emptyOpportunityHint()`，5 条结构断言钉住页面接线与后端不许退回旧写法）；`opportunity_track.test.ts` fixture 同步补 `status / gaps`。
  - **本轮验证**：两端 `tsc --noEmit` 0 错；orchestrator 契约 18/18、关联定向 25/25；desktop 定向 8/8、全量 **471/471**；`npm run test:delta` 基线 **45** / 本次 **42** / **无新增失败** / 退出码 0（2 条并行红单跑绿的负载偶发只报告不登记，1 条 `service_api_mcp` 的「已修复」按 11-08 裁决**不收编**）。
  - **诚实留白**：① **没重启用户自己启动的 API 服务（PID 16420）**，新代码尚未在运行中的进程生效，页面要等用户自行重启或明确授权后才看得到那 41 只；上面的「修复后」证据是本地纯函数回灌实机信封，不是线上页面截图。② 本轮**没有**实现「第二天 / 短期溢价预测」：置信度仍是硬编码 65/50/70/75/68/60，`patternPrior.ts` 是 10-30 的 18 天冻结先验（当前样本已 24 天、regime 切点已漂），动态先验 / 滚动样本 / 影子模式属 P1，是否改「推荐」口径属 P2，都等 P0 实机复验后单独拍板。③ 盘中 `cn_shortline_daily` 是 `partial`，封板率为盘中值、已在 `gaps` 写明，别当收盘定稿引用。④ 又一次踩「自写注释触发自写断言」：文件头注释里精确复述了旧字段名 `field === "code"`，被护栏 `doesNotMatch` 判成回归；已改成描述性措辞，这是第三次，判据一律避开在注释里复刻旧字面量。
- **「全部动手」轮：把上一条盘点的 P0 / P1 / flaky 全收，外加两处口径读反**（2026-11-08 第三轮）。
  - **① 机会发现页喂给 AI 的上下文把「不知道」写成「不可开新仓」**。`can_open_position` 是三态，`null` = 算不出来、不设仓位上限；旧上下文用两态模板把 `null` 压成一条禁止性结论。更要紧的是 `gaps / notes / staleNote` 定义在 `useAiPage` **之后**：界面显示「N 项缺口 / 降级提示」，模型却读到一份没有缺口的「完整」判断。修法：四个变量上移，三态抽成共享纯函数 `canOpenLabel()`（`true` / `false` / `null|undefined` 三档），上下文补 `mkt` 这一路失败的告警 + `errors / gaps / notes / staleNote`，删掉渲染区重复定义。新增 `opportunity_ai_context.test.ts` 4 条（1 条真跑纯函数、3 条结构断言）。
  - **② 盯盘内嵌市场状态把 `partial` 吞成 `ok`**。`deriveOverviewMarketState()` 的 `status` 原本只由 `signal.unavailable` 决定，`breadth / resonance / boardFlow` 缺腿或只取到部分分档时照样报 `ok`。修法：收集三路缺口 → `gaps.length ? "partial" : "ok"`，`note` 一路带到 `MarketStateOverviewPanel` 可见。`overview_breadth.test.ts` 补断言钉住 `partial` 与「别当成一家都没有」。
  - **③ 短线机会页最后一处占位 0**：`(n=sample ?? 0)` 与「置信(未佐证):0」把「没统计过」显示成 0 家 / 0 分，改 `?? "—"`；新增 `shortline_placeholders.test.ts` 2 条。
  - **④ `useMarketAutoRefresh` 零测试**：两个判断抽成零依赖纯函数 `marketRefreshPolicy.ts` 的 `shouldTickOnInterval()` / `shouldRefreshOnVisible()`，hook 改为调用它们；新增 `market_auto_refresh.test.ts` 5 条，真跑「正好到期用 `>=`」「后台半小时回来必须补」「隐藏 / 休市不补」，并结构断言 hook 接线与四页挂载。**没有 DOM / React 测试环境，hook 本体仍是结构断言**，这条留白写明。
  - **⑤ `test-causes.mjs` 零测试**：新增 `test_causes.test.ts` 5 条，真跑 `classify()` / `isEnv()` / `CAUSE_NOTES`，守住「宁可归 `code` 待查，也别把真回归标成 `env` 蒙混过去」的方向。
  - **⑥ flaky 归类死结**：`--flaky` 能加 `flaky:true` 却没有撤销路径，而 `--update-baseline` 又按 `prevFlaky` 继承、把错误标记焊死。新增 `--unflaky`（须带 `--reason`、精确匹配 1 条），把 `flaky-load` 改回 `code-or-unclear`、重写自相矛盾的自动文案、写 `reviewedAt / reviewNote / lastReviewedAt`，**不动 `generatedAt`**（局部复核不伪装成重新生成整份基线）。用它纠正 2026-11-07 复核发现「单跑仍红」的 `service_api_mcp.test.ts :: 断开 /debate …`：`flakyCount 5→4`、`byCause` 同步重算、`count` 仍 45。`test_delta_guard.test.ts` 扩到 10 条，含「缺 reason / 无命中 / 模糊匹配都拒绝且基线不变」「`prevFlaky` 只认 `e.flaky`，否则纠正会被重建洗回去」。
  - **⑦ `test:baseline` 与 `--force` 的契约摩擦**：决定**不改** `package.json`，保持不带 `--force` 的安全默认；README 写明要用 `npm run test:baseline --prefix orchestrator -- --force` 透传，并断言「别把 `--force` 写死进 npm script」。
  - **⑧ 两处口径读反（本轮追加，静态即可确证，不需要等实机）**。后端 `sources` 是六路**预期**来源常量，页面和 AI 上下文却写成「数据来源」——某路失败、走缓存或由备源顶上时它照样列全六路；`data_as_of` 装的是 `fetched_at` 截出的**取数日期**，字段名与注释却叫「数据日期」，而 `MarketState.tsx` 自己那句注释早写明「`stale_dimensions` 是按取数时间算的，会把每晚都正常滞后的一期标成灰」。修法：**不动任何判据**（分数、闸门、仓位、`staleness()` 比较逻辑一字未改），常量改名 `DECLARED_SOURCES`、字段注释当场说破、AI 上下文两处改「预期取数来源(设计清单,不代表本次全部取到)」、页面标题改「预期取数来源」并加可见说明、「各来源数据日期」改「各来源取数日期（不是数据归属日）」。`market_state.test.ts` 加 2 条行为测试（其中一条明确标注**是记录现状、不是认可现状正确**），`market_state_labels.test.ts` 加 1 条口径断言。README 新增同名小节。
  - **全量门禁里冒出的一处矛盾，单独取证后决定不改状态**：`test:delta` 把刚撤销 flaky 的 `service_api_mcp.test.ts :: 断开 /debate …` 报成「✅ 已修复 1 条」，而 11-07 的人工复核记的是「单跑仍红」；今天单独重跑该文件得到 `ok 8`（同文件另有 5 条失败：3 条 symlink `EPERM`、1 条 AI 未连接、1 条假 Claude 未启动，均不涉及它）。**一次通过既不足以推翻一次红，也不足以恢复免检**：维持 `flaky:false / code-or-unclear` 挂在待查，基线里 11-07 那条复核记录按「带日期的历史」原样保留，不改写、更不手改生成物。⚠️ 后续若照报告提示跑 `--update-baseline`，这条本轮通过且 `flaky:false` 的条目会被自动移除 —— 先按 11-09 实机取证确认它是否真的稳定，再决定是否收编。报告的「已修复」是自动判定，不等于人工结论。
  - **本轮验证**：前后端 `tsc --noEmit` 均 0 错；orchestrator 定向 6 文件 **80/80**（含 `core_purity` / `ttl_declarations`）、`readme_numbers + test_delta_guard` **14/14**；desktop 定向 4 文件 **17/17**、全量 **463/463**；`npm run test:delta` 基线 **45** / 本次 **43** / **无新增失败** / 退出码 0（另有 3 条并行红、单跑绿的负载偶发只报告不登记）。本轮**没有**用 `--update-baseline` 掩盖任何失败；`known-failures.json` 的唯一改动是 `--unflaky` 的留痕纠正。
  - **desktop 全量的跑法要说明**：88 个文件一次性并发的 `npm test --prefix desktop` 在本机沙箱**挂起 15 分钟不动**，进程停在既有的 `remote_access.test.ts`（它起本地 HTTP server；同轮沙箱还拦过 `reg.exe`）。单独跑该文件 **4.1 秒 / 6/6**，排除它后其余 87 文件 **54 秒 / 457/457** → 判定为**本机沙箱并发环境性**，不是代码缺陷，因此没改测试脚本、没动那条测试。463 = 457 + 6，比原先 451 条多出的 12 条正是本轮新增测试。这条留白记在这里，免得下次又干等 15 分钟。
  - **诚实留白**：① 真实数据归属日要逐路解析 envelope 的 `as_of` / `record_key`，属行为变更，等 2026-11-09 周一盘中实机取证后再动判据，本轮只把口径写清；② 没重启用户自己启动的 API 服务，没做浏览器视觉复查，11-08 周日休市没有盘中实机；③ 下个交易日的 3 个实机探针仍欠着；④ 缺腿压仓分档仍等样本；⑤ `DailyReview` 自动刷新、`release_version` tag 校验、启动 P2 两条维持已裁决不改。
- **先纠正一次自己的误判：`cache_max_age_sec` 一直生效，不是「静默失效」**（2026-11-08 全项目盘点）。
  - 上一轮 P2 写「逐端点 TTL 覆盖率 18/182」，本轮盘点一度进一步判成「registry 的 54 个声明没有任何代码读取、以为设了时效实际静默失效」—— **错的**。`service.ts` 一直把 `ep.cache_max_age_sec * 1000` 作为 `endpointMaxAgeMs` 传给 `snapshotUsable`，后者与调用方 `consistency.max_age_ms` 取 `Math.min`，注册表是**调用方放宽不了的硬上限**。那次只 grep 了 `finance/`，没扫全仓就下结论。
  - 真问题是**两套声明分叉**：`finance/snapshot_ttl.ts` 的 18 项（视图调用方意图）与注册表 54 项（硬上限）重叠 11 项、8 项数值不同（`cn_shortline_live` 30s/15s、`tx_quotes_batch` 20s/300s、`em_market_breadth` 60s/120s…），且 `registry.ts` 字段注释还写着「缺省 = 不限」—— 那是 Core 加 2 分钟兜底之前的口径。
  - 修法：**不动任何运行时数值**。把两张表并成一张会改变真实取数频率（可能把 15s 放宽到 30s，也可能把 300s 收紧到 20s 打爆上游），属于需要盘中实机验证的行为变更，不能顺手做。改 `registry.ts` / `snapshot_ttl.ts` 注释写清优先级与分叉清单，README 新增「快照时效」一节；新增 `ttl_declarations.test.ts` 5 条，用真 `snapshotUsable` 钉住 `min` 语义、`0 = 从不缓存`、表外端点落 2 分钟兜底、TS 表 18 个 id 都对应真实端点（拼错会静默落兜底），以及 `service.ts` 的接线不许被删。
  - 本文件 11-06 事故条目里那句「这道保险其实从未生效」指的是**事故当时端点表还没建**，不是说代码不读注册表；保留原文，在这里更正读法。
- **涨跌分布一家都没取到时，页面把六个计数画成「涨停 0 / 上涨 0」**（同一轮盘点，全项目最后一处占位 0 漏网）。
  - `breadthFrom()` 已经会返回 `null` 来区分「没取到」和「真的 0 家」，但 `overview.ts:extractBreadth()` 用 `?? 0` 把六个计数填满 → `extract()` 拿到非 null 的 data、块状态报 `ok` → 前端 `BreadthBody` 用 `String(d.limit_up)` 显示。同一屏短线情绪是实时读数，看着像全市场冰点。**不报错，只给错答案。**
  - 评分侧原本没被带偏：`breadthUsable()` 检查家数总和 > 0，全 0 会走「算不出来」。但显示层仍是假的，且 `partial` 缺档时那几个 0 也没有说明。
  - 修法：`extractBreadth()` 返回 `BreadthSummary | null`；`extract()` 把全空标成 `empty` 并写明「不是 0 家」，`partial` 补一句「没取到的分档显示为 0，别当成一家都没有」，note 透传到前端；`BreadthBody` 再加一道前端守卫（六个计数全 0 时不画读数，兼容旧后端 / 旧缓存）。新增 `overview_breadth.test.ts` 4 条，真跑 `shortlineOverviewAct`（注入假取数、不联网）覆盖全空 / 有数据 / 部分数据三态 + 前后端结构断言。
- **风险等级徽标与五维「抗跌度」方向相反，并排时没说明**（同一轮盘点）。
  - `riskLevelOf()` 与 `risk_score` 同源，但徽标「低风险 / … / 极高风险」和「抗跌度 0–100 越高越安全」是两套坐标系：「抗跌度 15 + 极高风险」是一致的，反倒「低风险 + 抗跌度低」才该怀疑数据。最容易读反的是把「低风险」当成「抗跌度低」。
  - 修法：只补说明、不动判据 —— `lib/marketState.ts` 导出单一真源 `RISK_LEVEL_HINT`，徽标加 `title`、下方加可见一行，独立页与盯盘内嵌版共用；四档 label / 配色 / 判定条件一字未改。`market_state_labels.test.ts` 补 1 条（5/5）。
- **增量门禁两处能把真回归「洗」进基线的口子**（同一轮盘点；2026-11-07 只记录、未改）。
  - `--update-baseline` 用当前所有失败覆盖基线、无二次确认；`--flaky "文件::用例名"` 匹配不到时凭空新增 `flaky:true`，既不验证文件存在也不跑测试。报告里「可标 flaky」的提示配后者，是把一条真实回归变成永久免检项的最短路径。
  - 修法：重建基线前算 `newcomers`（不在旧基线的本轮失败），非空且无 `--force` 就退出 1 并逐条打印；`--force` 时输出「本次收编 N 条」。`--flaky` 新增必须显式 `--allow-new`，且校验 `test/` 下真有该文件；顺便复用一次读出的 `prevEntries`，不再重复解析基线。报告里的提示改成带 `--allow-new` 并提醒先单跑复现。
  - 回归：`test_delta_guard.test.ts` 从 3 条扩到 6 条，其中 2 条用真实子进程证明「拼错 → 退出 2 且基线一个字节都没动」「给了 `--allow-new` 但文件不存在 → 仍拒绝」。**诚实留白**：`--update-baseline` 的拒绝分支只有源码结构断言，没端到端跑一次全量重建（要 3–5 分钟且会写真实基线）。
- **本轮验证**：前后端 `tsc --noEmit` 均 0 错；orchestrator 定向 7 个文件 **88 条 / 87 通过**（唯一失败是 Windows 沙箱无符号链接权限的 `EPERM symlink` 既有基线）、`core_purity.test.ts` 在其中仍绿；desktop `market_state_labels.test.ts` **5/5**；`known-failures.json` 保持 45 条**未被修改**，没有用 `--update-baseline` 掩盖任何失败。
- **仍未处理的 P2，重新裁决后只剩两条真欠账**：`DailyReview` 无自动刷新（它是收盘档定稿内容，盘中每 2 分钟刷新没有意义，与四个判断页不同 —— **明确不改**，此前列成欠账是没说清）；`release_version.test.ts` 不校验 git tag（校验依赖仓库 tag 状态，CI 上易 flaky，暂不改）。另外三条从欠账里划掉：自动刷新用 `load(false)` 是**特性不是缺陷**（后端按端点 TTL 决定要不要真取，改成强制 `fresh` 会每 2 分钟打一遍上游）；逐端点 TTL「覆盖率 18/182」是**误读**（另有 54 个硬上限 + 2 分钟兜底，见上）；门禁不覆盖 desktop / Python 是 CI 分工，README 已写明。**缺腿压仓分档仍待样本**，不拿 15 份快照装回测。

- **启动日志三行正常信息全标 `[error]`，级别读反了**（2026-11-08，来自用户贴的启动日志）。
  - 现象：`17:44:33 [error] [collector] 盘中常驻采集已启动`、`[error] [api] listening …`、`17:44:48 [error] [notify] …=skipped` —— 一份**成功的**启动日志三行全是错误级别。
  - 根因：`runlog.ts` 把 `console.log → [info]` / `console.error → [error]`，但 `api.ts` 的 listening、`notify.ts:startScheduler` 默认 log、`watch.ts:startAlertCollector` 默认 log 全用 `console.error` 打正常信息。筛不出真错误，人也会被误导（与「风险 15 分被读反」同类）。
  - 修法：三处默认 log 改 `console.log`；`startScheduler` / `startAlertCollector` 各加一个可注入的 `logError`（默认 `console.error`），把「每拍钩子出错 / 调度出错 / 这一拍没采到」分流回 error；锁删不掉那类降级告警继续 error。
  - **没一刀切**：`run.ts` / `batch.ts` / `alerts.ts` / `doctor.ts` 这些 CLI，以及可能被 MCP stdio 进程调用的 `service.ts`，stdout 是 JSON / JSON-RPC 契约，**必须继续走 stderr**。改前核实 `[api] listening` 没有任何代码解析（`startup.ts` 与 `start.ps1` 都是共用控制台、就绪靠 `/health` 探活），顺手把 `api.ts` 里「桌面外壳靠这一行」的过时注释改准。
  - 回归：`log_levels.test.ts` 一条真行为（装镜像后 `console.log` 落 `[info]`、不落 `[error]`）+ 结构断言钉住分级与「CLI 不许被改」；`core_purity.test.ts` 仍绿。
- **Windows 启动窗口首行刷乱码「不是内部或外部命令」**（同一份日志）。
  - 乱码串反推 ≈「时窗口会一闪而过、看不出原因」，来自 `scripts/start.cmd:4` 的 `rem` 注释**后半段**：UTF-8 无 BOM 遇上 CMD 默认 cp936，中文注释误解码后 `rem` 被截断，后半段被当命令执行。根目录 `启动VibeAStock.bat` 还是 LF-only（CMD 逐行只认 CRLF）。服务照常启动，属无害但误导的假错误。
  - 精确是哪个字节被当分隔符**没定位到**：想跑最小 `.cmd` 实机复现时被沙箱拦下（不允许从 Bash 启 `cmd.exe`），按安全策略没绕过、也没编。修复不依赖这个断点。
  - 修法：两个脚本改成**纯 ASCII + CRLF**，中文说明移到 README；`start.ps1` 带 UTF-8 BOM 不乱码，不动。没用 `chcp 65001`：旧版 CMD 在含多字节字符的批处理里切代码页有读取偏移的已知问题。
  - ⚠️ **只改工作区文件不够**：`.gitattributes` 原先只给 `*.cmd` 钉了 `eol=crlf`，根目录 `启动VibeAStock.bat` 归默认的 `* text=auto eol=lf` 管 —— 这正是它当初变成 LF-only 的原因，提交后还会被洗回去。已补 `*.bat text eol=crlf`，`git check-attr eol` 现在两个文件都是 `crlf`，并在 `startup_scripts.test.ts` 里断言钉死这条规则。
  - 回归：`startup_scripts.test.ts` 读真实文件字节，断言零非 ASCII、`LF == CRLF`、无 BOM、`start.ps1` 仍带 BOM，以及 ASCII 化没丢启动逻辑（密钥读取、代理清空、`call`、`%~dp0start.ps1`、`pause`）。
- **同一份日志里另外三条判定为正常，不改代码**（判据已写进 README）：
  - Vite 的 `http proxy error: /health` + `ECONNREFUSED`：页面与后端并行拉起，就绪循环每 250ms 探 `/api/health`（rewrite 成 `/health` 转发 8770），后端还没 listening 的那几秒必然连不上；`vite.config.ts` 的 `proxy.on("error")` 返回 JSON 502 而非 HTML，前端 `res.json()` 不会炸。
  - `notify …=skipped`：2026-11-08 是**周日**，`.local/notify/state.json` 落盘 `gate={"day":"2026-11-08","status":"closed","reason":"周末休市"}`，四个任务都 `skipped / 今天不运行:周末休市`。`finance/schedule.ts:83` 周末判 closed → `notify.ts` 标 skipped。**这是诚实标注没跑**，不是漏跑。
  - `[collector] 盘中常驻采集已启动` 休市日照打：文案改成「常驻采集已挂载…非交易时段不取数」，说清是定时器挂着而非正在采。
  - **P2 两条明确不改，取舍留痕**：①「先等 API ready 再起 Vite」会把并行的启动串行化、总时长变成两者之和，而重试循环本来就在做这件事；② 收敛 proxy error 打印要 hack Vite 内建 logger，且那几行是「后端尚未就绪」的真实信号，压掉反而违反诚实。不装作已修。
- **启动日志修复的实机复验（2026-11-08 21:02，用户重启后贴回的第二份日志）** —— 补上一轮明确留白「没重启用户自己启动的服务，实机启动对照留给用户下次双击」。**只补记录，没改代码、没重启服务**（服务由用户自己启动，以下验证全程只读）。
  - 同日同文件 `.local/logs/api-2026-11-08.log` 前后对照：17:44 旧版本 **9 条 `[error]`**（`[collector] 盘中常驻采集已启动`、`[api] listening`、7 条 `notify …=skipped` 全是正常信息被误标）；21:02 新版本 **2 条 `[info]`、0 条新增 error**，collector 文案已是「常驻采集已挂载…非交易时段不取数」。控制台首行乱码也消失了（两个 CMD 脚本 ASCII + CRLF 生效）。
  - ⚠️ 控制台的 `[api] listening` **不带 `[info]` 前缀是预期**：`runlog.ts` 的包装是 `orig.log(...a); write("info", a)` —— 原样打控制台、带级别写盘。别把「控制台没前缀」误判成修复没生效。
  - 21:02 仍有 3 行 `http proxy error: /health` + `ECONNREFUSED`（21:02:31–32），21:02:33 就出现 `[api] listening` 与「Vibe AStock 已启动」。取全链路确认它们**就是就绪探针自己的请求**：`start.ps1:113-126` 每 250ms 调 `startup_health.ts` → `productUiReady()` 同时 fetch `/` 与 `/api/health` → Vite 代理 rewrite 到 `/health` 转发 8770；后端未 listening 时 `vite.config.ts` 的 `proxy.on("error")` 返回 JSON 502，探针返回 false 后 250ms 重试，通过即放行。重试本来就在做「等 API ready」这件事，P2 两条维持不改。
  - 端到端只读验证：8770 / 5940 均 `LISTENING`；完整就绪判据 `node orchestrator/src/startup_health.ts` 退出码 0、`--api` 退出码 0；首页 `HTTP 200`、经代理 `/api/health` `HTTP 200`。`.local/notify/state.json` 仍是周日 `closed / 周末休市`、各任务 `skipped` —— 21:02 没再打印 notify 行是当天 gate 早已判定、调度不重复输出，不是漏跑。
- **「机会发现」页的题材、龙头封单、首封/末封时间是 `10-30` 的，摆了 7 天，而同屏的涨停家数是当天的。** 用户先觉得「左面退潮期、右面逆势启动」矛盾，查下去发现两侧根本不是同一天的数据。
  - 证据链：① `三季报增长 15 只 / 最高 5 板`、`"羊"字辈 6 / 3 板`、`大消费 6 / 2 板`、`三季报大增 5 / 1 板` 与 **10-30** 那份题材树逐项一致；② 龙头「青岛食品」写着 `5 板 / 首封 09:30 / 末封 13:00 / 封单 0.57 亿`，而 10-30 的树里正好有 `青啤拟入主=1只/最高5板`、`饼干食品=1只/最高5板`，它**不在今日 26 只涨停池里**（push2ex 实时池，这一条本身可信；它旁边那个「今日 -1.81%」反而是冻结的行情键，见下文 `fetchQuotes`）；③ 现场探针 `POST /fetch {cn_shortline_themes, top:12}` 返回 `cached:true, fetched_at:2026-10-30T19:36:55, date:2026-10-30`。
  - 根因是两道门同时没关：`DEFAULT_CONSISTENCY` 是 `{mode:"prefer_cache"}` **不带 `max_age_ms`**，而 `snapshotUsable` 在「一个上限都没有」时直接 `return true`；快照键又只由「端点+参数」决定、**不含日期** —— 于是同一把键一次写入、永久命中。第二道门：`opportunityScanAct` 的 `body` 参数写作 `_body`、全程没读过，页面 `?refresh=1` 被直接丢掉，**点「刷新」也救不回来**。看着「新」的端点都是别人在替它刷（`live` 靠后台常驻采集、`em_*` 靠市场状态、`sina_board_flow` 靠盯盘概况轮询），没有第二个调用方的键就永久冻结。全库 182 个端点**没有一个**声明 `cache_max_age_sec`，这道保险其实从未生效。
  - 修法：`opportunity.ts` 新增 `SNAPSHOT_MAX_AGE_MS`，按「数据本身多久变一次」逐端点给上限（跟盘走的 `cn_shortline_live` 30 秒、收盘档/日更的六项 12 小时、`sina_board_flow` 2 分钟），表外端点兜底 2 分钟 —— **任何键都不许永不过期**；`one()` 与 `fetchQuotes` 都带上 `consistency`；`?refresh=1` 改为真取（`{mode:"fresh"}`）。`sealHistory` 刻意不加：它的键里带日期、内容不可变，加时效只会让一次刷新把 20 天全部重取一遍。
  - 实测修复效果：带 12 小时上限重取 → `cached:false, 8.1 秒, date:2026-11-05`，题材从 `三季报增长 15 / 光伏 0 / 机器人 0` 变成 `三季报增长 5 / 光伏 3 / 机器人 3 / 端侧AI 3 / AI漫剧 2`。
  - 顺带加了一条 `notes`：题材结构与龙头封单取自 `YYYY-MM-DD` 收盘档（涨停原因只有收盘后才有，**盘中不存在「当日题材」**）—— 否则只是把「差 7 天」换成「差 1 天」继续骗人。
  - 回归测试钉住四件事：机会链用到的 8 个端点必须都有显式上限；上限不许超过 12 小时；7 天前的快照在每个上限下都必须判过期；刚取回的快照仍要命中缓存（修的是「永不重取」，不是关掉缓存）。
  - 已重启并实测：`POST /fetch {em_market_trend, max_age_ms:300000}` 刚取过时 `cached:true / 0.16 秒`，改成 `max_age_ms:1` 立刻重取（`fetched_at` 换成新的一刻）；`GET /view/market_state_view` 无参数 19 秒（用到期的就重取）、带 `?refresh=1` 69 秒（六个端点全部真取）。
  - **同一类隐患一并修掉（`day_opportunity`，板块宽度）**：这张表的「涨跌家数 / 中位涨幅 / 净流入」同样没有任何时效，全靠盯盘概况顺手替它刷。现在 `tx_quotes_batch`（20 秒）、`sina_board_flow`（2 分钟）、`index_constituents`（12 小时，注释一直写着「缓存 24h」但从来没有代码兑现它）都上了时效，`?refresh=1` 也认了。为此把表与 `wantsFresh` / `consistencyFor` 抽到 `finance/snapshot_ttl.ts`，两个视图共用一份，避免再出现「改了一处、漏了另一处」。
  - **同一类缺口一并补上（本轮已改）**：`market_state`（`market_state` 与 `market_state_view` 两个动作）、`shortline/opportunities`、`shortline/overview` 三个视图的 `body` 现在都读 `refresh`，页面上的「重新取数 / 刷新」按钮从「点了没反应」变成真取。`shortline/overview` 是在入口处包一层 `fetch`、把 `consistencyFor(端点, force)` 统一挂在所有取数上 —— 它内部有十几个 `fetchEndpoint` 调用，逐个改必漏。
- **「机会发现」页切回前台不补刷：后台放半小时，回来还是 `数据 1900s 前取的`**。定时器本身没问题，是两件事叠在一起 —— 隐藏标签页里浏览器把 `setInterval` 降频到 1 分钟一拍，而这条定时器**自己**又在 `document.hidden` 时主动跳过。于是「切走 → 切回」看到的永远是切走前那一份，而按钮上明晃晃写着「自动刷新 开」。
  - 2026-11-06 11:26 实测：页面在后台约 31 分钟，回来时 `数据 1900s 前取的`；同一屏的「盯盘 · 实时概况」反倒立刻刷新了。快照写入时间对得上这件事 —— 页面驱动的四个快照挤在 `11:25:06 / 11:25:34 / 11:26:29 / 11:26:32`（正好一轮 `useOverviewPoll` 的 86 秒），之后一片安静；而后台常驻采集的 `cn_shortline_live`（3 秒）一直到 `11:30:32` 都没停。差别在于 `useOverviewPoll` 早就有 `visibilitychange` 补刷，这几个「判断页」一直没有。
  - 修法：补一个 `visibilitychange` 监听，切回前台且数据已过期（≥ `REFRESH_MS`）时立刻取一轮。**只在过期时补** —— 一轮要跑十几秒、起好几个取数进程，不值得为差 30 秒重跑。
  - 定时器与刷新频率都没动：仍是交易时段每 2 分钟一次、隐藏时跳过（隐藏时不取数是有意的，省 CPU 和取数进程）。
  - **这三页一并补上（本轮已改）**：抽了一个 `useMarketAutoRefresh` 钩子（盘中每 2 分钟一轮 + 切回前台时若已过期立刻补一轮），`MarketState` / `ShortlineOpportunities` / `TradePlans` 三页接上，「机会发现」也换成同一个钩子，四页行为一致。`loadedAt` 只在**成功**拿到数据时记 —— 记在 `finally` 里的话，取数失败也会把「刚更新过」写进去，反而压住下一次补刷。
- **「自动刷新 开」开着却一直不刷，数据停在「387s 前取的」**。定时器确实每 2 分钟触发，但每次都过 `isMarketTrading("CN")` —— A 股从 **09:15** 起才算交易时段，09:02 当然刷不动；按钮只表示「开关状态」，不表示「此刻正在刷」。
  - 修法：按钮在非交易时段显示「自动刷新 开（开盘后生效）」，`title` 说明「现在是盘前，没有当日数据可刷」。
  - 顺带修「数据 387s 前取的」这个读数：它只在盘中有判断价值（够不够新鲜），盘前只会一路涨到几千秒、看着像故障 —— 非交易时段改成绝对时刻「数据 08:56 取的」。
  - 自动刷新的**行为没改**：仍然是交易时段每 2 分钟一次。盘前不刷是对的（没有当日数据），要改的是它不该显示成「正在刷」。
- **「机会发现」页同屏自相矛盾：闸门写着「上证 > MA20 未过」，右边却写「闸门开着、顺势做」**。数据和判据都没错，是**一个词被用在了两个量上**：左边那排灯读 `gate.all_pass`（三道门全过），右边四格卡读 `can_open_position`（仓位上限 ≥ 40% 且非极高风险）。
  - 为什么会撞上：MA20 一票未过 → `gateCap = 40`，而「能开仓」的门槛也正好是 40% → `40 >= 40` 判成「能开」。**40% 这一个数被用了两次**，于是「正好一票未过」时反而显示成闸门畅通（2 票未过压到 20% 反倒显示「未开」）。
  - 修法：只改措辞与摆法，**判据一个字没动**。四格卡的纵轴改成「可开新仓（上限 40%）/ 暂不开新仓」，与「市场状态」页早就在用的说法统一；把仓位上限数字直接写进坐标行，「能开、但只能轻仓」一眼看得出来；四格说明与 `title` 同步。
  - 不动判据的理由：`can_open_position` 在全仓都表示「能给到轻仓就算能开」，语义本身没错；把「中性偏多」式的一票否决直接等同「不许开仓」是另一档纪律，要改应由用户拍板。
- **「机会发现」页盘前自称「盘中 · 实时」，内容却是上一交易日收盘**。`settled` 只有「已收盘 / 没收盘」两态，而「没收盘」既包含真在盘中，也包含**今天还没开盘**。
  - 2026-11-06 08:40 实测：`date=2026-11-06, clock=08:40, settled=false, live=null`，那一刻涨停 / 炸板 / 封板率全是「—」，闸门三项是 11-05 的数 —— 页面却顶着「盘中 · 实时」的红标。
  - 修法：状态标改成三态 —— 「盘中 · 实时」/「已收盘（定格）」/「盘前 · 读数为上一交易日收盘」（非交易时段同理）。盘前物理上没有当日数据，所以这里不是「去取实时」，是**不许自称实时**。
  - 盘中刷新行为未变：`auto` 默认开，交易时段每 2 分钟一次。
- **大盘判断台账整整缺了 `2026-11-05` 一整天**，而落账任务报的是 `ok`。全景侧那份交接件写的是 `"direction": "中性偏多"`，而 `DIR_ENUM` 只有三档（偏多 / 中性 / 偏空），校验判它不合法 → 原件留在 `inbox/` 不动、台账少一行、job 把缺口塞进 note 而日志只记了 `ok`。
  - 修法：`DIR_ENUM` 扩成五档（`偏多 / 中性偏多 / 中性 / 中性偏空 / 偏空`），`ledger_kinds` 的 schema enum 与 label 表、前端 `CallDirection` 同步；**原样存档，不做归一化** —— 把「中性偏多」改写成「偏多」就是篡改上游判断，这张台账只存档不生成建议。
  - 这是放宽下游而不是约束上游：档位是全景档的自然表述，靠提示词把它压成三个值迟早再犯。
  - 补回归测试「五种档位逐个走一遍且原值不变」；`2026-11-05` 已用新逻辑补入（`ingested: 1, gaps: []`），原件归档到 `processed/`。
  - 已重启，五档对新件生效（`2026-11-05` 那份已补入）。
- **「市场状态」页的量能门与均线门长期显示「未评估」**（不是没数据，是被超时掐了）。这两道门的输入全部来自 `em_market_trend`，而 `loadBundle` 只给它 30 秒。
  - 实测该端点 13 次耗时：6.6 / 18.1 / 24.1 / 25.2 / 30.8 / 33.0 / 38.6 / 42.4 / 42.4 / 52.4 / 80.1 / 80.5 / 88.2 秒，**中位数 38.6 秒、9/13 超 30 秒**。拆开计时后看清了慢在哪：腾讯那 7 根指数日线各只要 0.5 秒，慢的是两市成交额 —— 东财 `push2his` 三个域名当周全断（`RemoteDisconnected`），只能落 baostock，**而 baostock 登录单次就要 87 秒**。
  - 后果是结构性失败而非「慢一点」：超时 → `trend` 信封为 null → `gateDataFrom` 拿不到输入 → 两道门同时 unknown（广度门走另一个端点，所以只有它还亮）；叠加失败记忆的 60 秒负缓存，15 秒轮询几乎一直吃到它，命中率≈0。同一分钟两页互相打脸：盯盘页（不传超时 → 默认 180 秒）`量能 pass +28.0% / MA20 fail(3689.91 ≤ 3701.53)`，市场状态页两条都 unknown。
  - 修法：`loadBundle` 里 `em_market_trend` 的 `timeoutMs` 30 秒 → **100 秒**（覆盖实测尾部 88.2 秒）。判据一个字没动。
  - 代价：冷启动那一屏最坏等 100 秒；**仍是单点**，baostock 抖一下照样空。治本要把「20 日均额」这种一天只算一次的指标落盘 + 每日补算，闸门只读盘 —— 否则慢路径永远在闸门的关键路径上。
- **公告标题等中文字段变成 `��Ʊ�����쳣��������`**：取数子进程的环境是白名单挑的（`FETCH_ENV_KEYS`），里面没有 `PYTHONUTF8` / `PYTHONIOENCODING`；Node 侧又一律按 `utf8` 解子进程 stdout（`service.runFetchProcess`）。Windows 上 python 没被声明编码就按 ANSI 代码页（cp936）写 —— 管道里是 GBK 字节、Node 当 UTF-8 解，中文全成 U+FFFD，**且不可逆**。用 `scripts/start.ps1` 起的后台正好没有这两个变量，所以必现；从 Git Bash（自带 `PYTHONUTF8=1`）跑同样的脚本却是好的，这也是它一直没被怀疑的原因。
  - 修法：`config.ts` 新增 `PYTHON_UTF8_ENV`，`fetchEnv` 强制带上；`run_tools.ts` 两处 `spawnSync`、`doctor.ts` 的 `minimalEnv` 一并补上。确定性计算那边早有同样处理（`task_adapters.ts` 的 `calcEnv`），这次是把它推到取数 / 体检 / 计算三条 spawn 路径。
  - 实测（同一台机器、同一个脚本、同一时间段）：不带这两项 → 标题 `�������꣺��Ʊ�����쳣��������`、整份输出 125 个替换符；带上 → `大连友谊：股票交易异常波动公告`、0 个。
  - 已被写坏的缓存是**不可逆**的：`.local/snapshots/` 下 85 个快照（`fetch_announcements` 69、`fetch_estimates` 8、`fetch_financials` 6、`fetch_profile` 1、`fetch_trade_calendar` 1，2026-10-27 09:05 起）已挪到 `.local/_broken-snapshots-20261105/`（带 MANIFEST），等重取覆盖。**这条修复上线前产生的通知/快照不会自动变好。**
  - `release_version.test.ts` 允许 CHANGELOG 顶部有 `[未发布]` 小节（它不主张版本号），版本一致性照旧只认最上面的**版本**条目。
- **跑完了但有缺口，任务照样记 `ok`，界面上是绿的「已运行」**。`runJob` 里 `status: "ok"` 是**硬写死**的，任务函数没有任何途径说「我跑完了，但有一部分没落成」—— 于是「台账整整缺一天」这种事只藏在 `note` 里，不点开就看不见。这正是上一条 `2026-11-05` 缺了一整天却没被发现的机制。
  - 修法：`JobResult` 新增可选 `status: "ok" | "partial"`，`runJob` 照它写；`marketCallJob` 在有缺口时返回 `partial`。**只许往低报、不许自称失败** —— 报 `failed` 之类的值会被 `checkResult` 直接判成失败，免得绕过「10 分钟后重试 / 三次才放弃」那套逻辑。
  - 界面：`partial` 显示成「已运行（有缺口）」，黄色 `warn`，与「已运行」分开；`TickReport.ran` 里也带着 `partial`，日志不再只有 `ok`。
  - 实测（2026-11-06 17:00 手动跑 `market_call_sync`）：`status=partial`，`note=落账 0 条;对账 1 条(2026-11-05);缺口 1 条:2026-11-05:趋势序列里没有 2026-11-06 的两市成交额`。改之前这一趟记的是 `ok`。
  - `partial` 也算「今天跑过了」（`last_day` 照写），不会因为一条缺口整天反复重跑；缺口本来就要靠第二天的到点运行或人工回看。
- **赚钱效应缺一条腿时被当成 0 分**：`resLeg = resonanceShare ?? avgRes ?? 0`、资金流 `boardRows.length ? … : 0`，数据源抽风那天这一维凭空少 25 / 20 分（权重 0.25，综合分最多被压低约 11 分），表现成「今天很差」—— 其实只是「今天没看见」。
  - 但**单纯把权重全让给广度也不行**，实测过：三条腿只剩广度时，广度 87% 的假想日算出 **87** 分，比数据齐全的好日子（共振 60% / 净流入 50% → 73）还高 —— 那就成了「取数故障当利好」，与 `positionCapOf` 里「有门没评估不许给满仓」是同一个错误。
  - 最终口径：缺的腿按 `min(中性先验, 已看到部分的加权均值)` 补位。中性先验取实测中位数（共振率 ≥60% 的板块占比长期在 0.08~0.30 → 0.2；净流入板块占比实测 26/48 = 54% → 0.5）。性质：**不比中性更好、也不比已经看到的部分更好**，且永远 ≥ 旧的「按 0 算」，不会比现在更苛刻。
  - 实测四种情形：双腿全缺 **63**、只缺共振 63、只缺资金流 73、齐全（0.6/0.5）**73**、齐全但都差（0.1/0.1）**52** —— 缺数据落在中间，不再是极值。坏日子（广度 17%）缺腿仍是 17，不会被补位拉回来。
  - 显式给 0 仍按 0 算（那是「真的差」，不是「没数据」）；页面上多一条 note：「赚钱效应的板块共振没取到，这部分按中性补位（既不当 0 分，也不会因为缺数据反而变好）」。2026-11-06 17:00 实测东财 `push2/clist` 全断，这条 note 正好出现在市场状态页。
  - 遗留（要用户拍板）：缺腿日现在仍可能靠广度拿到 75+ 分、进而给到 100% 仓位档。要不要「缺腿就把仓位上限压一档」，属于纪律问题，没自作主张。→ **这条留白已闭合**：同日用户明确授权后落地，见下文 🔴「判据变更」那条；此处保留当时的判断原文，不再作为待办。
- **复盘页「沪深京三所家数」整块没取到时，只剩三行「—」**，与「三所都是 0 家」在视觉上分不开。原计划是用 23 档涨跌分布合起来顶替，核对后**决定不这么做**：实测 2026-11-06 分布合计 5379 只、三所合计 5650 只（差约 5%），端点说明里也写着「分布合计与三所家数合计口径不同，不互相凑」，且既有测试早就钉了「不拿来顶」。
  - 改为把缺口说出来：`parseBreadth` 新增 `exchangesMissing`（三家全空才算，只缺一家仍显示「—」），复盘页在三所家数表上方给一条黄色提示「这次没取到，上面的涨/跌/平与分档图来自 23 档涨跌分布，不受影响；三所口径与分布口径本来就不一样，不拿分布合起来顶替」。
- **五维评分里的「风险 15 分」被读反**。用户看到退潮期还写着「风险 15 分」，按字面理解成「风险很低」；其实 `risk_score = 100 − (跌停家数×2 + 跌家占比×100)`、下限 15，量的是**安全度 / 抗跌度**，15 分是**最危险**那一档。五维本来就是同一方向（0–100、分越高越正面），只有「风险」这个名字拧着，没有第二套反向分。
  - 证据：`.local/snapshots/em_market_breadth-709950a55d31.json` 在 2026-11-06 19:14 的读数 `涨停 32 / 跌停 15 / 涨 646 / 跌 4618 / 平 68`，跌家占比 86.6% → `100 − (15×2 + 86.6) = −16.6`，被 `clamp(…, 15, 100)` 截到 15。数字没错，是标签让人往反方向读。
  - 修法：**只改叫法与方向说明，判据一个字没动**。`desktop/src/verticals/finance/lib/marketState.ts` 新增共享的 `DIMENSION_LABELS`（情绪 / 龙头 / **抗跌度** / 赚钱效应 / 事件，各带一行 hint：越高越热 / 越强 / 越安全 / 越好赚 / 越偏多），「市场状态」独立页与「盯盘 · 实时概况」内嵌版两处的五个环都走这一份，不再各写一份。两页都写明「五维都是 0–100 分，**分越高越正面**；『抗跌度』原名『风险』，量的是安全度，分低才是危险」；公式文本、给 AI 的页面上下文、后端 `recommendation.reason` 同步写上新名字与方向。
  - **没有动**：字段名 `risk` / `risk_score`、风险分公式、`risk: 0.15` 名义权重、五维加权、情绪阶段判定、三道闸门判据与 `riskLevel` 分档 —— 分数、仓位上限、任何阈值全都没变。新增的 `market_state_labels.test.ts` 专门把这四行源码钉住，防止以后有人「顺手」把公式也改了。
  - **已重启并实测**：后端 `reason` 这处必须重启服务才生效（前端 Vite 已热更：实测 `/src/verticals/finance/pages/MarketState.tsx`、`lib/marketState.ts`、`shortline/OverviewTab.tsx` 三个模块都已带「抗跌度」与方向说明）。重启前后各调一次 `GET /view/market_state_view` 作对照：
    - 重启前 `…综合 41 分（情绪 46·龙头 80·风险 15·赚钱效应 20·事件 60）…`
    - 重启后 `…综合 41 分（五维 0–100、分越高越正面：情绪 46·龙头 80·抗跌度 15·赚钱效应 20·事件 60）…`
    - 综合分仍是 41、五维仍是 46/80/15/20/60 —— **文案换了，分数一个没变**，实机也验证了「只改叫法、不碰判据」。
  - 注意：页面上的「风险等级」徽标（低 / 中 / 高 / 极高风险，`RISK_LEVEL_META`）是**另一个量**，不是这一维分数，没有改；抗跌度低 → 风险等级高，两者方向相反是本来就该有的，不是读反。
  - 测试：新增 `desktop/test/market_state_labels.test.ts` 4 条；前后端 `tsc --noEmit` 0 错；`market_state + market_score` 81/81；desktop 全量 448/448。
- **调度锁在「删文件被环境策略拦下」时会静默卡死约 11 分钟**。旧 API 后台日志实测 `[notify] 每拍钩子出错:[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,"scope":"turn","targets":["…beat.lock"]}`：环境层的批量删除保护拦下 `fs.rmSync`，而 `notify.ts` 的 `unlock()` 裸调删除、**没有 try/catch**（同一文件里的 `touch()` 却包了），死锁清理那处也一样。后果链条：unlock 抛错 → 锁文件残留且 mtime 被 touch 过 → 要等 `staleMs`（约 11 分钟）才判死 → 期间所有 `tick` 静默返回 `skipped:「另一个后台进程正在调度」`。**不报错、只是不跑任务**，是最难发现的一类故障。
  - 修法：**不碰调度语义、不碰任何判据**。新增 `LOCK_RELEASED = "released"` 与 `releaseLock()`：删得掉就删，删不掉就写释放标记 + `console.error` 显式告警，绝不把异常抛回 `finally`。`tryLock` 见到释放标记（或空文件）就覆盖重建；见到 `pid:token` 的活锁仍按原逻辑挡住。覆盖写不是严格原子互斥，但 `mine()` 自校验保证同一时刻最多一个进程认为自己是 owner，且这条路径只在降级场景出现。
  - **没有绕沙箱策略**：全库 grep 不到 `safe-delete` 字样，那是环境层保护，改产品代码去对抗它只会把环境假设写进产品。运维上长期服务仍应双击 `启动VibeAStock.bat`，重启后手工清掉三把锁。
  - 新增 `orchestrator/test/notify_lock.test.ts` 6 条。其中一条**真注入删除失败**（只让 `tick.lock` 的 `rmSync` 抛错）验证「写释放标记 + 告警 + 不抛 + 下一拍恢复」，不是只靠 mock；另有一条钉住源码不许再退回裸调 `rmSync`。
- 🔴 **判据变更：赚钱效应缺腿时，仓位上限压到 40%（复用「闸门未评估」同一档）。** 经用户 2026-11-06 明确授权后落地，**会改变历史回测结论**，故单列写清证据、影响面与留白。
  - 证据：`positionCapOf` 早就有 `unknownCap = 有 unknown ? 40 : 100`，注释原话「前者给满仓等于拿取数故障当利好」。但板块共振 / 板块资金流缺失**不进** `gate.unknown`，分数按 `min(中性先验, 已看到部分的加权均值)` 补位后看着正常 → 三闸门全过时能直接给到 **100% 上限**，绕过了自家防线。同一类「数据不全」，一条被挡、一条没被挡。
  - 改动后实跑 `deriveMarketSignal`（涨停 80 / 广度 87% / 三闸门全过）的对照：
    | 数据情况 | composite | 仓位上限 | `incomplete_legs` |
    |---|---:|---:|---|
    | 双腿全缺 | 73 | **40%** | 板块共振、板块资金流 |
    | 只缺资金流 | 75 | **40%** | 板块资金流 |
    | 数据齐 | 75 | **100%** | 空 |
    `positionCapOf(78, 三门全过)` 不传第三参仍是 `100`（向后兼容），传 `{dataIncomplete:true}` 才是 `40`。注意 `40%` 仍是「可轻仓试探」（`can_open_position=true`），与既有 `unknownCap` 语义一致 —— **压仓不等于禁买**。
  - 修法：`positionCapOf` 加可选 `opts.dataIncomplete`，新增 `completenessCap`，四者取小；常量 `INCOMPLETE_DATA_CAP_PCT = 40` **复用已有档位、不引入第二套标准**。`deriveMarketSignal` 把 `missingLegs` 提前并传入，`MarketSignal` 新增 `incomplete_legs` 结构化字段；`notes` 与 `recommendation.reason` 都写明「缺哪条腿 / 上限因此压到 40%」，理由走结构化字段而不是去 `notes` 里搜文案（措辞一改就静默失效的教训见 `evaluateMarketGate`）。
  - **没动**：五维分数公式、权重、阶段判定、三道闸门定义、`riskLevel` 分档、中性补位算法。完备性只约束「这个结论能用到多重的仓」。
  - **影响面（重要）**：`market_state.test.ts` 里「涨停 80 + 三闸门全过」那条用例原本传的是空 `{}` fixture（= 双腿全缺），却断言 `position_cap_pct=70` —— 这正是漏洞的现场样本。已改成断言 40 并写明原因，**不是把 bug 固化成期望**；另加一条「数据齐」对照用例证明好日子没被误杀。`positionCapOf` 不传第三参时行为逐位不变，旧调用零影响。
  - **档位口径留白**：一律 40，**没有**分「缺 1 腿 / 缺 2 腿」。现有 15 份 `em_market_trend` 快照且 `ma20` 几乎全 `fail`，样本不足以给档位定值，不拿 15 天数据装回测。以后要细分，先用转正后的 `scripts/gate_probe.ts` 回放取证再拍。
- **「缺腿压仓」的说明原本在页面上看不见（又被静默了一次）**。`marketStateViewAct` 给 `view.notes` 只填了取数降级 + 闸门说明，而 `deriveMarketSignal` 产出的 notes（事件面没算出 / 闸门未评估 / 赚钱效应缺腿）只留在 `view.signal.notes`；前端「降级提示」渲染的恰恰是 `view.notes`。现在两处共用同一个 `allNotes` 数组，不再出现「同一份数据两个说法」。实机确认 `view.notes === signal.notes`，3 条提示全部可见。
- **实机抓到的文案自相矛盾**：2026-11-06 真实读数 `cap=0`（三门全灭、极高风险），`reason` 却同时写「仓位上限归零」和「仓位上限压到 40%」—— 40% 是**天花板**，取小之后完全可能更低。改为：只在完备性真是约束项（缺腿时 `cap === 40`）才写「压到 40%」；`notes` 一律写「最多 40%」并附实际值（`实际 0%`）。新增一条测试钉住「闸门已压得更低时不许再说『压到 40%』」。
- **增量门禁会把负载偶发误报成真实回归**。`test-delta.mjs` 判定「并行跑红、单跑通过」用的是「单独重跑**整个文件零失败**」，但基线里本来就有必挂用例（`audit_chain` 的 `EPERM symlink`）的文件**永远不可能零失败** → 该文件里任何负载波动都会被报成「本次改动引入」。2026-11-06 连续两次门禁分别误报 `startup_*` 3 条、`audit_chain` 1 条，逐条单独重跑均通过。改为按**用例名**比对单跑结果：候选用例单跑仍红才报新增，否则标 flaky；真实回归不会被这层判定吞掉。

- 🔴 **全项目审计后的 P0 收口：四项「不报错、只会把错的/旧的数据当真」的静默风险**（2026-11-06，用户授权「按建议修」）。**没有动任何判据、分数、权重、阈值、仓位档位**，改的全是「缺口怎么被如实带出来」和「缓存什么时候必须失效」。

  - **① Core 缺省 `prefer_cache` 仍然可以永不过期。** 上一轮只在 `finance/` 里逐端点补了上限，`DEFAULT_CONSISTENCY` 本身仍是 `{mode:"prefer_cache"}` 不带 `max_age_ms`，`snapshotUsable()` 在 `limits.length === 0` 时无条件 `return true` —— 只要哪个调用方手写一份 `{mode:"prefer_cache"}`，「一次写入、永久命中」的洞就还在。审计还找到**第二套** `consistencyFor()`：`finance/shortline/history.ts` 给日记 / 环境 / 市场判断等路径返回不带上限的 `prefer_cache`。
    - 修法：`snapshot.ts` 新增 `DEFAULT_PREFER_CACHE_MAX_AGE_MS = 2 * 60_000`，`DEFAULT_CONSISTENCY` 带上它；`snapshotUsable()` 在 `prefer_cache` 且一个上限都没有时**不再 `return true`**，而是强制 push 缺省上限 —— 结构口子堵在 Core，调用方手写也绕不过去。`cache_only` 保留原义（显式「离线 / 绝不联网」，有就用，不受时效影响）。
    - `finance/snapshot_ttl.ts` 的兜底改成直接 import Core 常量（`SNAPSHOT_FALLBACK_MAX_AGE_MS = DEFAULT_PREFER_CACHE_MAX_AGE_MS`），两套兜底不许再分叉；`history.ts` 新增 `HISTORY_IMMUTABLE_MAX_AGE_MS = 30 天`，历史路径一律给显式上限，并加可选第 4 参 `endpoint` 让非日期端点走端点表。`market_call.ts` 的 `em_market_trend` 显式传 endpoint → 5 分钟（此前会套到历史路径的 30 天）；同处把写错的 `16:05` 改成实际的 `18:30`。
    - **留白**：端点表仍只覆盖 18 个端点，`registry.json` 实测 182 个端点里 128 个没声明 `cache_max_age_sec`。现在有 Core 缺省兜底，不再「永不过期」，但逐端点精度仍欠着。
  - **② `partial + 占位 0` 会被写进快照，下次打开把「没取到」读成「确实是 0」。** mapper 在上游没给数据时（非交易时段、池子为空）返回 `status=partial` + 一条 `value=0` 的展示用证据 + `missing`，而 `keepableForSnapshot()` 只看 `extra.no_cache`；这份 0 一旦落盘，下游只读 `value` 就再也分不出「没有」和「是 0」。
    - 修法：`mappers.py` 新增统一 `no_data()` helper，产出「展示用占位证据 + `missing` + `status=partial` + `extra.no_cache=true` + `extra.placeholder_zero=true` + `degraded=原因`」；六处占位 0 路径改走它（`em_daily_dragon_tiger`、`em_zt_pools` 的跌停/炸板池、`em_hot_concept`、`ths_hot_reason`、`ths_hsgt_realtime`、`ths_limit_up_pool`）。`service.ts` 的 `keepableForSnapshot()` 显式拒 `placeholder_zero`。
    - **刻意不一刀切禁掉所有 `partial`**：`em_market_trend` 常态就是 partial 但带 153 条有效证据，早先试过「partial 一律不缓存」，结果是每次打开重取 15–30 秒。这里只拦「会把缺口伪装成真值」的那一种。
    - 顺带 `breadth_missing_field()` 按 note 性质把 missing field 分到 `market_dist_count` / `market_up_count` / `market_breadth`，不再把所有备注都写死成 `market_up_count`。
  - **③ 涨跌分布走新浪备源时，证据署名仍写成东财。** `eastmoney.py` 主源分布桶没有 `source`，备源桶又把 `sina_updown_distribution()` 返回的 `source:"sina"` 丢了；`mappers.py` 生成 `market_dist_count` 证据时回退 `ctx["source"]="eastmoney"`，于是「东财断了、其实用的是新浪」这件事在证据链上消失。
    - 修法：主桶显式 `source:"eastmoney"`、备源桶保留 `source:"sina"`；证据按桶透传真实 `source`，`extra.distribution_sources` 写出这次到底用了谁；note 写「改用新浪全市场快照聚合(备源 source=sina)」。`sina.py` 不用改。
    - 口径不变：23 档分布合计与沪深京三所家数合计仍是两套口径（实测 5379 vs 5650），**不拿分布合计顶替三所家数**。
  - **④ AI 复盘 / AI 周报 / 每日 Agent 复盘有缺口仍报 `ok`。** `runJob()` 默认写 `ok`，这三个任务把「段跳过 / 资料包缺口 / block 失败」只塞进消息或 note。更隐蔽的一处：`dailyReviewJob()` 正文生成了、但 `ledgerInsertMany` 没落进去时，只在消息里写一句「见任务状态」就照常报成功。
    - 修法：三个 job 有缺口时显式返回 `status:"partial"`；`market_review.ts` 新增可注入的 `deps.save`，「正文生成了但研究记录没写进去」**直接抛错**（`Agent 复盘正文生成了,但研究记录没写进去:任务不能报成功`），消息里改成始终写明研究记录 id。
    - **没动**：`runJob()` 默认 `ok` 的语义、「partial 也算今天跑过」（不反复重跑）、收件箱与重试逻辑。**留白**：只盘点了这三个明确的 AI 任务，其余 job 还没全量核对「跑完但有缺口」的情况。
  - **本轮改动自己带出的两处回归，都已修掉、没有写进基线**：① `service.ts` 新注释里的「盘前」命中 `core_purity.test.ts` 的 Core 行业词表（`CEILING=0`），门禁如实报了 2 条新增失败 → 改成中性措辞「非交易时段的空响应」，单跑 `core_purity.test.ts` 8/8；② `eastmoney.py` 备源 note 写成 `改用sina…` 撞坏既有 `test_market_review.py` 的「新浪」断言 → note 改回中文并带 `source=sina`，新测试断言同步。**门禁没有靠调基线变绿。**

- **P1 收口：五处「刷新 / 失败没被如实传下去」**（2026-11-07，全项目审计后续）。**判据、五维分数、权重、仓位档位一律未动**。
  - ① `Opportunity.tsx` 三源 `Promise.allSettled` 全失败仍无条件记 `loadedAt` / `setFetchedAt` → 屏上是旧数却显示「数据 0s 前取的」，还会把「切回前台补刷」压住两分钟（最该重试的时候）。改为只有 `errs.length === 0` 才记，与 `MarketState.tsx` 成功分支同一口径；错误横幅与 `setLoading(false)` 不变。
  - ② `shortline/register.ts` 的 `run` 写死 `{}`，`GET /view/shortline_overview?refresh=1` 的 query 被丢掉 —— 只有 POST act 能真刷新。`ViewDef.run` 本来就收 `query: Record<string,string>`，现原样交给 `shortlineOverviewAct`；`wantsFresh` 认字符串 `"1"`，无需额外转换。
  - ③ 机会链 `opportunityScanAct()` 内部的 `marketStateAct(ctx, {}, signal)` 没带 force → 点刷新时子信号仍读缓存，同屏新旧混排。改为 `{ refresh: force }`。
  - ④ `watch.ts` 的 `collector.lock` 释放仍是 `catch {}`，删不掉就静默留一把活锁（与已修的 `notify.ts` 调度锁同一个坑）。现在删不掉就写 `released` 标记 + `console.error` 显式告警；`ensureLock` 把空文件 / `released` 判为无主并**覆盖重建**，死锁仍按 90 秒判。文件不存在时保留 `wx` 严格互斥，只有无主 / 死锁路径才覆盖写，不扩大竞态面。
  - ⑤ `day_opportunity.ts` 的 `packageHistory(...).catch(() => [])` 把具体异常吞成一句通用 gap。现在记下 `histError` 并附进 gap（`具体失败：…`），能看出是哪个环节挂了。
- **文档口径统一**（不改代码行为）：README 原来只写「raw 超过 14 天删除、被引用的不删」，`VRA_RAW_KEEP_DAYS` 被当成全局开关；实际是**两套回收、清不同目录** —— `runs/<run>/raw/` 研究证据（14 天 / 有引用保护 / `VRA_RAW_KEEP_DAYS` / 调度器每天跑）与 `mcp/<session>/raw/` 取数缓存（30 天 / 只按 mtime / `VRA_RAW_RETENTION_DAYS` / 每次 `POST /fetch` 顺带）。改成并列写清，另补三处容易读错的分工：`test:delta` 是本机增量门禁、只覆盖 orchestrator 且 CI 不跑它（基线含本机沙箱专属失败）；CI 跑全量；`desktop/tsconfig.json` 不含 `test/`，typecheck 不检查测试文件。

- **复核 45 条失败基线，并修掉增量门禁的一处假绿口子**（2026-11-07）。
  - 逐条单跑 5 条 `flaky:true`：`earnings_brief`、`local_agent_runtime`、`service_api_mcp :: 请求体上限`、`shortline_samples` 四条通过；**`service_api_mcp.test.ts :: 断开 /debate 取数请求会结束子进程…` 单跑仍红（`not ok 8`）**，而它的 `cause` 是 `flaky-load`、err 写着「并行跑红、单独复跑通过」—— **归类与事实不符**。错误文本没取到：单跑过程中沙箱拦了 `reg.exe`（程序黑名单），按安全策略不重试，**标「待验证」，不猜原因**。
  - 另两条 `code-or-unclear`（`earnings_brief`、`shortline_samples`）单跑都通过，但 err 只有「没抓到过错误文本」—— 说明不了「曾经为什么红」。这是**诚实留白**，不是已排除问题。
  - **没有改 `known-failures.json`**：它是 `--update-baseline` 的生成物，手改会被下次重建覆盖；改归类属于口径变更。建议下次重建时把 `断开 /debate` 归到 `env-*` 并去掉 `flaky:true`（先确认是否沙箱 / 无真实 AI 所致）。`generatedAt` 仍是 2026-11-01，复核后没有伪造新时间戳。
  - 🔴 **真 bug（已修）**：`test-delta.mjs` 对「疑似新增失败」单独重跑时只取 `results`（失败列表），**丢掉 `files`（这次真跑过的文件）**。单跑匹配不到文件 / 进程异常时两者都为空 → 所有候选被判成「单独通过、负载偶发」，真实回归整批标 flaky、**退出码假 0**。现在用 `reranFiles` 确认覆盖，没覆盖的进 `uncovered`、保留为新增失败并在报告里显式列出。`test_delta_guard.test.ts` 用真实子进程证明空集合确实会出现（拼错 `--only` 时 `files=[]` 且 `results=[]`），并钉住旧写法不许回退。
  - **另有两处口子，本轮只记录、不自动改**（改的是工具契约、影响日常操作，需拍板）：① `--flaky "文件::用例名"` 在基线里没匹配到时会**凭空新增**一条 `flaky:true`，不验证文件 / 用例是否存在、也不跑测试；报告里又主动提示这条命令，两者合起来是把一条真实回归洗进基线的最短路径。② `--update-baseline` 用「当前所有失败」覆盖基线，没有「本次新增失败需二次确认」的护栏。

### 变更

- **`orchestrator/gate_probe.tmp.ts` 转正为 `orchestrator/scripts/gate_probe.ts`**（原文件已删，内容完整迁移并增强，无资产损失）。原来写死 `../.local/snapshots`、必须从 `orchestrator/` 目录里跑才对，也不在 `tsconfig.include` 范围内、`git status` 是 `??` 未跟踪的孤儿文件 —— 换台机器就没。现在路径基于 `import.meta.url`，从任意 cwd 都能跑；输出补上完整快照文件名与总份数；`tsconfig.include` 补 `scripts/**/*.ts`。转正后 tsc 立刻抓到原本藏着的一处 `r.items` 可能为 undefined，已修。它现在是回放 15 份历史快照、核对闸门三态的取证工具，也是上一条判据变更以后调档位的对照工具。

- **AI 盯盘自动轮询 10 分钟 → 3 分钟**（`useIntradayAiWatch` / `useAiWatch` 的 `POLL_INTERVAL_MS`，以及盯盘面板上那行「盘中自动 · N 分钟更新」的文案）。原来 10 分钟一轮时，一轮跑完页面已经「安静」了七八分钟，看起来像停了；3 分钟与前端其余轮询（盯盘概况 86 秒、判断页 2 分钟）同一量级。代价是**模型调用次数约 ×3**，长任务（要串好几轮工具）时仍按单飞跑，不会叠加。

- **三个定时 AI 任务改用「接入 AI」保存的那一份**（`daily_review_ai` 18:55 / `shortline_review_ai` 19:02 / `weekly_ai_review` 周五 19:10）。它们跑的时候没有浏览器，此前读的是数据根 `config.json` 的 `provider.profile` + 环境变量里的 key —— 和用户在页面上选的那一份**可以是两家**，而界面上一片绿。2026-11-05 实测：侧栏写着「已接入AI」，三个任务却因为 `config.json` 里的模型名不是服务商认的名字全部 404，当天两篇复盘一篇没写出来，**没有任何一处提示**。
  - 新增 `orchestrator/src/page_saved_llm.ts` + `GET/POST/DELETE /llm-saved`：页面「测试并保存」成功后，同一份配置落一份到 `<数据根>/llm.json`。
  - `defaultLlm()` 的优先级改成：命令行 `--provider/--model/--config` ＞ 环境变量 `VRA_PROVIDER` ＞ **页面保存的那份** ＞ `config.json`。前三档都是当次显式选择，一律压过后一档。
  - 落盘前按后台**同一条**解析链干跑一遍（`resolveRuntimeProvider`），认不出的来源 / 缺 key / 地址不合法当场拒，不存一份让任务天天报错的配置；页面上「清除」会连这份一起删，不留第二份没人管的 key。
  - **读不懂就报错，不换家**：`llm.json` 存在但解析不了 / 没有 `provider` 时，任务直接失败并说明是哪个文件（`bad_llm`），不回落 `config.json` —— 那等于用户选了这家、账单和产出却来自另一家。
  - **可见性**：设置页新增一行「收盘后的定时任务用哪一份」；`productInfo` 的 `provider` 改成**定时任务实际会用的那份**并带 `provider_source`（`page` / `config`），`config.json` 那份另放 `config_provider` 供诊断，`saved_llm` 给打码状态与「读不懂」的原因。
  - **安全**：文件权限 0600（Windows 走 `icacls`，收不紧就删掉再报错）；`VRA_REMOTE=1` 拒绝写入；`GET /llm-saved` 只回 provider / 模型 / 端点（端点去掉 userinfo、query、fragment）/ 保存时间，**任何返回都不含 key**；不进日志、账本、研究产物。
  - 前端一并改：`saveLlmEverywhere` / `clearLlmEverywhere`（`llm.ts`），保存失败时说的是「页面已保存、后台那份没存下」，既不冒充成功也不谎称全失败；设置页的主页快捷接入（`QuickAiConnect`）走同一条路。
- **采集不再依赖页面**：新增 `startAlertCollector`（`orchestrator/src/finance/shortline/watch.ts`），进程起来就挂着：连续竞价每 3 秒一拍、集合竞价与收盘竞价 15 秒（先把名单和交易日历焐热，09:30:00 就能立刻判）、午休 60 秒；盘前和收盘后不采，直接睡到 09:16。页面退化成纯消费者：开着就刷新，切走只影响显示。
- **不重复采、不重复记**：页面请求和后台采集走同一条路（`pollShared`），在途共用一份、2.5 秒内不重算；同一数据目录起了两个后台时靠 `<数据目录>/shortline/collector.lock` 只让一个进程采（持有者崩掉、超过 90 秒没动会被抢过来）。
- **失败退避**：取数失败按 3→6→…→60 秒退避，同一个原因不重复刷日志；采集起不来只记一行，不影响别的功能。
- **契约**：Core 的 `Plugin` 新增可选 `onStartup`（`plugin.ts`），由 `api.ts` 的 main 调用，金融包在 `finance/plugin.ts` 接上采集 —— Core 里不再出现垂类 import（core_purity 第 8 条）。`VRA_ALERT_COLLECTOR=off` 可关。
- 页面副标题、空状态文案和 README 同步改成「后台自动采、页面关着也在采」。

### 测试

- 新增 `test/page_saved_llm.test.ts` 9 条：优先级（没存 → `config.json`／存了 → 页面那份／清掉 → 回落）、命令行与 `VRA_PROVIDER` 压过页面配置、坏文件报错且**不**偷换成另一家、定时任务拿到的来源指纹就是页面那份、`productInfo` 报 `provider_source: "page"`、下发状态不含 key（端点里的 userinfo/query 也抹）、落盘前校验被拒时不留任何文件、远程模式拒写、重复保存只留一份、文件权限 0600。
- 新增 `desktop/test/ai_jobs_sync.test.ts` 5 条：保存时确实 POST 了同一份给后端、后端拒时如实说「页面已保存／后台没存下」、清除时确实 DELETE、后端没删掉时说出来（那份还带着 key）。
- 新增 `test/shortline_collector.test.ts` 7 条：采集节奏、没人看也落盘、与页面共用不重复取/不重复记、非交易时段一拍不发也不碰锁、跨进程锁（不删别人的锁 / 抢死锁）、注册后的插件带 `onStartup` 且 `off` 能关。
- 新增 `runtime_environment.test.ts` 1 条：`fetchEnv()` 必带 UTF-8 声明、子进程真的收到、中文标题原样交回且没有替换符。
- 后端全套：无新增失败（基线 45 条既有失败照旧）；desktop 444/444；前后端类型检查通过。
- 实机：临时数据目录起一次服务，日志出现 `[collector] 盘中常驻采集已启动`；已收盘时段没有建 `shortline/` 目录（按预期睡到 09:16）。
- 本轮收尾复跑：`desktop` 全量 **448/448**、`market_state + market_score` **81/81**、前后端 `tsc --noEmit` 均 0 错；新增 `market_state_labels.test.ts` 4 条钉住「判据一字未动」。增量门禁 `test-delta.mjs` 无新增失败（Windows 沙箱既有失败基线不变）。
- 本轮（判据变更 / 锁健壮性 / 探针转正 / 门禁修复）：`desktop` 全量 **448/448**、`market_state + market_score` **88/88**、新增 `notify_lock.test.ts` **6/6**、前后端 `tsc --noEmit` 均 0 错；**最终 `test-delta.mjs` 无新增失败、退出码 0**。orchestrator 全量 1766 条里 41 个失败全部落在既有基线（Windows 沙箱 `EPERM symlink` 等），基线文件 `known-failures.json` 保持 45 条**未被修改** —— 没有用 `--update-baseline` 掩盖任何失败。
- 本轮（审计 P0 四项收口）：前后端 `tsc --noEmit` 均 0 错；`core_purity.test.ts` **8/8**；Python 定向 `test_eastmoney_pools.py + test_market_review.py` **31/31**；Python 三套全量 **1682 passed / 2 failed**（两条均为 Windows 沙箱无符号链接权限的 `os.symlink` 基线，与本轮无关）；orchestrator 定向 6 个文件 **101/102**（唯一失败同为 `EPERM symlink`）；**最终 `test-delta.mjs` 无新增失败、退出码 0** —— 本次失败 41 条全落在 45 条既有基线内，1 条负载偶发单跑通过，`known-failures.json` 仍是 45 条未改。
  - 新增 / 加强的回归：`snapshot.test.ts`（`prefer_cache` 无上限时 1 小时前的快照必须判过期、刚取的仍命中；`DEFAULT_CONSISTENCY` 带上限；占位 0 不许进快照）、`opportunity.test.ts`（Core 缺省与 finance 兜底同源）、`shortline_history.test.ts`（历史路径不许再返回无上限 `prefer_cache`）、`shortline_review_job.test.ts` / `shortline_weekly_job.test.ts`（有缺口必须 `partial`）、`market_review_job.test.ts`（新增「正文生成了但台账没落进去 → 抛错」）、`test_eastmoney_pools.py`（6 条占位 0 路径都带 `no_cache`/`placeholder_zero`/`missing`；新浪备源署名）。
  - **本轮明确没做的范围**（审计 P1/P2，仍是「诚实 / 直观」这条线上的欠账，不影响上述四项结论）：`shortline_overview` GET 丢 `refresh`、`opportunity.ts` 子信号未透传 `refresh`、`watch.ts` collector 锁静默吞删除失败、`Opportunity.tsx` 三源全失败仍刷新 `loadedAt`、逐端点 TTL 覆盖率、README 的 raw 回收口径三处不一致、门禁未覆盖 desktop / Python / CI、新增文件未纳入版本控制。

- 本轮（P1 收口）：前后端 `tsc --noEmit` 均 0 错；定向五处 **88/88**；新增 `desktop/test/opportunity_freshness.test.ts` 2 条、`orchestrator/test/refresh_propagation.test.ts` 4 条、`shortline_collector.test.ts` 真注入删除失败 1 条（断言释放标记 + 显式告警 + 下一台采集器立刻接管，不等 90 秒）；**desktop 全量 450/450**；Python 三套 **1682 passed / 2 failed**（两条 `os.symlink` WinError 1314 权限基线）；**`test-delta.mjs` 无新增失败、退出码 0**（42 条失败全在 45 条基线内，1 条负载偶发单跑通过，`known-failures.json` 保持 45 条未改）。
- 仍未处理的 P2：逐端点 TTL 覆盖率 18/182；自动刷新多为 `load(false)`、不保证上游真重取；`BreadthBody` 可能把 0 显示成真值；`risk_level` 徽标与「抗跌度」并列仍有读反风险；`DailyReview` 无自动刷新；`release_version.test.ts` 不校验 git tag；门禁未覆盖 desktop / Python（README 已写明分工）。**缺腿压仓分档仍待样本**，不拿 15 份快照装回测。（**2026-11-08 已重新裁决：其中三条已修、三条是误读或设计取舍，以本段开头那条为准；保留原文以存历史。**）

- 本轮（行为测试升级 + 基线复核）：`refresh_propagation.test.ts` 从 4 条纯源码断言扩成 **3 条行为 + 4 条结构** —— 真调 `runView` / `shortlineOverviewAct`（注入假取数、不联网），实测 `refresh:"1"` → 10 次取数全 `fresh`、无参 → 全 `prefer_cache` 且上限均为有限正数；`runView` 原样把 `{refresh:"1",foo:"bar"}` 交给注册视图。新增 `test_delta_guard.test.ts` 3 条。定向 **10/10**、前后端 `tsc --noEmit` 0 错、`test-delta` 无新增失败且退出码 0、`known-failures.json` 保持 45 条未改。
- 仍未升级为行为测试的三处（诚实留白）：`shortline_overview` 注册闭包接线、机会链子信号 `force`、`day_opportunity` 的 gap 文案 —— 这三处依赖真实取数或 ESM 注入，目前只有源码结构断言，措辞一改就红，但**不能证明运行时真的生效**。实机探针留到下一个交易日。

## [2.1.4] - 2026-10-26

修独立安装的 CodeBuddy CLI 未登录时，WorkBuddy 已登录仍报未登录的问题（提交 `5d6d2e2`），移植自 Vibe Research v2.2.4 的同一修复（Vibe Research #56）；短线功能和页面用法都没有变化。

### 修复

- **独立版没登录，内置版已登录也用不了**：独立安装的 CodeBuddy CLI（npm 全局或官方原生安装）排在 WorkBuddy 内置 CLI 前面。原来取第一个存在的程序，不看登录；装过独立版但没登录时，WorkBuddy 已登录也一直报「没有可用的 WorkBuddy / CodeBuddy 登录」。现在自动选中的程序明确未登录、且没有用 `CODEBUDDY_BIN` 或设置页指定位置时，依次检查 WorkBuddy 内置 CLI：先查固定位置，Windows 再查「已安装的程序」登记，改用第一个已登录的。
- 设置页卡片和实际调用共用同一选择逻辑。检测失败、超时、版本过旧不回退；都没登录时状态和文案不变；回退过程中可以取消。
- #23 里另一种现象（卡片显示已登录、测试连接仍报未登录）还没在 Windows 上复现，不在本次修复范围。

### 测试

- macOS（2026-10-26）：同步 Vibe Research 的 6 条回归用例。用假 CLI 复现「独立版未登录 + 内置版已登录」：修复前报未登录，修复后连上内置版。
- 后端全套 1454 项：1446 通过、8 跳过、0 失败；desktop 406/406；前后端类型检查通过。
- 独立审查（Codex 6.1 Sol）通过。
- 没有 Windows 实机，也没有用真实已登录的 WorkBuddy 账号复验这一条。

## [2.1.3] - 2026-10-24

修 WorkBuddy 5.8 起「接入 AI」检测失败的问题（issue #23），移植自 Vibe Research v2.2.3 的同一修复；短线功能和页面用法都没有变化。

### 修复

- **精简运行包启动不了**：WorkBuddy 5.8 起内置的 CodeBuddy 程序（CLI 2.161.0）只带精简运行包，要环境变量 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 才能启动。我们起子进程时按白名单过滤环境，把它滤掉了，程序退出码 1，卡片显示「检测失败」。现在检测和实际调用时都固定带上它，其余环境仍按白名单过滤；旧版 WorkBuddy 和单独安装的 CodeBuddy CLI 由官方启动器自己回退到原运行包。安装位置没变，手动指定位置的功能不受影响。
- **新版登录信息被判成未登录**：新版返回的登录信息可以是 `uid` / `type` / `userId`、不带 token，旧代码会把已登录判成未登录。现在两种结构都认，ID 为空、不一致、控制响应失败或探针异常退出仍不算登录；没有会话隔离参数的旧版 CLI 遇到新结构时提示升级。

### 测试

- 同步 Vibe Research 的 5 条回归，修复前全部失败、修复后通过。
- 用 WorkBuddy 5.8.3 官方安装包里的程序实测：修复前检测失败（退出码 1），修复后能识别 2.161.0 并读到登录状态（测试时未登录）。
- 独立审查（Codex 6.1 Sol）通过。
- 没有 Windows 实机，也没有用登录了的 WorkBuddy 5.8.3 账号在本仓库复验；Vibe Research 在 macOS 真实登录下实测可用。

## [2.1.2] - 2026-10-18

补 v2.1.1 在 Windows 上收紧私密文件时漏掉的两处：文件上单独挂的拒绝规则、文件的所有者。是把 v2.1.1 的修复搬回 Vibe Research 时，独立审计（Codex 6.1 Sol）在回补补丁里发现的，这里和 Vibe Research 用同一份修复。短线功能和页面用法都没有变化。

### 修复

- **拒绝规则没删**：v2.1.1 改用 `icacls` 以后，文件上单独挂的拒绝规则不会被删掉，复查又只看允许规则。结果可能判了安全，当前用户自己却读不了这个文件，服务起不来。现在复查把拒绝规则也列出来，收紧时删掉。
- **所有者没改回当前用户**：文件的所有者不管权限怎么写，都能自己改权限。所有者是别的账户的话，它可以把读权限加回去，复查却判安全。现在所有者不是当前用户时改回当前用户（v2.1.0 的旧写法本来会做这一步）。
- 收紧时依次删掉别的账户的授权、删掉拒绝规则、改回所有者，然后再复查一次；还不干净照旧报错，不当成功。同步、异步两条路径都改了。

### 测试

- 新增复查结论的解析测试（拒绝规则、所有者），各平台都跑；Windows 上另有两条实测：文件上先挂一条拒绝规则、或把所有者改成别的账户，收紧后都必须只剩当前用户、能正常读取（拒绝规则那条还要能写入）。
- 所有者那条实测在 GitHub CI 上准备失败时直接报红，不跳过（测试机以管理员身份运行，设不成就是测试本身出错），只有本机没以管理员身份运行时才跳过。
- 对照实验在 Vibe Research 那边做过：用修之前的代码配新测试，Windows 两项里恰好是新加的 2 条变红。修复补丁另请 Codex 6.1 Sol 复核一次：两处都修好了，没有新的严重或中等问题；它另提的一条小问题就是上一条（原来准备失败时会跳过，可能显示通过但其实没测），已改。
- CI 的 Windows 两项里，私密文件的 5 条实测都实际跑了，全部通过；日志显示测试机上新建文件的所有者是 Administrators 组，收紧后改回了当前用户。
- 没有 Windows 实机，没以管理员身份运行时的收紧、改所有者没有实测。

## [2.1.1] - 2026-10-18

修 Windows 上的几个启动和使用问题，修复来自社区 PR #22（感谢 @Boomyuan，提交保留原作者署名），发版前做了独立审计，审计发现的问题已一并修掉。短线功能和页面用法都没有变化。

### 修复

- **Windows 上用 npm 装的 Claude Code、CodeBuddy 启动不了**：原来只认「node + .js」这一种 npm 启动器。新版 Claude Code 的 npm 包直接指向 `claude.exe`，CodeBuddy 的 npm 包指向没有扩展名的 `bin/codebuddy`，两种都会报「仅支持原生 CLI 或标准 npm 启动器」。现在两种都能用。
  - 启动器里写的目标必须在它所在的安装目录里（项目内 `node_modules/.bin` 的启动器可以指向上一层 `node_modules`），写成 `../` 跳出去、或换成别的盘的路径都会拒绝；目标不存在、路径里带变量的照旧拒绝。
  - 没有扩展名的入口，第一行必须是指向 node 的 `#!` 才放行。
- **Windows 上没以管理员身份运行时，可能报「无法收紧 Windows 文件权限」、启动不了**（PR 作者在实机上遇到，我们没有 Windows 机器复现）：访问口令、SEC 联系方式等私密文件原来用 PowerShell 的 `Set-Acl` 收紧，它会连审计设置一起写回，普通用户没有这个权限。现在改用系统自带的 `icacls`：断开继承，只给当前用户（按 SID 指定）完全控制，文件上别的账户单独挂的授权也逐个删掉（GitHub 的 Windows 测试机上新建的文件就直接带着 SYSTEM、Administrators 的完全控制，只断继承删不掉）。收紧后马上复查，还有别的账户、或当前用户自己没有完全控制，就直接报错，不当成功。
- **CodeBuddy 回答里混进 `<think:…>` 推理标签**：交给页面前清掉；清完什么都不剩的，按「没有返回可见回答」报错。
- **Windows 上取消研究时偶尔报「进程树退出未确认」**：强制结束后的确认时间从 2 秒放宽到 5 秒，期间每秒补一次强制结束；macOS / Linux 一确认退出就返回，不再固定等 2 秒。
- **临时文件夹偶尔删不掉**：删除重试从累计 1.5 秒放宽到 2.8 秒（7 次，每次多等 0.1 秒）。重试期间程序会停住，所以没有再往上加。
- **自选页行情没取到时名称显示成代码**：现在用自选记录里存的名称；排序、鼠标提示和下面 K 线的标题也一样。

### 不收的部分

PR #22 里另外三块新功能这版不收：情绪周期状态机（和现有的「情绪周期」重叠，而且写成了加减仓的说法）、开盘啦 / 短线侠 / hhxg 三个盘外数据源（App 抓包接口和别人加工过的指标）、WxPusher 微信推送（要另外注册、消息经第三方转发）。

### 测试

- 新增：exe 型和无扩展名两种 npm 启动器、跳出安装目录被拒（`../`、名叫 `.bin` 但不在 `node_modules` 下）、项目内 `.bin` 照常可用、`whoami` 的 SID 解析、权限复查结果解析、推理标签清洗、自选名称兜底；Windows 上另有两条：文件上先挂着 Users、Guests 组的授权，收紧后必须只剩当前用户；当前用户只有「读取权限说明」时复查不算安全，收紧后改回完全控制。
- 关键改动做了变异检查：把修复改回去，对应测试必须变红。
- 发版前一轮独立只读审计（Codex 6.1 Sol）发现 5 条：权限收紧后没复查、启动器能用 `../` 跳出目录、删除重试实际累计 19.5 秒、名称兜底只接到了排序，这 4 条已修；推理标签没闭合或有嵌套时清不干净，这条不改（原来是连标签一起原样返回，现在只会更少；CodeBuddy 实际的输出格式不清楚，硬删可能把正文也删掉）。修复补丁另做一次复核（Codex 6.1 Sol）发现 3 条，修了 2 条（名叫 `.bin` 的任意文件夹也被放宽、测试往公共临时目录写文件）；自选页没有整页渲染测试，这条不补。
- 推上 CI 后 Windows 两项失败：新建的文件收紧后复查发现还授权了 SYSTEM 和 Administrators（见上面「修复」第二条）。改成删掉其他账户的授权后，这次补丁又请 Codex 6.1 Sol 复核一次，发现 1 条（当前用户只有一条不能读内容的授权时也会判安全），已修。
- 没有 Windows 实机，Windows 上的行为靠 GitHub 的 Windows 测试机验证，那里以管理员身份运行，测不到「普通用户」那一条。

## [2.1.0] - 2026-10-11

合入 [Vibe Research v2.2.1](https://github.com/simonlin1212/Vibe-Research/releases/tag/v2.2.1)（v2.2.0 及本版审计发现的修复）：报告里找不到出处的数字遮掉、报告标为不完整；回测最后一天卖不出去的持仓不再编一笔卖出；持仓收益率里没填费用的买卖按 0 算并写明。另外「核对」和短线复盘记录只能在自己的页面里改，不能再经通用台账接口改写。短线页面的用法没有变化。

### 改动

- **报告里找不到出处的数字遮掉，报告标为不完整**：
  - 报告里没引证据或计算编号的数字，交付前在本次取到的数据和计算里找出处。数据原文里有，或按写出来的位数和单位能和某条数据、某个计算的输入对上，都算有出处。同一行引了本次用到的用户资料的，资料片段里有这个数、按位数和单位对得上也算（资料写 120.5 亿元、报告写 120.5 万元不算；资料里的「百万港元」「billion」「个百分点」按写的量级读）。
  - 找不到的只把数字本身换成「〔未核实〕」，报告开头加一句说明有几处，运行状态记为「不完整」（运行记录新增 `unverified_numbers`）。
  - 日期、编号、写明「假设 / 如果 / 若按 / 情景」的行、表头写了「情景 / 假设」的表格不查；「数据缺口」一节（标题带序号或后缀也算）不查。「31.2%-35.8%」这类区间按两个正数查；「31.2-35.8 亿元」「31.3 至 35.8 亿元」左端按右端写的单位查，「999-1,500 亿元」这类整数左端借到单位后也要查。
  - 上线前拿 Vibe Research 本机 9 份历史报告试过：一处都没遮；随机造的数字被误认成有出处 11/2700（0.41%）。
- **回测最后一天：卖不出去的持仓不再编一笔卖出**：
  - 原来回测结束时不管能不能卖，都按收盘价平仓、扣卖出费用、净值换成现金。
  - 现在能卖的照旧按收盘价平仓。下面几种留着，按最后一天收盘价计入期末净值，不扣卖出费用：
    - 最后一天没有行情（停牌或数据源缺行）；
    - 最后一天才买进（T+1 当天不能卖）；最后一天加仓的，原有部分照常按收盘价平掉，只留加的那部分；
    - 最后一天收盘封在跌停价（有不复权价时按交易所规则取整到分比较）。
  - 报告的口径披露里并成一条，写明是哪几只、什么原因，并说明胜率、盈亏比、交易次数等按平仓记录算的指标不含这些持仓。指标里新增 `unsettled_positions`。
- **持仓收益率：没填费用的买卖按 0 算并写明几笔**：说明里写「费用合计偏少，收益率可能偏高」，结果里新增 `trades_without_fee`。明确填了 0 的不算。（交易日志照旧按费率估费用并标「估」，不受影响。）
- **「核对」和短线复盘记录只能在自己的页面里改**：台账种类新增 `managedWrites` 标记。核对、短线复盘、短线周复盘三种只能经各自页面的专用接口写入（「从旧版导入」照旧能把旧版记录连同原写入时间导进来），通用台账接口（`POST /ledger/:kind` 和 `/ledger/:kind/delete`）对它们返回 `managed_kind`。原来通用接口能绕过核对记录 09:15 之后不能改的限制和写入时间戳。

### 修复

- **算式核对**：「≈」按写出来的位数比，「≈ 2200」按百位取整算对，放宽不超过结果的 5%、不低于个位的半格（「30 ÷ 49 ≈ 100%」仍算错，「10 ÷ 3 ≈ 3 倍」算对）；原来和「=」一样严，两位有效数字的近似会被标成算错。
- **产出红线检查按段落再查一遍**：同一段里换行写开的词、跨行写的链接，页面上显示是连着的，逐行查却拼不出来。现在逐行没命中的连续几行拼起来再查，命中就整段去掉；连续的引用行算同一段。
- **提醒对比**：evidence.json 里每条证据的编号、字段、单位、期间、来源都要在，值的键也要在，否则直接报错。原来只查字段名，缺了值的两份证据会显示「无变化」。
- **数字闸门**：「A ÷ B − 1 ≈ R」里的「1」不再当成要有出处的数。
- **两融、股东户数、海外资金流**：两融最近几天的余额和买入额、股东户数、海外资金流最新一天的主力净流入缺了时，结果标为部分结果、写明缺哪天哪个字段，不再判成完整。
- **WorkBuddy 识别（Windows）**：问系统的超时从 15 秒放宽到 30 秒。冷启动加杀毒软件扫描时 PowerShell 可能更慢，GitHub 的 Windows 测试机上实测超过过 15 秒。
- 运行列表页的说明改成中性文字；核心代码的中性词表补上「金融」「投资动作建议」，相关注释跟着改写。

### 测试

- 每条修复都补了测试；关键修复做了变异检查：故意改回去，测试必须变红。
- 发版前两轮独立只读审计（Codex 6.1 Sol、Opus 5.5）：确认 4 条（资料按裸数字核对、区间左端单位、「≈」放得太宽、回测工具漏传 `unsettled_positions`），都在合入的 Vibe Research v2.2.0 代码里，已修并随 Vibe Research v2.2.1 一起发布。修复补丁另做了一次独立复核（Opus 5.5），找到 6 处（1 处是修复带进来的，5 处没修全），已全部修掉；15 处变异检查全部变红。
- 回测期末：最后一天才买、最后一天加仓、收盘跌停、低价股按分取整的跌停、最后一天没有行情、正常平仓都有测试。
- 核对封口：只有那三种台账带标记；通用接口写和删都返回 `managed_kind`，原有记录不动；读和其他台账照常。

## [2.0.1] - 2026-10-11

和 [Vibe Research v2.1.1](https://github.com/simonlin1212/Vibe-Research/releases/tag/v2.1.1) 同步修两个启动问题：Windows 上 WorkBuddy 装在别的盘或自定义文件夹时识别不到（Vibe Research #50）；默认端口被占用或被系统保留时启动不了。
另外修了 Windows 上偶尔有一路东财数据报错的问题。短线功能和页面都没有改动。

### 修复

- **Windows 上 WorkBuddy 装在别的盘或自定义文件夹时识别不到（Vibe Research #50）**：原来只看几个常见安装目录。现在这些位置都没有时，会再问系统两处：
  - 「已安装的程序」登记：卸载信息里的安装目录、图标所在文件夹、卸载程序所在文件夹。Squirrel 式安装的程序放在 `app-<版本>` 子文件夹里，会取最新版本。
  - 正在运行的 WorkBuddy.exe 所在文件夹。
  - 登记的名字里没有 WorkBuddy（比如只有中文名）也行：安装目录或图标路径里带 WorkBuddy 就算。
  - 只看当前登录用户的 WorkBuddy 进程，别的 Windows 用户开着的不算。
  - 只读这两类信息，不改任何东西：
    - 用系统自带 PowerShell 的绝对路径，查询脚本明文传入（不用常被杀毒软件拦的编码方式）；
    - 从 PowerShell 7 里启动时，去掉继承来的模块路径，免得系统自带的 PowerShell 加载出错；
    - 结果按 UTF-8 交回，中文路径不受控制台编码影响；
    - 15 秒超时，PowerShell 被拦时按没找到处理。
  - 找到的位置记在后台；没找到时，发起对话 30 秒内不重复问系统。设置页的检测和「重新检测」每次都重新问，刚打开或刚装好 WorkBuddy 时马上能认出来。
  - 手动填安装文件夹时，也会看 `app-<版本>` 子文件夹。
  - 「未安装」提示改为：先打开 WorkBuddy 再点「重新检测」，或在下面填它的安装文件夹。
  - 检测失败时说清楚卡在哪，不带 CLI 自己的输出（可能含账号信息）：
    - 超时：第一次启动或杀毒软件扫描时较慢，稍后重试；
    - 程序起不来：带错误码；
    - 登录状态检测失败：带退出码。
- **端口限定太死，默认端口被占用就启动不了**：
  - 页面默认 5940、本机 API 默认 8770 不变。默认端口被别的程序占用，或被系统保留时，会自动换端口。
    - 被系统保留的常见情况：Windows 上 Hyper-V / WSL 会整段预留端口，绑定时报权限错误。
    - 按固定顺序找：先往后 20 个，再试 +1 万、+2 万、+3 万、+4 万各 20 个，都不行才让系统分配。
    - 顺序固定，同样的占用情况每次换到同一个端口。
    - 终端会说明换到了哪个端口，浏览器打开的就是实际地址。
    - 源码版（macOS / Linux / Windows）和免安装包都一样。
  - 换了页面端口时，终端会提醒：「接入 AI」里的模型 API 设置和对话记录存在浏览器里、按地址分开，在新地址要重新设置；默认端口空出来后重启，就回到原来的地址和设置。
  - 默认页面端口，或紧挨着的 20 个端口上（上次换过去的），已经开着一个 Vibe AStock 时，提示直接打开它，不再起第二个。
  - 局域网模式（`VRA_LAN=1`）下页面监听所有网卡，选端口时本机回环地址也要空着。
  - 新增 `--port` / `--api-port`（Windows `-Port` / `-ApiPort`），或用环境变量 `VRA_UI_PORT` / `VRA_API_PORT` 固定端口。
    - 自己指定的端口不能用时直接报错，不擅自换。
    - 两个端口不能相同。
  - 远程访问模式的页面端口不自动换（云平台映射的是固定端口）。被占用时报错，并提示用 `--port` 换成平台开放的端口；本机 API 端口照常可以换。
  - 换访问链接（`--rotate-access`）时两个端口都不自动换：端口被占说明旧服务还在跑，要先停掉它，旧链接才会失效。
  - 选好的端口经 `VRA_UI_PORT` / `VRA_API_PORT` 传给页面服务和 API。页面代理、提醒推送里的「打开」链接、远程访问的链接提示都跟着走。
  - Windows 启动器（`start.cmd`、免安装包）启动完成后，在窗口里打印实际地址。
    - 选端口的说明都写在标准输出，免得 Windows PowerShell 5.1 把它当错误中断启动。
    - 在自己的 PowerShell 窗口里直接运行时，退出后还原端口环境变量，下次启动不会被当成「指定了端口」。
    - 仓库放在符号链接或目录联接下面时，选端口和就绪检查也照常工作。
- **Windows 上偶尔有一路东财数据报「Permission denied」**：几个取数程序同时抢东财的限流锁时，后到的一个会在拿到锁之前往锁文件里写一个字节，而 Windows 的文件锁不许别人往锁住的位置写，这一路取数就报错（跨平台 CI 的 Windows 机器上撞到过一次）。改成拿到锁之前不往锁文件写任何东西。

### 测试

- 新增端口选择测试：
  - 参数和环境变量的优先级；
  - 被占用和被系统保留时按固定顺序找（近处、远处各段、49151 上限）、再让系统分配；
  - 换端口时的浏览器设置提醒；
  - 指定端口报错，换访问链接时 API 端口也不换；
  - 已在运行的识别（默认端口和紧挨着的那段），局域网模式回环地址检查；
  - 真实端口探测；
  - 命令行入口（输出全在标准输出、经符号链接运行）和 Windows 启动脚本（环境变量还原）；
  - 就绪检查经符号链接运行时真的去查。
- 关键修复都做了变异检查：故意改回去，测试必须变红。
- 免安装包冒烟改为先占住 5940，三个平台都要自动换到后面的端口并正常起来（在后面 20 个里挨个问健康检查，不猜具体是哪个）。Windows 的跨平台 CI 也加跑端口测试。
- 新增 WorkBuddy 查找测试：
  - 系统登记解析（引号、图标序号、带参数的卸载命令、网络路径、控制字符、去重）；
  - `app-<版本>` 排序；
  - 只在 Windows 上问系统；
  - 没找到的记忆、重新检测、并发合并；
  - 失败提示不带 CLI 输出；
  - 系统查询只读、明文传入、去掉 PowerShell 7 模块路径、只看当前会话进程。
- 其中 3 条只在 Windows 上跑：在临时的中文文件夹里摆好 WorkBuddy 的目录结构，分别写一条真实的「已安装的程序」登记、起一个真实的 WorkBuddy.exe 进程、摆一个 Squirrel 式安装，检查都能找到；登记那条用不含 WorkBuddy 的中文名、并模拟从 PowerShell 7 启动，还要检测为可用；Squirrel 那条还要手动填安装文件夹也能找到。
- 新增 Windows 东财锁测试：模拟 Windows 的加锁调用，加锁那一刻锁文件必须还是原样（没被提前写入）；改回原来先补写再加锁的做法，测试变红。

## [2.0.0] - 2026-10-11

整个产品换到 [Vibe Research](https://github.com/simonlin1212/Vibe-Research) v2.1.0 的同一套底座上重做，再把短线功能搬过来、补齐：
盘中在「盯盘」看持仓、自选和昨日梯队的异动；收盘后在「情绪复盘」看情绪读数，让 AI 分五段写复盘，写下明天要验证的条件，下一个交易日收盘自动对账；
自己的每笔交易记进「交易日志」，按入场那天的情绪和板位回头自查；用过旧版的可以把数据导进来。
接入 AI、远程访问、免安装包、新版提示，以及个股深挖、回测、产业资讯、产业研究等栏目都和 Vibe Research 一样。

旧版 v1.x 是 Python 程序（数据在 `~/.duanxian-agents`，页面在 8910 端口），新版是另一套程序，不能原地升级，见下面「从旧版升级」。
没有单独发布过的 v2.0.0 开发版（拆掉 Codex 底座）的改动已经包含在本版里。

### 从旧版升级

- 重新克隆仓库或下载免安装包，按 README 的「快速开始」安装。旧版的文件夹和数据目录不用删，新版不会改动它们。
- 页面地址从 `http://127.0.0.1:8910` 换成 `http://127.0.0.1:5940`（本机 API 在 8770），和 Vibe Research 的 5930 / 8765 错开，两个可以同时开，
  接入 AI 的设置、对话记录和登录状态也不会两边混用（登录 cookie 改用 `vibe_astock_` 开头的名字：浏览器的 cookie 不按端口分开，同名时远程访问会互相顶掉登录）。
- 旧版数据：到「接入 AI」页最下面的「从旧版导入」，先预览、再导入。能导的有交易记录、交易日志设置（费率、规矩、账户规模）、模式卡（带全部版本）、
  AI 复盘、明日验证条件、盘中快照和个股深挖；导入前自动备份涉及的台账文件，旧版的文件只读。不导的（方向命中评估、涨停池存档、各种缓存、回测结果、
  被拒的复盘）在预览里列出数量和原因。旧版设过 `ASTOCK_DATA_HOME` 的，导入时默认去那里找。
- AI 要重新接一次：Claude Code、Codex、WorkBuddy 订阅直接用本机已登录的官方 CLI；旧版产品专用的 Codex 登录不再使用。
- 旧版的启动方式（`scripts/manage.py`、`启动 Vibe AStock.command / .cmd`）和 `VIBE_ALLOW_HOSTS` 不再使用；局域网和远程访问的开法见 README。

### 新增

- **盯盘 · 实时动态**：持仓（现价、今日涨跌、浮动盈亏 %）、自选、昨日梯队（按板位筛、封没封）、500 亿以上大票涨幅前十和跌幅前五、昨日成交额前十。
  盘中异动规则照旧版：3 分钟涨跌 ≥ 1.5% 记急拉 / 急跌，碰到 / 离开涨停价记封板 / 开板，同一只同一类 5 分钟内不重复；只在连续竞价时段判断，
  竞价和午休清零窗口与封板状态；当天的异动存在本机，重启后接着显示，可按幅度和范围筛。
  连续竞价时每 3 秒取一次（大票 30 秒），其余时段 15–60 秒；开几个窗口都只取一份；页面切到后台就停，并写明「已暂停」。
- **盯盘 · 竞价与盘中**：昨日涨停股 09:25 的竞价强弱（中位、高开占比、分板位、最高标），09:25 / 09:35 / 10:00 / 11:30 / 14:00 / 15:00 六个时点的情绪路径，
  以及昨晚写的明日验证条件的盘中读数（标「暂」，以收盘为准）；可以回看以前的日子。快照由定时任务到点自动存（失败的同一时点最多重试 6 次），
  时点窗口里也可以手动存一张；过了时点补不回来；周末、节假日各时点标「休市」。
- **情绪复盘**（复盘一组排第一，8 个分页）：
  - **今日情绪**：赚钱效应、晋级率、连板溢价、梯队断层四项读数，连板天梯，情绪周期，昨日强势股反馈，封板质量，题材事件树，首板名单。
    连板天梯按东财连板数分层，每层列出有谁（首封时间、炸板次数、题材），写「4进5 1/3」这样的晋级数（和晋级率卡片同一个算法、对得上），
    昨天下面一层没接上的写今天的去向（跌停 / 炸板 / 没涨停）和涨跌幅；断板后又涨停的标「N天M板」。前一交易日的池子没取到时只列名单，晋级写明算不了；
    有票的去向、涨跌幅或涨停原因没取到时标「部分」，不长期缓存。
  - **AI 复盘**：情绪、资金、题材、龙虎榜、龙头五段各开一个新对话、只看自己那几块数据，最后写汇总并建议明日验证条件，一键加进「明日验证」。
    每个数字由程序分三档核对（对得上资料包 / 写了算式且重算通过 / 没交代出处，算式对不上标红），证据编号逐个核对，「查看依据」悬停看原行。
    复盘日之后的数据不进资料包；每写一次存一版，不覆盖旧版。
  - **AI 周报**：选中那天所在的一周，情绪走势、题材轮动、验证回看三段加汇总，核对方式同 AI 复盘；开头写明本周休市的工作日。
    「本周我的交易」卡片从交易日志在本机算，只在页面显示，不进 AI 资料包，也不进页面上下文。
  - **近 5 天**（热度、题材轮动与龙头谱系，龙头走势用前复权日 K）：题材轮动是近 5 个交易日每个题材每天的涨停只数和名次，
    标出连续几天、隔几天回流、这几天第一次出现、昨天还在今天退下去的；某天没取到画「—」、按缺数处理，跨过它的「连续」「回流」注明说不准；
    某天有沪深涨停股没有涨停原因，那天没出现的题材也画「—」、出现的只数是下限（北交所同花顺不收录，写在口径里，不算缺）。
  - **情绪历史**（每日读数的历史分位、跟前一天比）、
    **明日验证**（收盘后写下一个交易日的方向条件，下一场收盘自动对账，给基准发生率和近 60 个交易日的战绩）、
    **涨停样本**（昨日涨停股次日表现按打法、封板时间、入场日情绪分组，可选近 20 / 30 / 60 / 90 天）、**结构变化**（近 10 个交易日对比之前 20 个，可登记制度事件）。
- **交易日志**（一级栏目，排在复盘后面，4 个分页）：
  - **交易记录**：成交只记在「我的股票」的交易流水里，一份账；同一代码从空仓买进到卖光算一笔，自动对上入场那天的情绪强中弱和当时板位
    （首板、连板、炸板、没碰涨停，带炸板次数和行业）；按情绪环境、板位、打法、是否按计划、持有天数分组看胜率和平均每笔；没有成交明细的可以只记盈亏 %。
  - **风险与纪律**：按计划止损估算的在险资金、权益曲线、近 10 / 20 / 50 笔、计划外交易的代价、自己的规矩逐条检查。
  - **复查**：值得回头看的单子、最大浮盈浮亏（腾讯不复权日 K）、看错还是没做好（入场日对照前一晚的明日验证）。
  - **模式卡**：把打法写下来，改了从次日起算新版本，按版本分段看业绩。
  - 算法照旧版：移动加权平均成本、胜率不算持平；费用没填的按费率估并标「估」。隐私模式遮金额、股数和自己写的价位，
    编辑框和补成交的输入框也按密码样式显示；隐私模式下不画权益曲线（曲线的高低就是每笔盈亏的大小）。
  - 只算 A 股股票：ETF、可转债等其他六位代码和港美股的流水只计入持仓，不进交易日志（费用、印花税、T+1 都是按 A 股股票的规则算的）。
  - 个人交易数据不发给 AI：交易日志页不登记页面上下文，右下角 AI 显示「这一页还没有可聊的内容」。
    成交和持仓也一样（和 Vibe Research 不同）：持仓页只告诉 AI「这页的数据不提供」；盯盘、候选池、事件日历给 AI 的内容去掉只因持仓才出现的股票；
    AI 在对话里读台账（也包括经 MCP 接入的本机 CLI）拿不到成交、持仓、清仓、交易标注、交易日志设置和模式卡，返回里写明哪几种没给。
    例外：自选和持仓的「从截图或表格识别」是你自己选中、上传的文件，会发给当前 AI 识别（和 Vibe Research 一样，识别结果核对后手动确认才保存）。
- **从旧版导入**：见上面「从旧版升级」。导入前先按新版规则预演：会算不了的、已记的标注会被顶掉的、和已记的成交一模一样（可能记重）的，预览里先列出来；
  不合新版规则的（读不出的文件、符号链接、超过 30MB、卖出超过持有、代码或价格不对、B 股等）跳过并写原因。可以重复导，导过的按来源跳过。
- **14 个短线数据端点**：情绪四项、情绪周期、每日读数、六张事实表、连板天梯、题材事件树、近 5 天题材轮动、首板名单、昨日涨停股当日表现、涨停结构、
  盘中情绪、昨日梯队、成交额前十、大市值股（`cn_shortline_*`）。数据端点从 168 个增加到 182 个（35 层）。已收盘的日子长期缓存；没收盘的一天标「部分」，不缓存。
- **定时任务**：「短线收盘取数」15:35 把当天定稿的情绪读数、涨停样本、涨停结构、事实表和连板天梯先存到本机（东财这几张池只留约一个月，存下来以后一直能看）；
  交易日 09:25 起六个时点自动存盘中快照。
- **盘前提醒**（定时任务，默认 09:05，进收件箱）：隔夜美股三大指数、A50 期指较前结算、美元兑人民币；前一交易日 2 板及以上的连板股
  今天在不在停复牌名单里，以及板数最高的 20 只的新公告标题（标题里有停牌、异常波动、问询、减持这类字眼的排前面并标出）、按交易所规则推算离严重异常波动较近的
  （只用前一交易日及以前的日 K；近 30 个交易日已达到过的写日期；以交易所公告为准）；今天申购和上市的新股（读新股日历全表）。
  只列事实；哪项没取到写明，不当成没有；设在上午、拖到 11:30 以后才补跑的不发，用户自己把时间设到中午以后的照发。
- 连板天梯、题材轮动和盘前提醒的做法参考了 GitHub 上几个 A 股短线开源项目（只借思路，没有搬代码）。

### 修正（相对旧版）

- 主板 ST 涨跌幅 2026-07-06 起是 10%，旧版一律按 5% 判；现在按日期判。创业板 2020-08-24 前按 10%。
- 炸板池取不到时，旧版按 0 家炸板算，炸板率成了 0%；现在这一天整天不算。前一交易日涨停池取不到时，晋级一列标「未算」，不出 0。
- 分制度生态表：当天没有涨停的制度，炸板数、跌停数恒为 0（例：2026-10-09 北交所 1 家炸板被写成 0）。
- 1进2 统一口径：旧版每日读数和情绪四项对「昨天首板、但不在昨日涨停池里」的票处理不同，同一页会出现两个 1进2。
- 不给日期时默认最近一个已收盘交易日（旧版是今天）；未来日期和非交易日直接拒绝，不再算出「涨停 0 家」。
- 东财涨停池在周末、节假日、开盘前会回最近一个交易日的池子，旧版首板页因此把周六当成日期；现在按交易日历取，没数据的日子按空池处理。
- 问财出错时整棵题材树不可用：现在改走同花顺涨停揭秘并说明原因；首板页的问财查询也核对场次；问财翻页上限从 3 页（静默截断）提到 10 页，翻满还没完当失败；
  不再假定问财每页给 50 条，翻到空页、比第一页短或没有新票才停；题材串截断不再留下半个词。
- 成交额前十改用通达信盘后包（任意交易日都能取），大市值股改用新浪按市值排序：旧版都靠东财列表接口，2026-09-22 起成片失败。
- 昨日梯队空池不再当成「0 只涨停」（东财这几张池只留约一个月，超出就回空）。
- 大市值股：新浪还没翻到市值门槛就遇到空页时报名单不全，不再当完整名单交出。关键事件缺涨跌幅时留空，不再显示 0.00%（旧版同样写 0）。
- 明日验证：下一场 09:15 以后写或改的条件标「事后」，照样对账但不进战绩（旧版只看写入日期）；对账那场没收盘时标「暂定」；
  每晚每个读数只留一条，没改的不重写。
- 涨停样本：是否再涨停按那一天的涨跌幅制度判；那天没收盘不进统计；入场日情绪分缺炸板率时不再当 30%，归「环境未覆盖」；并列行业按行业名排。
- 结构变化：涨停按当天的涨跌幅规则归类；跌停池为空不再标「部分」（标了就永远不进缓存）；字段清单变了列出新增和消失的字段；
  占比恰好变化 0.10、容差恰好相等时的浮点误差已加余量；制度事件可以登记未来日期（标「还没施行」）。
- 龙头谱系走势改用前复权日 K（旧版不复权，分红送转会算出假跌幅）；同高的最高标按首封时间排、每天最多列 5 只并给总数。
- 交易日志：纪律归因各组的胜率和连亏之后的胜率不再把持平算进分母；没有成交明细的补记核对「最多同时持仓」时当缺日期，复查清单里算「已结束」；
  模式卡文字超长直接拒收并说明字数（旧版悄悄截断）；最大浮盈浮亏只算卖光了的一轮，期间有送转的整轮不算，卖出当天收盘前的行情先标盘中价、收盘后重取，
  没算的分没卖光、送转、北交所、行情没取到四类报。
- 看错还是没做好、按情绪环境分组改用明日验证和每日读数，不再依赖 AI 复盘写的情绪档位；情绪强中弱在你自己交易过的日子里三等分，页面写明是相对的。
- 盘中情绪另给与复盘同口径的 1进2 和昨日涨停股此刻的中位涨幅。

### 修正（底座共用部分，可以还给 Vibe Research）

- 东财涨停、炸板、跌停、昨日涨停池端点在周末请求时把最近一个交易日的池子标成请求日期。
- 多空辩论读端点说明读错位置（顶层没有 `degraded`，在 `extra.degraded`），素材缺口永远是空的；情绪历史同样修正。
- 算式核对：「A−B=R 亿元」（数量级只写在结果上）被判算错；十项合计只认最后两项；上榜理由、缺口说明、封板时间里的数没算出处。
- 导入交易流水时写了不存在的日期（如 2025-13-01），预览直接报错 500。
- 本机端口集中写在 `brand.ts`，启动器、Windows 启动脚本、页面服务器、免安装包和设置页提示都从这里取。
- 东财涨停、炸板、跌停池：接口回业务错误（`rc` 不为 0）或请求日期晚于上游的行情日时报错，不再当成空池写成「0 家」；涨停池、昨日涨停池为空（超出东财约一个月的保留期）不写成「0 只」；
  09:25 集合竞价撮合之前请求当天的池子直接报还没开盘，不发请求（上游开盘前什么时候切到今天没实测过，先切日期、池子没清的话会把昨天的池子当成今天）。
- 融资融券、股东户数、分红送转、个股资金流：上游没给的字段留空，不再写成 0。
- 东财板块排行、成交额榜：分页中途断了（空页或短页）标「部分」并写明拿到几条，原来静默交出半份榜单。RSS 新闻有来源失败就标「部分」，原来只要有一条新闻就算齐全。
- 申万行业变迁史：查过去某天时，那天之后才计入的调整不进变迁史和变更次数。
- 算式核对：运算数写明了「元 / 股 / 倍」时按那个单位算，不再按结果的「亿」去读（原来「2 元 + 3 元 = 5 亿元」会被认成算对）；只有结果写了数量级时，按字面算、结果换了个单位写的（「5 × 2000 = 1 万」）也认对，原来被标成算错。
- 数字核对：「上升 / 增加」这类正向词后面配负值证据算对不上（原来负增长写成「上升」也算对上）；「亏损增加」「跌幅扩大」这种反向说法照旧。
- 分段写的 AI 任务（本版的 AI 复盘、AI 周报）开工后，后台默认的 AI 来源被改了就停下，不让后面几段换个模型接着写。
- 回测独立检验：逐笔收益没有波动时夏普比率记「无定义」，不再记 0，也不给它的显著性；随机重排只用有定义的样本。
- 变化提醒：比较的证据文件缺失、写坏或结构不对时直接报错，不再当成空集合，报出「事实消失」或「没有变化」。
- A 股 K 线按北京时间的日期截取：海外时区的电脑原来会漏掉北京时间当天已收盘的日线。
- 定时任务：一拍里的任务排到午夜之后就停，留给下一拍按新的一天判断开不开市；时钟往回调、还没到点的不跑；同一天的开市判断同时只发一个请求（每拍钩子超时后，它要的判断可能还在路上）。
- 自选行情轮询：请求还在路上时切走再切回页面，不再多出一条轮询循环（越切越多）。
- 卡口事件硬测试：数据目录放在仓库外时找对规则表。
- 台账新增「整组替换」：一组记录一次落盘，中途出错要么全换、要么原样不动（明日验证整晚替换用它）。

### 移除

- 旧版 Python 程序（`duanxian/`、`review_agent/`、`vr/`、`frontend/`、`server.py`、`main.py` 等）和它的 Codex Harness 底座。
- 旧版「盘面数据」页的市场广度：改用底座现成的 `em_market_breadth`（旧版靠东财列表接口）。指数、资金、板块、解禁日历分别在「每日复盘」「事件日历」里。
- 旧版首页的「最近报告」：报告都在「资料库 · 研究记录」。

### 测试

- 本机回归（macOS，Node 26，2026-10-11）：编排器 **1397 项：1396 通过、1 项 Windows ACL 专项跳过**；前端 **404/404**；计算库 311、回测 574、取数层 774 全部通过。
  编排器类型检查、前端类型检查与生产构建、mypy（115 个文件）都通过。相对 Vibe Research v2.1.0，编排器多 172 项、前端多 58 项、回测多 3 项、取数层多 208 项；短线端点的测试都不联网。
- 新旧对账（旧版代码和新版各算一遍，同一批数据）：
  - 2026-10-09 的情绪四项、情绪周期、六张事实表逐项一致，例外只有上面修正的北交所炸板数；6 个交易日的每日读数 5 天一致，10-08 的 1进2 不同是口径统一。
  - 题材事件树（266 个题材）、首板名单（57 只）、昨日梯队（43 只）逐项一致。
  - 交易日志：随机生成的交易记录（交易记录与分组 1600 组、风险部分 4500 组、模式卡与最大浮盈浮亏 900 组）新旧逐项一致；上面列的有意改动按新口径换算后再比。对账脚本本身也故意改坏过，确认能报出差异。
- 发版前两轮全量审计（Codex 6.1 Sol、Opus 5.5，各审数据脚本 / 后端 / 前端 / 核心与外壳四个范围）：去重 50 条，修 42 条；另有 15 条待核实，修 6 条、联网实测推翻 2 条。没修的 8 条里 6 条是底座原有、应在 Vibe Research 修，1 条在文档写明，1 条待定。
  连板天梯、题材轮动、盘前提醒做完后另做两轮增量审计（同样是 Codex 6.1 Sol、Opus 5.5）：去重 9 条全修，另 4 条待核实修 2 条、1 条已被覆盖、1 条是有意的口径。
- 变异检查（故意改坏关键判断，看测试会不会变红）：短线取数、明日验证、涨停样本、结构变化、盯盘、交易日志、从旧版导入各改坏十几到几十处；审计修复每处都做过。
  没变红的只有走不到的防御分支（导入的流水都先校验过）和输入本来就按日期排好的排序。
- 真跑：AI 复盘和 AI 周报用 Claude Code 订阅给 2026-10-09 写过（复盘 4 版、周报 3 版）；明日验证用真实数据副本做过一次 10-08 写、10-09 对账；从旧版导入用一份真实旧数据的副本实测（复盘 18 版、明日验证条件 33 条、盘中快照 88 份、个股深挖 7 份；再导一次什么都不写），没动原件。
- 盘前提醒用真实数据手动跑过一次（2026-10-11，周日）。
- 没测的：盯盘还没在交易时段实测；盘前提醒还没在交易日 09:05 正点跑过；AI 复盘和 AI 周报没用 Codex、WorkBuddy、模型 API 跑过；Windows 实机。

## v1.1.3（2026-09-20）

### 自托管网关地址校验

- 未指定地址 `0.0.0.0` 重新纳入允许用 http 接入的范围。v1.1.1 依据 `is_private` 属性判断时该地址是允许的，v1.1.2 改为网段白名单时未将其列入，`http://0.0.0.0:8000/v1` 因此从 v1.1.2 起被拒绝 —— 网关监听所有网卡时启动日志打印的正是这个地址，用户会直接复制。白名单只列入 0.0.0.0/32 这一个地址，0.0.0.0/8 的其余部分仍然拒绝；IPv6 的未指定地址 `[::]` 不在放行范围内。
- 设置页的地址校验同步放行 `0.0.0.0`。该页的「测试连接并保存」按钮在校验不通过时为禁用状态，因此仅放开后端不足以让这个地址可用。设置页仍不接受 IPv6 唯一本地地址（fc00::/7），后端接受，使用该类地址的网关目前无法在设置页保存。
- 通过校验后，`0.0.0.0` 归一化为 `127.0.0.1` 再保存。两者作为目的地址等价，但 `0.0.0.0` 不在系统代理的默认排除名单内，设有 `HTTP_PROXY` 时请求会连同 `Authorization` 头发往代理；Windows 的 `connect()` 也不接受该地址作为目的地址。
- 端口越界或非数字时的提示改为单独一句，直接指向端口。此前与协议规则共用「地址须为 https（公网）或 http（仅本地回环/内网）」这一句，而这类地址的协议本身没有问题。

### 测试

- 后端三个目录 1287 项通过、4 项 Windows 专项跳过；前端 41 项通过；类型检查与生产构建通过。
- 新增路由归属测试：`/api/chat` 必须只由本仓库提供。`vr/app.py` 的同名路由在合并时被显式跳过，它自带的地址校验使用黑名单，不覆盖 IPv4-mapped 与 6to4 两种写法；去掉这行跳过等于绕开白名单，该测试将这行固定下来。
- v1.1.2 新增的端口测试中，两条公网用例补上 `provider`。此前这两条在到达端口判定之前即因地址不在名单内被拒绝，删除端口规则也不会使测试失败。

## v1.1.2（2026-09-20）

### 自托管网关地址校验

- 允许用 http 接入的范围改为显式网段白名单（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、::1/128、fc00::/7），不再依据 `ipaddress` 的 `is_private` 属性判断。此前按属性判断时，同一个云实例元数据地址换一种写法即可通过，且不同 CPython 版本能通过的写法不同：Python 3.9.6 上 IPv4-mapped 的 `::ffff:169.254.169.254` 其 `is_link_local` 为 False，Python 3.12.13 上 6to4 的 `2002:a9fe:a9fe::` 其 `is_private` 为 True 而 `is_link_local` 为 False，两种写法内嵌的都是 169.254.169.254。改为白名单后两个版本逐条实测行为一致。
- 白名单同时排除了此前会被放行的 0.0.0.0/8、240.0.0.0/4、198.18.0.0/15、203.0.113.0/24 等保留段。
- 端口越界或非数字时返回地址无效的提示。此前这类地址会抛出未捕获异常，接口返回服务错误，页面只显示请求未完成；内网分支则完全不检查端口。
- 设置页的内网地址判定改为整串匹配 IPv4 字面量。此前按前缀匹配，`192.168.1.1.evil.com` 这类公网域名会被当作内网地址而在表单校验中放行 http；后端一直拒绝这类地址，因此仅影响提示时机。

### 文档

- 中英文 README 与 `.env.example` 补充 `VIBE_ALLOW_HOSTS` 的用途与写法：改为监听局域网地址或挂反向代理时必须设置，否则全部接口返回 403。

### 测试

- 后端三个目录 1286 项通过、4 项 Windows 专项跳过；前端 41 项通过；类型检查与生产构建通过。
- 云实例元数据地址的边界测试补充 IPv4-mapped、6to4 与保留段写法；放行侧对白名单每个网段各有一条，删除其中任意一段都会使测试失败。
- 新增端口写错必须得到校验提示而非未捕获异常的测试，覆盖公网与内网两个分支。

## v1.1.1（2026-09-20）

### 局域网访问

- 经局域网 IP（而非 localhost）打开页面时，接入 AI 的状态轮询一律返回「复盘 Agent 仅支持本机访问」：复盘 Agent 路由的 Host 白名单写死为回环地址，没有跟随服务端已经读取的 `VIBE_ALLOW_HOSTS`。两处现在取同一份来源。此前无论模型与密钥如何配置都无法保存，因为请求在连通性测试之前就被拒绝。
- 经局域网 IP 打开页面时，「问 AI」的任何提问都报「对话失败」且请求不会发出：请求指纹使用 `crypto.subtle`，而 http 仅对 `localhost` 视为安全上下文，其余情况下该接口为 `undefined`。改用不依赖 WebCrypto 的同步指纹实现，取值与分辨维度不变。

### 自托管模型网关

- 回环与内网（RFC1918）地址允许 http 与任意端口，用于接入没有 TLS 的本机或局域网网关；公网地址仍然要求 HTTPS 与标准端口，带凭据、查询参数或片段的地址一律拒绝。
- 链路本地地址（169.254.0.0/16、fe80::/10）明确拒绝。云服务商的实例元数据服务位于 169.254.169.254，而 `ipaddress` 将该网段计入 `is_private`，仅依据 `is_private` 判断会将其放行；本项目可部署于云服务器，放行该地址意味着实例凭据可被任何能修改模型地址的人读取。阿里云使用的 100.100.100.200 位于 CGNAT 网段，不在放行范围内。
- 新增「CC Switch 本机路由」预设，选中即带上 `http://127.0.0.1:15721/v1` 与占位密钥 `PROXY_MANAGED`。模型留空，由用户按本机路由的实际配置填写。预设不代表兼容性已验证，路由需支持流式 Responses 与工具调用。

### 文档

- 中英文 README 补充本机与内网网关的接入条件；移除招聘与赞助段落。

### 测试

- 后端三个目录 1285 项通过、4 项 Windows 专项跳过；前端 41 项通过；类型检查与生产构建通过。
- 新增云实例元数据地址必须拒绝的边界测试，并以正常内网网关仍放行作对照，避免校验整体失效时该测试仍然通过。
- 新增请求指纹不得依赖 `crypto.subtle` 的契约测试，以及 CC Switch 预设的契约测试。

## v1.1.0（2026-09-10）

### WorkBuddy 接入与复盘

- 使用 macOS WorkBuddy 内置 CodeBuddy CLI 2.137.1，实测连接、受控工具、普通对话、取消与超时，以及一次完整单日复盘流程。独立安装的 CodeBuddy、其他平台、全部模型及报告推断正确性不在此次验证范围内。
- 证据核验同时返回引用与文字问题，标明错误字段和可安全显示的引用 ID，让既有的一次纠错更有针对性；不自动猜测或替换引用，不增加重试次数。
- 兼容模型将完整 JSON 放在单个 Markdown 代码块中的输出，仍严格检查 JSON、字段及证据归属；不从混杂文本中截取报告。
- 纠错回放清理畸形引用字段，保留错误信息用于重新生成。

### 普通对话与版本一致性

- 补充统计口径：区分上涨比例、有效样本覆盖率与全市场数据，零收益保留在有效样本分母中，缺失值单列披露。
- 明确一字涨跌停不等于没有行情，不按停复牌标签直接剔除样本，不凭空添加阈值或市场数字。
- README、网页页脚、API、包配置与 Release 统一为 v1.1.0；继续使用官方 Codex Harness，引擎版本独立维护。

## v1.0.0（2026-09-10）

从 v0.2.1 升级，Agent 底座升级为 OpenAI Codex Harness；保留并完善已有业务。

README、网页页脚、API 与包配置统一为 `1.0.0`，新增版本一致性回归检查；Codex 引擎版本独立维护。

### Agent 底座与 AI 接入

- 使用官方 Codex Harness 引擎，配套产品独立登录、受控证据工具、任务管理、引用校验与报告追问。
- 统一 Codex、Claude、WorkBuddy / CodeBuddy 订阅接入入口，以及 OpenAI、DeepSeek、MiMo 等 API 配置。
- WorkBuddy / CodeBuddy 已有本机 CLI 适配入口，仍需用户自己的安装与登录，尚未完成真实业务验证。其他厂商预设和具体接入要求见 README。
- Agent 默认关闭；生成复盘、多空辩论和回测均由用户主动发起。

### 七个工作模块

首页、盯盘、复盘、资讯雷达、个股研究、回测、我的股票按工作流程组织。二级栏目默认展开，可单独收起；默认深色主题，保留浅色主题。

- **首页**：聊天、分类入口和最近报告。
- **盯盘**：盘面数据与自选行情、实时动态、昨日涨停及连板梯队、盘中核验；新增十日限售解禁日历与自选标记。
- **复盘**：按交易日生成报告、首板分析、近5天热度、历史统计、证据展开和跨日比较。
- **资讯雷达**：新闻与事件概率，展示来源、时间与覆盖状态。
- **个股研究**：行情、估值、财报、研报与多空辩论。
- **回测**：整理历史规则，用户确认后由程序计算并归档报告。
- **我的股票**：持仓自选、交易日志与研究记录。

### 运行与数据可靠性

- 修复选择新复盘日期时回落到旧报告日期的问题；区分目标日期、报告日期和生成时间。
- 复盘可查看进度、取消任务和刷新后恢复状态；失败保留旧报告，同日重做保存版本。
- 每路取数在独立进程运行，等待上限90秒，并受整场剩余时间约束；超时或取消会清理对应进程。此限制不等于整份 AI 报告的完成时间。
- Windows 后台移除平台拦截，补齐启动、UTF-8、管道处理、目录锁和进程清理。
- 新增 `ASTOCK_DATA_HOME` 业务数据目录配置，保留默认目录兼容；不自动迁移已有文件。
- 修正解禁历史混入未来记录、批次股数及总股本占比口径；取数失败与没有事件明确区分。


## v0.2.1

此前公开版本的变化见 [v0.2.1 Release](https://github.com/simonlin1212/vibe-astock/releases/tag/v0.2.1)。
