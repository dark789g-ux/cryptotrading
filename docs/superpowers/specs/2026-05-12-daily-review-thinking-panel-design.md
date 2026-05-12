# 每日复盘 — LLM 思考过程实时面板设计

- 日期：2026-05-12
- 范围：每日复盘详情页在生成过程中以"AI 软件思考过程"风格实时展示 LLM 调用情况，完成后保留回看
- 入口文件：[apps/web/src/views/DailyReviewView.vue](../../../apps/web/src/views/DailyReviewView.vue)、[apps/web/src/views/DailyReviewDetailView.vue](../../../apps/web/src/views/DailyReviewDetailView.vue)

## 1. 背景

当前生成流程已具备的能力：

- 后端 `DeepseekService.generateArticle` 已从 DeepSeek API 流式接收 `delta.reasoning_content` 与 `delta.content`，并在末尾收 `usage`
- `DailyReviewProgressGateway` 通过 SSE 推送 `{stage, percent}` 给前端
- 完成后 `articleMd / reasoningContent / tokenUsage / llmModel` 落库；admin 可在详情页的 `<n-collapse>` 中查看一坨 `<pre>` reasoning

缺口：reasoning 文本与正文增量都已经流到后端，却没有继续流给前端。生成中前端只有进度条 + 阶段标签，看不到"AI 在想什么、写到哪里、用了多少 token"，与主流 AI 软件（Claude / DeepSeek 等）思考过程交互差距大。

## 2. 目标与非目标

**目标**：
- 详情页在生成过程中实时展示：阶段时间线（带耗时）、流式 reasoning 文本（admin）、流式 Markdown 正文预览、LLM 元信息（admin：模型名 / 思考耗时 / token 累计）
- 生成完成后，详情页保留思考过程为可折叠的回看区域，统一替代当前 admin-only `<n-collapse>`
- 失败时，已收集的 reasoning 残段仍对 admin 可见，便于 prompt 排错
- 生成中刷新页面 / 跳转晚到 / 完成瞬间跳转，状态都能完整恢复

**非目标**：
- 不引入实时协同编辑或多人观看广播（单用户单连接）
- 不持久化所有事件回放流；只持久化 `stageTimings`（阶段耗时）+ 已有 `reasoningContent / articleMd / tokenUsage / llmModel`
- 列表页布局不动（只保留进度条）
- reasoning 超长场景的虚拟滚动优化不在本次范围

## 3. 关键决策（已经过用户确认）

| 决策 | 选择 | 备注 |
|---|---|---|
| 面板位置 | 详情页生成中实时显示 + 完成后保留可回看 | 列表页不动 |
| 面板内容 | 阶段时间线 + 流式 reasoning + 流式正文 + LLM 元信息 | 四块全开 |
| 可见范围 | reasoning / token / 模型名仅 admin；阶段时间线 / 正文流所有用户可见 | 与现有 `getDetail` admin strip 逻辑一致 |
| 技术路线 | 单 SSE 通道 + 服务端 `ReplaySubject` 补流 | 完成后走静态 `GET detail` 读取回看 |

## 4. 架构与数据流

```
DeepSeek API (stream)
       │ delta.reasoning_content / delta.content / usage
       ▼
DeepseekService.generateArticle
       │ onProgress(event)                                ◄── 事件类型扩展
       ▼
DailyReviewService.runPipeline
       │ gateway.emit(date, event)
       ▼
DailyReviewProgressGateway
   ┌─ ReplaySubject<ProgressEvent>（每个 tradeDate 一个）
   │   • 缓存全部事件
   │   • completed/failed 后保留 60s 再 dispose（容忍跳转重连）
   │
   └─ observe(date, isAdmin)：非 admin 过滤掉 reasoning_delta / usage
       ▼
GET /daily-review/:date/stream  (SSE)
       ▼
useDailyReviewProgress (前端 composable)
   • stage, percent, stageTimings
   • reasoning（append-only 字符串）
   • articleStream（append-only 字符串 → Markdown 实时渲染）
   • tokenUsage, llmModel, error, done
       ▼
ReviewThinkingPanel.vue
   ├─ live 分支：消费 composable 状态
   └─ replay 分支：从 GET /daily-review/:date 静态读
```

