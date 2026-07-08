# 策略条件管理 · "运行"交互与进度展示优化清单

> 模块：`apps/web` 策略条件管理（`StrategyConditionsView.vue` + `stores/strategyConditions.ts`）+ `apps/server/src/strategy-conditions/` 后端。
> 生成于 2026-07-08。优先级档位：**正确性（隐性 bug）> 进度展示打磨 > 轮询机制（需先摸后端）**。
>
> **进度**：第一节（正确性 1/2/3）✅、第二节（轮询机制 4/5）✅、第三节（进度展示 6/7/8/9）✅ 均已完成（2026-07-08/09）。剩余：第四节功能完整性（10）。

---

## 一、正确性问题（优先修，隐性 bug）✅ 已完成（2026-07-08）

### 1. 30s 硬超时导致前后端状态撕裂 ⚠️ 最严重 ✅ 已修复
- **位置**：`apps/web/src/stores/strategyConditions.ts:85-91`
- **现象**：前端超时后单方面把 `runningId` 清掉、塞"轮询超时"错误，但**后端任务仍在跑**。结果：
  - 用户以为失败 → 可能重跑（若后端不防重复，双倍负载）
  - 任务实际稍后成功，前端永远不知道，`runStatuses` 停在 `running`/`failed` 直到下次手动刷新
- **取舍**：
  - (A) 去掉前端超时，纯靠后端 `status` 兜底 → 状态一致，但网络真断时无限轮询
  - (B) 超时后不判失败，降级为低频探活（每 5s 一次直到拿到终态）→ 兼顾一致性与保护（**倾向**）
- **依赖**：需先确认后端任务最大可能耗时（见第五节）
- **✅ 已采用方案**：删除 30s 硬超时（`store:85-91`），放弃轮询只发生在「连续 5 次轮询失败」（用户确认从 3 放宽到 5），放弃后调 `fetchLastRunStatus()` 同步真实状态而非误判失败。

### 2. 刷新 / 切走后轮询不恢复 ✅ 已修复
- **位置**：`apps/web/src/views/strategy/StrategyConditionsView.vue:251-254`
- **现象**：`onMounted` 只调 `fetchLastRunStatus()`，而 `LastRunStatus.freshness` 本身有 `'running'` 值。刷新后"状态"列能显示"运行中"，**但 `runningId` 与 `setInterval` 不重建** → 按钮恢复可点、进度数字消失，再点可能触发重复运行。
- **修法**：`onMounted` 时若发现某 id 为 `running`，自动重建该 id 的轮询。把 `startRun` 里的 poll 逻辑抽成可复用函数。

### 3. 轮询零容错 ✅ 已修复（用户确认阈值从 3 放宽到 5）
- **位置**：`apps/web/src/stores/strategyConditions.ts:75-80`
- **现象**：一次 `catch` 就 `clearInterval`，单次网络抖动即放弃一个仍在跑的任务。
- **修法**：改为连续 N 次失败才停（N 取 3），中间容错继续轮询。

---

## 二、轮询机制（需先摸清后端再定方案）✅ 已完成（2026-07-08）

### 4. 500ms 固定间隔偏激进 ✅ 已修复（两段式自适应）
- **位置**：`stores/strategyConditions.ts:63`
- **现象**：扫描单标的若要数百 ms~数秒，500ms 与 1s 用户感知无差，但请求量翻倍。
- **修法**：自适应——前几次快（300-500ms，让用户立即看到动），稳定后拉长到 1-2s。
- **反驳**：若后端进度更新很密（每扫一只 +1），间隔拉长会丢帧、丝滑感下降。**取决于单次扫描耗时**，先看后端 log 再定。
- **✅ 已采用**：两段式——前 5 次成功轮询用 `FAST_POLL_MS=400`，之后切 `SLOW_POLL_MS=1500`。`pollCount` 仅成功时 +1（失败不切档）。**反驳已证伪**：后端进度粒度是每 100 只 +1（`runner.ts:53-61`），全市场约 50 次更新，不存在「每扫一只 +1」的密集更新，拉长不会丢帧。顺带把 `setInterval` 改为递归 `setTimeout`，消除慢网络下并发请求堆积隐患。

### 5. `runningId` 为单值 → 全局只能跑一个 ✅ 已修复（前端 Set + 后端按用户限流排队）
- **位置**：`stores/strategyConditions.ts:8`（`runningId: ref<string | null>`）
- **现象**：同一时刻只能一个条件组在运行，用户想批量对比得逐个点。
- **关键前置**：取决于后端 `run` 是否支持并发 / 串行队列、扫描资源开销。
  - 后端串行 → 前端允许多选也只是排队，意义不大
  - 后端并发 → 改成 `Set<id>` 体验明显提升
