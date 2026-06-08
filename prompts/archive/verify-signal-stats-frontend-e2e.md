# 真机浏览器 e2e：signal-stats 信号前向统计页

## 一句话目标

用浏览器（kimi-webbridge）独立点一遍 `/signal-stats` 页，回归验证「列表化重构 + 出场模拟提速 + 直方图修复」三件已合入本地 main 的工作，**并补做一次"UI 实触发长区间(20230101–20260531)重 run → 跑完不卡死"的 demo**（上一会话只做了离线提速验证，没在 UI 实触发；长区间正是当初"出场模拟卡 50+min"的场景，复现它跑完是对提速最有力的证明）。

> 这是**独立复测**：上一会话同一个 agent 既写了代码又自测，找一个全新会话纯从用户视角点一遍更可信。重点是**直方图修复的回归**（容易再被改坏）。

## 前置（按顺序，别跳）

1. **读 skill**：`/browser-driving`（策略 + 经验库 `references/lessons-learned.md`，**必扫**——里面有"图表区空白怎么诊断""中文字面量经 PowerShell 传 evaluate 会坏""daemon 残留 PID 恢复"等真实坑）+ `kimi-webbridge`（工具 API）。
2. **健康检查**：`~/.kimi-webbridge/bin/kimi-webbridge status` → 必须 `running:true` 且 `extension_connected:true`。残留 PID 卡死（`running:false` 但 pid 有值）按经验：`rm ~/.kimi-webbridge/daemon.pid; kimi-webbridge start`，再等几秒让扩展重连。
3. **前后端在跑**：前端 `localhost:5173`（vite，有 HMR）、后端 `:3000`（nest，**无 --watch**）。本任务纯点前端、不改后端代码，**无需重启后端**。
4. **驱动建议**：优先 `evaluate` 直接读 DOM / `.click()`（避开 `@e` ref 跨快照失效）。**用 bash curl 调 webbridge**（PowerShell 会把 evaluate code 里的中文字面量传坏）；读回中文正常，但 code 内**别用中文做匹配**，用结构性事实（元素计数 / class / canvas 数）。

## 现状摸底（file:line / 真机实测为证，别凭模块名猜）

- **路由**：`/signal-stats`（`$router.getRoutes()` 实测，不是 `/strategy/...`）。受登录态保护，导航前确认已登录（落 `/backtest` 等页而非 `/login` 即已登录）。
- **页面/组件**：
  - `apps/web/src/views/strategy/SignalStatsView.vue`（页面）
  - `apps/web/src/views/strategy/SignalStatsTable.vue`（全宽方案表）
  - `apps/web/src/views/strategy/SignalStatsResult.vue`（详情 AppModal 内容：10 卡 + tabs）
  - `apps/web/src/components/strategy/RetHistogram.vue`（ECharts 直方图，**上一会话修复点**）
- **后端**（`apps/server/src/strategy-conditions/signal-stats/signal-stats.controller.ts`，全局前缀 `/api`，`@Controller('signal-tests')`）：
  - `GET /api/signal-tests`（列表，含 latestRun）、`POST /api/signal-tests`（新建）、`POST /api/signal-tests/:id/run`（触发）、`GET /api/signal-tests/:id/run/progress`（SSE 进度）、`GET /api/signal-tests/runs/:runId/trades`（逐笔）、`GET /api/signal-tests/runs/:runId/ret-histogram`（直方图分档，新）。
  - 直方图分档纯函数 `signal-stats.histogram.ts`。