**状态机**：详情页根据 `row.status` 决定 panel 模式。`fetching / generating` → `live`；`completed / failed` → `replay`。

**回看数据源**：完成后不读 SSE，从 `getDetail()` 拿 `reasoningContent + articleMd + tokenUsage + llmModel + stageTimings`（前四个字段已有，`stageTimings` 是新增）。

## 5. SSE 事件协议

`ProgressEvent` 由"单 stage 字段"扩展为带 `type` 判别联合：

```ts
type Stage = 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize';

interface TokenUsage { prompt: number; completion: number; reasoning: number; total: number }

interface StageTiming { stage: Stage; startedAt: string; durationMs: number }

type ProgressEvent =
  | { type: 'stage';           stage: Stage; percent: number; ts: number; message?: string }
  | { type: 'reasoning_delta'; text: string;  ts: number }   // admin only
  | { type: 'content_delta';   text: string;  ts: number }
  | { type: 'usage';           tokens: TokenUsage; ts: number } // admin only
  | { type: 'stage_done';      stage: Stage; durationMs: number; ts: number }
  | { type: 'completed';       ts: number }
  | { type: 'failed';          error: string; ts: number };
```

**类型位置**：前后端各自一份副本（项目无 shared-types/daily-review 文件，新增也可，但本次保持双写以减少跨包改动）。

**发射规则**：

| 时机 | 事件 |
|---|---|
| 进入 `runPipeline` | `stage(validate, 1)` |
| 每次 stage 切换前 | `stage_done(prev)` + `stage(next, percent)` |
| 每个 `delta.reasoning_content` | `reasoning_delta`（不拼包不节流，原样推） |
| 首个 `delta.content` | `stage_done(reasoning)` + `stage(writing, 70)` |
| 后续每个 `delta.content` | `content_delta` |
| stream 末尾 `usage` | `usage` |
| `runPipeline` 末尾 | `stage_done(finalize)` + `completed` |
| catch 块 | `failed` |

**节流**：服务端不节流（chunk 已是 token 级几十字节）；前端用 `requestAnimationFrame` 合并 reasoning/article delta 写入 ref，避免高频响应式抖动。

**Admin 过滤**：`gateway.observe(tradeDate, isAdmin)` 接受 `isAdmin` 参数；非 admin 时 `filter(e => e.type !== 'reasoning_delta' && e.type !== 'usage')`。controller 从 `req.user.role === 'admin'` 判断。

**ReplaySubject 配置**：`new ReplaySubject<ProgressEvent>(Infinity, Infinity)`。`completed / failed` 发出后 `setTimeout(60_000)` 延迟回收，给跳转重连留窗口。

## 6. 后端实现细节

### 6.1 实体新增字段

[apps/server/src/entities/daily-review/daily-review.entity.ts](../../../apps/server/src/entities/daily-review/daily-review.entity.ts) 新增：

```ts
@Column({ name: 'stage_timings', type: 'jsonb', nullable: true })
stageTimings: StageTiming[] | null;
```

`startedAt` 用 UTC 墙钟字符串（遵循 CLAUDE.md 时间规范）。

**Migration**：[apps/server/src/migration/2026-05-12-daily-review-stage-timings.sql](../../../apps/server/src/migration/2026-05-12-daily-review-stage-timings.sql)
```sql
ALTER TABLE daily_reviews ADD COLUMN IF NOT EXISTS stage_timings jsonb;
```

可执行脚本：
```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "ALTER TABLE daily_reviews ADD COLUMN IF NOT EXISTS stage_timings jsonb;"
```

### 6.2 Gateway 改造

[apps/server/src/daily-review/daily-review-progress.gateway.ts](../../../apps/server/src/daily-review/daily-review-progress.gateway.ts)：

- `Subject` → `ReplaySubject<ProgressEvent>(Infinity, Infinity)`
- `observe(tradeDate, isAdmin)` 多一参，非 admin 通过 `filter()` 过滤
- `emit()` 在 `completed / failed` 后**不立即** `subjects.delete`，改用 `setTimeout(60_000)` 延迟回收；同时维护 `completedAt: Map<string, number>` 记录完成时刻
- `hasActive(date)` 改为 `subjects.has(date) && !completedAt.has(date)`，使 60s 保留窗口期不阻塞重新生成