- **需先确认后端运行模型**（见第五节）。
- **✅ 已采用**：
  - **前端**：`runningId: ref<string|null>` → `runningIds: ref<Set<string>>` + `isRunning(id)` helper（第一节顺手做）。
  - **后端**（用户确认「本次加后端上限」）：新增 `strategy-conditions.queue.ts` 进程内信号量，**按用户限流 `MAX_CONCURRENT_PER_USER=3`**，超限进 `status='queued'` 排队、release 后 drain FIFO 调度；`OnApplicationBootstrap` recovery（孤儿 running 全标 failed 保守策略、queued 按用户分组重调度）。`service.run` 防重扩展到 `running`+`queued`，`delete` 收窄为只删终态记录（消除排队下撕裂数据隐患）。循环依赖用 `onDone` 回调规避（runner → queue 反向通知），不用 `forwardRef`。

---

## 三、进度展示质量（低成本高收益）✅ 已完成（2026-07-09）

### 6. 实时命中数被浪费 ✅ 已修复（后端循环内增量写 totalHits + 前端状态列展示）
- **位置**：`RunProgress.totalHits`（`apps/web/src/api/modules/strategy/strategyConditions.ts:50`）字段已定义，但 UI 只在完成后用。
- **现象**：运行中"已经命中几只"非常有价值（提前判断条件松紧），展示成本接近零。
- **修法**：运行中文字 `扫描 120/5000` → `扫描 120/5000 · 命中 8`。
- **⚠️ 数据源现状（第五节已确认）**：`runner.ts:59-61` 循环内每次 `update` 只写 `progressScanned`，**不写 `totalHits`**；`totalHits` 只在终态（`runner.ts:76-80`）一次性写入。**扫描过程中 `getRunProgress` 返回的 `totalHits` 始终为 0**。要做实时命中数展示，**必须先改后端**：runner 循环内增量累加 `allHits` 的长度并 `update(runId, { totalHits: allHits.length })`。这是后端改动，不在第三节「纯前端 UI 打磨」范围内。
- **✅ 已采用**：`runner.ts:65-68` 循环内 `update` 增加 `totalHits: allHits.length`（`allHits.push` 已在 update 前执行，值为当前累计命中数）。前端状态列 running 分支读 `progress.totalHits` 渲染「扫描 X/Y · 命中 N」。Entity/Service/Controller 无需改（字段已存在）。

### 7. 纯文字进度 → 换 `n-progress` ✅ 已修复
- **位置**：`StrategyConditionsView.vue:212-215`（`扫描 X/Y` 纯文字）
- **修法**：改用 Naive UI 原生 `n-progress` 细进度条，视觉负担更小、信息量更大。
- **✅ 已采用**：进度信息从操作列上移到**状态列**（用户确认）。状态列 running 分支渲染 `NProgress`（`type:'line', showIndicator:false, height:6, processing:true`）+ 下方「扫描 X/Y · 命中 N」文字。操作列删除原纯文字进度，只留按钮组。状态列 `width:100` → `minWidth:160`（代码评审建议，防文字溢出）。参照 `customIndexColumns.ts:113-119` 既有 NProgress 用法。

### 8. 失败原因完全不可见 ✅ 已修复（前端+后端完整方案）
- **位置**：`RunProgress.errorMessage`（`strategyConditions.ts:51`）与 `lastPollError`（store）两个错误源，UI 都没展示。
- **现象**：失败时只看到红色 NTag，用户不知道为什么。
- **修法**：把 `errorMessage` 通过 tooltip 或行内展开显示（`StrategyConditionsView.vue:101-119` 状态列处）。
- **✅ 数据源已就绪**（第一节）：终态 failed 时 `pollRunProgress` 已把 `progress.errorMessage` 写入 `lastPollError`（`store:106`）。纯 UI 改动，下一轮直接读 `lastPollError` 渲染即可。
- **✅ 已采用（完整方案，用户确认）**：原 `lastPollError` 单一 `ref<string|null>` 有两个缺陷——多条件组并发失败互相覆盖、刷新后丢失（`LastRunStatus` 不含 errorMessage）。完整方案：
  - **后端**：`LastRunStatus` 接口加可选 `errorMessage?: string|null`（`types.ts`）；`getLastRunStatus` failed 分支补返回 `errorMessage: run.errorMessage`（`service.ts:272`），刷新页面后仍可展示。
  - **前端 store**：`lastPollError` 单一 ref → `lastPollErrors: Map<string,string>` per-condition + `getLastError(id)` helper；4 处调用点同步；`deleteCondition` 补清理。
  - **前端 view**：failed 状态用 `NTooltip` 包裹红色「失败」NTag，hover 显示。取值双数据源优先级：`store.getLastError(id)`（轮询期，最准）→ `status.errorMessage`（刷新后兜底）→ `'未知错误'`。参照 `customIndexColumns.ts:121-132` 的 NTooltip pattern。