- **直方图修复**（commit `2e015b7`，回归重点）：`RetHistogram.vue` 的 `.ret-chart` 容器受模板 `v-if="loading"` 互斥门控，曾因 `loading` 在 `finally` 才置 false 导致 `echarts.init` 撞 loading 窗口被跳过、图表永远空白；已改为拿到数据后、init 前即置 `loading=false`。
- **数据现状**（上一会话实测，8 个方案）：
  - 行3 `kdj_j_lt_-10_2023-2026`：**已完成 80276 样本（金标准 run `06239e89-38b6-4189-8b98-4ef53220ae09`），全区间(2023~2026)、全市场 → 别重跑、别覆盖它**（A 清单读它即可）。
  - 行0~1 `kdj_j_lt_10/20`：全区间(2023~2026)、全市场，卡在"运行中"的**孤儿 run**（更早会话遗留的 DB 状态问题，属另一交接 `sync-signal-stats-run-status.md`，**别当 bug 追**）。其中 `kdj_j_lt_20`(J<20≈128万信号)正是当初出场模拟卡 50+min 那个——**B 实触发 demo 的首选目标**（重跑给它真实完成 run + 顺带清掉孤儿显示）。
  - 行2 `kdj_j_lt_0`：全区间，状态"失败"。
  - 行4~7 `kdj_j<XX 次日(前端)`：短区间(2026-01~03)测试方案，已完成——**本次不用**（要长区间）。
- **复用的实测选择子/口径**（直接抄，省得重推）：
  - 方案表：`document.querySelectorAll('.n-data-table tbody tr')`，操作列按钮顺序 `[运行=0, 详情=1, 编辑=2, 删除=3]`（`tr td:last-child button`）。点详情：`rows[i].querySelectorAll('td:last-child button')[1].click()`。
  - 详情弹窗：`[role=dialog]`；KPI 卡 `.n-statistic`（应 **10** 个）；tabs `[role=dialog] .n-tabs-tab`（2 个：收益率分布 / 逐笔明细）；逐笔表 = 弹窗内最后一个 `.n-data-table`（9 列、50/页）。
  - 关闭弹窗 = `[role=dialog] .n-base-close`（**不是**第一个 `button.n-button`，那是最大化）；最大化 = `[role=dialog] button.n-button`（弹窗宽 ~1100 → ~1836 全屏）。
  - **直方图渲染判据**（核心）：`.ret-chart` 内 `canvas` 数 + `document.querySelectorAll('[_echarts_instance_]').length`，**>0 = 渲染成功**；全 0 = 又被改坏（容器在但空）。

## 测试清单

### A. UI 回归（不触发 run，读现有已完成方案）

整页 `navigate http://localhost:5173/signal-stats` → 等 `main.innerText` 非空再操作。

1. **全宽方案表**：1 个 `.n-data-table`、≥4 行、列含 方案名称/统计区间/出场方式/标的池/状态/样本数/胜率/盈亏比(PF)/最新运行时间/操作。一行=一方案。**确认页面只有这 1 个表**（历史运行表已删）。
2. **详情 AppModal**：点某个**已完成**方案（推荐行7 `kdj_j<-10 次日`）的"详情" → `[role=dialog]` 出现。
3. **10 KPI 卡**：含「最佳单笔收益」(best_trade_ret) 且有数值（如 35.5%）。
4. **★ 直方图回归（重中之重）**：当前 tab=收益率分布，**首开即应渲染**——`.ret-chart` 内 `canvas≥1` 且 `[_echarts_instance_]≥1`。**若 0 = 2e015b7 被回退/再坏，立即报。** 截图存档。
5. **逐笔明细 tab**：点第 2 个 tab → 弹窗内 trades 表 9 列（标的/信号日/买入日/出场日/买入价/出场价/收益率/持仓天数/出场原因）、有行、分页。
6. **可最大化**：点最大化按钮 → 弹窗撑到近全屏（宽 ~1836），**直方图 resize 后仍有 canvas（不空白）**。截图存档。
7. **接口自检**（前后端定界）：`evaluate` 内 `await fetch('/api/signal-tests/runs/06239e89-38b6-4189-8b98-4ef53220ae09/ret-histogram')` → 200 + `{sampleCount,binWidth,bins:[{lo,hi,count,sign}]}`。

### B. 实触发 run demo（长区间 20230101–20260531，验当初的瓶颈场景已解）

> 目的：复现**当初出问题的场景**——长区间(3.5年)、全市场的重 run，出场模拟阶段曾卡 **50+ 分钟**。现在确认它**能跑完、不再卡在出场模拟**。**区间固定 `20230101 ~ 20260531`、全市场、固定 N=1。别重跑/覆盖金标准行3 `kdj_j_lt_-10`(run 06239e89)。**