### 6.3 Pipeline 改造

[apps/server/src/daily-review/daily-review.service.ts](../../../apps/server/src/daily-review/daily-review.service.ts) `runPipeline`：

- 维护 `stageTimings: StageTiming[]` 与 `currentStageStart: number`
- 抽 `transitionStage(next: Stage, percent: number)`：先把上一个 stage push 到 stageTimings 并 emit `stage_done`，再 emit `stage(next, percent)`，更新 `currentStageStart`
- DeepSeek 调用前 `transitionStage('reasoning', 45)`；DeepSeek 内部首次收到 `delta.content` 时由 `onProgress` 触发 `stage_done(reasoning)` + `stage('writing', 70)`
- 结束时 push 最后一个 stage_timing 并 `repo.update(id, { ..., stageTimings })`

### 6.4 DeepseekService 改造

[apps/server/src/daily-review/deepseek.service.ts](../../../apps/server/src/daily-review/deepseek.service.ts) `generateArticle`：

- 删除 `estimatePercent` 与它发的 stage 事件
- 收到 `delta.reasoning_content` → `onProgress({ type: 'reasoning_delta', text, ts })`
- 首个 `delta.content` 之前 emit `stage_done(reasoning)` + `stage('writing', 70)`，之后每块 `content_delta`
- 末尾 usage chunk → `usage` 事件
- 返回值仍为 `{ article, reasoning, tokenUsage }`，pipeline 继续落库

### 6.5 Controller

[apps/server/src/daily-review/daily-review.controller.ts](../../../apps/server/src/daily-review/daily-review.controller.ts:42) SSE 端点：

```ts
@Sse(':tradeDate/stream')
stream(@Param('tradeDate') tradeDate: string, @Req() req: RequestWithUser): Observable<MessageEvent> {
  const isAdmin = req.user?.role === 'admin';
  return this.gateway.observe(tradeDate, isAdmin).pipe(
    map((e) => ({ data: e } as MessageEvent)),
  );
}
```

### 6.6 getDetail 与权限

[apps/server/src/daily-review/daily-review.service.ts](../../../apps/server/src/daily-review/daily-review.service.ts:39) `getDetail` 维持现状：admin 才返回 `reasoningContent / tokenUsage / llmModel`。新增 `stageTimings` 对所有用户可见（耗时不属于敏感数据）。

## 7. 前端实现细节

### 7.1 类型同步

[apps/web/src/types/daily-review.ts](../../../apps/web/src/types/daily-review.ts) 把 `ProgressEvent` 改为判别联合，新增 `StageTiming` / `TokenUsage`，detail 响应类型补 `stageTimings / reasoningContent / articleMd / tokenUsage / llmModel`。

### 7.2 useDailyReviewProgress 重写

[apps/web/src/composables/useDailyReviewProgress.ts](../../../apps/web/src/composables/useDailyReviewProgress.ts) 重写为：

```ts
export function useDailyReviewProgress(tradeDate: string) {
  const stage = ref<Stage>('validate')
  const percent = ref(0)
  const reasoning = ref('')          // append-only
  const articleStream = ref('')      // append-only
  const stageTimings = ref<StageTiming[]>([])
  const tokenUsage = ref<TokenUsage | null>(null)
  const error = ref<string | null>(null)
  const done = ref(false)

  // requestAnimationFrame 批量合并 reasoning/article delta
  let pendingReasoning = '', pendingArticle = '', rafId: number | null = null
  const flush = () => {
    if (pendingReasoning) { reasoning.value += pendingReasoning; pendingReasoning = '' }
    if (pendingArticle)   { articleStream.value += pendingArticle; pendingArticle = '' }
    rafId = null
  }
  const schedule = () => { if (rafId == null) rafId = requestAnimationFrame(flush) }

  // 事件分发：stage / reasoning_delta / content_delta / usage / stage_done / completed / failed
}
```

ReplaySubject 会在新连接时一次性下发所有历史事件——`reasoning / articleStream` 会快速跑到当前进度，这是预期行为。

### 7.3 新组件 ReviewThinkingPanel.vue