### 9. 终态后 `runProgress` Map 不清理 ✅ 已修复（第一节顺手做）
- **现象**：完成后 `runProgress.value.set(id, ...)` 留着终态数据，未 `delete`。下次点同一条件组，开始瞬可能闪旧进度数字。
- **修法**：完成分支加一行 `runProgress.value.delete(id)`。
- **✅ 已采用**：`pollRunProgress` 终态分支（completed/failed）已加 `runProgress.value.delete(id)`（`store:104`）。

---

## 四、功能完整性

### 10. 命中结果看不到 ⚠️
- **现象（两处问题）**：
  - `getRunResult`（`apps/web/src/api/modules/strategy/strategyConditions.ts:116-118`，后端 `GET :id/run/result`）**已定义但前端未调用**
  - "查看 N 个命中结果"按钮跳 `/symbols?strategyId=...`（`StrategyConditionsView.vue:73-75, 216-225`），但 **`SymbolsView` 没有读取 `strategyId` query 参数的逻辑** → 跳过去什么都不按条件过滤
- **两个修法**：
  - (A) **当前页展开行 / 抽屉直接展示明细**：用现成的 `getRunResult`，不离开上下文，体验最佳。代价：表格行高/布局调整。（**倾向**）
  - (B) 修 `SymbolsView` 的 `strategyId` 过滤：改动小，但跳走后丢失"管理条件"的上下文，且依赖 SymbolsView 支持按命中集合筛选。
- **理由**：命中明细本质是"这次运行的产物"，应跟着运行结果一起看，而不是跳标的目录页。

---

## 五、待先确认的后端事实（影响 1 / 4 / 5 怎么改）✅ 已全部确认（2026-07-08）

接手时先回答这三个问题，再动 1 / 4 / 5：

- 后端 `run`（`apps/server/src/strategy-conditions/strategy-conditions.controller.ts:54` → service.run）**是否串行**？**是否防重复点击**（同 id 未完成时再次 POST）？
  - **✅ 已确认**：**同 conditionId 防重复**（`service:169-174`，抛 409 `ConflictException`）；**不同 conditionId 可并发**（原无全局锁）。第二节已在此基础上加「按用户限流 3 + 排队」（防重扩展到 `running`+`queued`）。
- 全市场单次条件扫描**典型耗时**？（决定 30s 超时是否合理、轮询间隔档位）
  - **✅ 已确认**：`runner.scanBatch` 每 batch=100 只做多表 JOIN 大 SQL（join daily_indicator/quote/basic/amv/rolling_indicator），全市场约 5000 只 → 50 批。**单次全市场扫描耗时数十秒级**，30s 硬超时几乎必然误杀正常任务（问题 1 已据此移除硬超时）。
- 进度更新粒度——**每扫一只 +1 还是批量**？（影响轮询间隔是否丢帧）
  - **✅ 已确认**：**批量**——每 100 只 +1（`runner.ts:53-61`），全市场约 50 次进度更新。**不是**每扫一只 +1。因此问题 4 拉长轮询间隔（400→1500ms）不会丢帧，反驳已证伪。

---

## 建议执行顺序

1. ~~第五节的后端事实确认（阻塞 1 / 4 / 5）~~ ✅ 已完成
2. ~~**正确性**：1（超时撕裂）→ 2（刷新恢复）→ 3（容错）~~ ✅ 已完成（2026-07-08）
3. ~~**轮询机制**：4（自适应间隔）→ 5（前端 Set + 后端限流排队）~~ ✅ 已完成（2026-07-08）
4. ~~**进度展示**：6 / 7 / 8 / 9（互相独立，可并行）~~ ✅ 已完成（2026-07-09）
   - ~~8 / 9 数据源已就绪（第一节顺手做），纯 UI 改动。~~
   - ~~**6 ⚠️ 需先改后端**：runner 循环内要增量写 `totalHits`（见问题 6 修正后的说明）。~~
   - ~~7（n-progress）纯 UI。~~
   - **实际执行**：6（后端循环内写 totalHits + 前端展示）、7（状态列 n-progress，进度信息从操作列上移）、8（完整方案：lastPollError→Map + LastRunStatus 加 errorMessage + NTooltip）、9（第一节已做）。三节代码评审通过（0 阻塞），状态列列宽按评审建议从 `width:140` 改 `minWidth:160`。
5. **功能完整性**：10（命中结果展示，方案 A）⬅ 下一项