- **目标方案（择一，按优先级）**：
  1. **重跑 `kdj_j_lt_20`（行0，J<20≈128万信号——当初卡死那个，最强复现）**：它现卡在孤儿"运行中"。先试点"运行"（操作列按钮[0]）/ `POST /api/signal-tests/<test_id>/run` 触发 → **若因"运行中"状态被拦，改走 2**。重跑成功会给它真实完成 run、顺带清掉该行孤儿显示（但"被 kill 的 run 永远 running"的底层状态同步仍属 `sync-...` 交接，别混）。
  2. **新建长区间方案**：`20230101~20260531`、全市场、`kdj_j < 20`(最重，复现最强) 或 `kdj_j < 0`(中等~44万，更快出结果)、固定 N=1，再触发。**注**：新建表单字段（买入条件 `ConditionRows.vue` 构建器、`n-date-picker` 区间、universe）上一会话未逐一摸过，需自行 snapshot 摸清；naive 日期选择器值是本地午夜 ms（`new Date(y,m,d).getTime()`，别用 UTC），难填控件可走组件 `setupState`（见 browser-driving 经验「驱动难填控件走组件实例」）。
- **触发后**：轮询 `GET /api/signal-tests/:id/run/progress`（SSE，`EventSource` 不带 auth header，按 README 口径）或直接定时重读列表该行状态/进度，等转「已完成」。
- **★ 耗时预期（关键，别把"枚举慢"误判成"又卡死"）**：长区间重 run 总耗时**约 3~8 分钟**——**枚举(~3.4min)+ 落库(百万级 trade 批插)是大头；出场模拟已提速到秒级、不再是瓶颈**。要验证的正是：**对比当初"出场模拟阶段卡 50+min"，现在整体几分钟内跑完、不再停在出场模拟**。进度条若在枚举阶段稳步推进、之后很快完成，即符合预期。**记录 wall-clock**。
- 完成后开该方案详情：核对样本数/胜率/最佳单笔更新、**直方图正常渲染**（顺带又一次回归 #4）。

## 硬约束 / 项目规范

- **browser-driving 经验先读**：`@e` ref 跨快照失效（动 DOM 前重 snapshot 或直接 evaluate）、非激活 tab/折叠区懒渲染需先激活、后台 tab 截图会阻塞（优先 evaluate）、截图前先验 `innerText` 非空。
- **evaluate code 禁中文字面量做匹配**（PowerShell 传输会坏）；bash curl 读回中文 OK。
- **别重跑/覆盖金标准** `kdj_j_lt_-10`（run `06239e89`）。
- **孤儿"运行中"run**（kdj_j_lt_10/20）是已知 DB 状态问题，非本次 bug，别追、别试图修（那是 `sync-signal-stats-run-status.md` 的事）。
- 结束 `close_session` 收摊。
- 发现的 bug：前端组件问题就地修 + `pnpm --filter @cryptotrading/web build`（vite，type-check 查不出 SFC 编译错）验证再提交；属后端/数据的记录上报、别擅自动后端。

## 验证标准（通过判据）

1. A 清单 1~7 全过，**尤其 #4 直方图首开渲染（canvas≥1）** 与 #6 最大化后不空白。
2. B：长区间(20230101~20260531)重 run 从触发到「已完成」**不卡死**——出场模拟阶段不再是瓶颈、整体约 3~8 分钟跑完（对比当初卡 50+min）；记录 wall-clock；latestRun 与详情指标/直方图正确更新。
3. 全程无白屏 / 无 `[role=dialog]` 内报错文案 / 无控制台致命错。
4. 截图存档：详情弹窗（直方图）、最大化态、实触发完成态各一张。

## 前序进度 / 待续

- 上一会话（2026-06-09）已做：A 清单 1~6 全过 + 发现并修复直方图首开空白（`2e015b7`）+ 离线提速 zero-drift（8000 信号 0 漂移、出场模拟 83544 信号 13 秒）。**本任务是独立复测 + 补 B（UI 实触发）**。
- 视觉基线（可能已被清）：`C:\tmp\sigstats-hist.png` / `sigstats-row7.png` / `sigstats-maximized.png`。
- 本地 main 含全部相关 commit（提速 + 列表化 + 直方图修复），**未推 origin**。
- 完成后本文档移入 `prompts/archive/`。