新文件 [apps/web/src/components/daily-review/ReviewThinkingPanel.vue](../../../apps/web/src/components/daily-review/ReviewThinkingPanel.vue)

**Props**：
```ts
{
  tradeDate: string
  mode: 'live' | 'replay'
  replayData?: {
    reasoningContent: string | null
    articleMd: string | null
    stageTimings: StageTiming[] | null
    tokenUsage: TokenUsage | null
    llmModel: string | null
    status: 'completed' | 'failed'
    errorMessage: string | null
  }
}
```

**布局**：

```
┌──────────────────────────────────────────────────────────────┐
│ 阶段时间线（横向 n-steps，每步下方显示耗时）                │
│ [✓ 校验 1s] [✓ 采集 4s] [✓ 快照 2s] [⟳ 推理 38s] [ ] [ ]    │
├──────────────────────────────────────────────────────────────┤
│ 模型 deepseek-reasoner · 已用 42s · 输入 4.2k / 推理 3.1k    │  ← admin only
│                                / 输出 2.4k tokens             │
├──────────────────────────────────────────────────────────────┤
│ ┌─ 💭 AI 思考过程 [折叠/展开] ──┐ ┌─ 📄 正文预览 ────────┐  │
│ │ admin only                    │ │ 实时 Markdown 渲染   │  │
│ │ <pre> 流式 reasoning 文本     │ │ <ReviewArticleViewer │  │
│ │ 自动滚到底（可手动暂停）      │ │   :md="articleStream"│  │
│ │ 完成后默认折叠为一行摘要      │ │   live              />│  │
│ └───────────────────────────────┘ └──────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**交互**：
- 思考面板自带"自动滚到底"开关；用户向上滚动暂停，回到底部恢复
- 完成后（`mode === 'replay'` 或 `done`）思考面板默认折叠，摘要 `💭 思考 42s · 推理 3.1k tokens · 点击展开`
- 失败时正文区显示 `n-alert` 错误；admin 仍可展开 reasoning 残段
- 非 admin：整个"AI 思考过程"块隐藏；元信息条隐藏；只剩阶段时间线和正文预览

**Markdown 实时渲染**：复用 [apps/web/src/components/daily-review/ReviewArticleViewer.vue](../../../apps/web/src/components/daily-review/ReviewArticleViewer.vue)。若其对未闭合 Markdown 不友好（流式内容可能在某帧出现半截 code fence），加 `live` prop 让它 try/catch，渲染失败回退到 `<pre>`。

### 7.4 DetailView 改造

[apps/web/src/views/DailyReviewDetailView.vue](../../../apps/web/src/views/DailyReviewDetailView.vue)：

- `fetching / generating` 分支：替换 `<n-alert>+<ReviewProgressBar>` 为 `<ReviewThinkingPanel :trade-date :mode="'live'" />`；监听 SSE `completed` 后重新 `load()` 取完整 row，panel 自动切到 `replay`
- 已完成正常分支：在 `<ReviewSnapshotCards>` 与 `<ReviewArticleViewer>` 之间新增 `<ReviewThinkingPanel mode="replay" :replay-data />`，取代现有 `<n-collapse>` 推理过程区域

### 7.5 列表页

[apps/web/src/components/daily-review/ReviewListTable.vue](../../../apps/web/src/components/daily-review/ReviewListTable.vue) 不动——列表页仍只显示一行 ProgressBar，点"查看"进详情页才看到思考过程。

### 7.6 ProgressBar 兼容

[apps/web/src/components/daily-review/ReviewProgressBar.vue](../../../apps/web/src/components/daily-review/ReviewProgressBar.vue) 仍消费 `useDailyReviewProgress`，只用 `stage / percent / error`；新增字段忽略即可，向后兼容。

## 8. 边界场景

| 场景 | 行为 |
|---|---|
| 详情页打开时生成已完成 | `row.status === 'completed'` → 直接 replay 模式，不连 SSE |
| 详情页打开时生成进行中 | live 模式；SSE 连上立即收到 ReplaySubject 全部历史 → 状态对齐 → 接增量 |
| 生成中途刷新页面 | 同上，状态完全恢复 |
| 完成瞬间用户刚跳转过来 | ReplaySubject 60s 保留窗口内 SSE 仍可连，收到完整历史 + `completed` 后前端触发 `api.detail()` 切 replay |
| 跳转过来时已超 60s 回收 | SSE 连为空流；前端 fallback：`row.status === 'completed'` 切 replay；若仍是 `generating`（异常状态），显示"生成状态未知，请刷新"提示 |
| 生成失败 | `failed` 事件 → live panel 切错误态，admin 可见已收集 reasoning 残段 + errorMessage |
| 非 admin 用户 | controller 过滤 `reasoning_delta` / `usage`；前端 panel 检测 `auth.isAdmin` 隐藏对应 UI 块 |
| reasoning >50k chars | append-only ref + rAF 节流可承受；DOM 性能问题后续用虚拟滚动优化（不在本次范围） |
| 60s 回收窗口内同一 tradeDate 再次 POST | `hasActive` 返回 false（completedAt 已记录）→ 允许新生成 |

## 9. 测试策略

**后端**：

1. **DailyReviewProgressGateway 单测**（新增 `daily-review-progress.gateway.spec.ts`）
   - 新订阅者收到所有历史事件
   - admin 过滤：非 admin 订阅不会收到 `reasoning_delta / usage`
   - completed 后 60s 内仍可订阅；之后 subject 销毁
   - `hasActive` 在 completed 后立刻返回 false

2. **DeepseekService 单测**（扩展 [deepseek.service.spec.ts](../../../apps/server/src/daily-review/deepseek.service.spec.ts)）
   - mock stream 发 reasoning chunks → 触发对应数量的 `reasoning_delta`
   - 首个 content chunk 触发 `stage_done(reasoning)` + `stage(writing)`
   - usage chunk 触发 `usage` 事件
   - 注释：`// TODO: 需集成测试验证 DeepSeek 真实 reasoning_content 字段名`（遵循 CLAUDE.md "Mock 单测不验证第三方契约"）

3. **DailyReviewService 单测**：stageTimings 累积顺序正确；失败时 reasoning 仍部分落库

**前端**：

1. **useDailyReviewProgress** 用 jsdom `EventSource` mock：
   - reasoning_delta 多次后 `reasoning.value` = 累计字符串
   - stage_done 后 stageTimings 长度 +1
   - failed 后 `error / done` 正确

2. **ReviewThinkingPanel** 用 @vue/test-utils：
   - admin 与非 admin DOM 差异（reasoning 块、token 元信息块）
   - live → replay 切换不丢失 stageTimings

**手测清单**（详情页）：
- [ ] admin 触发生成，全程实时滚动 reasoning + 正文 Markdown 渲染
- [ ] 普通用户访问同一生成中页面：只看到阶段时间线 + 正文流，无 reasoning / token
- [ ] 生成中刷新页面 → 状态完整恢复
- [ ] 生成中关闭页面 60s 内重新打开 → 状态完整恢复
- [ ] 生成失败 → admin 能展开看到失败前 reasoning 片段
- [ ] 列表页 ProgressBar 仍正常工作（向后兼容）

## 10. 实施步骤建议

1. **后端骨架**（可并行子任务 1）
   - 实体 + migration + getDetail 透出 stageTimings
   - Gateway 改 ReplaySubject + admin 过滤 + 60s 延迟回收
   - ProgressEvent 类型扩展

2. **后端业务**（依赖 1）
   - DeepseekService 改 emit 事件类型
   - runPipeline 接入 transitionStage 与 stageTimings 累积

3. **前端类型与 composable**（可并行子任务 2，依赖 1 的类型定义）
   - types/daily-review.ts 同步
   - useDailyReviewProgress 重写

4. **前端组件**（依赖 3）
   - 新增 ReviewThinkingPanel.vue
   - DetailView 嵌入 panel（live + replay 两种模式）
   - ReviewArticleViewer 增 `live` prop

5. **测试 + 手测清单跑完**

## 11. 不做

- 不实现事件级别的持久化回放（不存每条 delta）
- 不引入 Redis 等外部 store（ReplaySubject 内存方案够用）
- 不改列表页布局
- 不做 reasoning 虚拟滚动
