# 每日复盘（Daily Review）设计文档

- 日期：2026-05-12
- 状态：Spec
- 作者：协作产出（renmaoyuan + Claude）
- 参考：[ai-a-stock-daily/](../../../ai-a-stock-daily/) 演示版

## 1. 背景与目标

[ai-a-stock-daily/](../../../ai-a-stock-daily/) 是一个独立的 React 演示站，展示了一份手工编写的 A 股每日复盘样例（文章 + 双端视频脚本 + 配音）。目前没有真实的数据采集与内容生成管线。

本特性将「**每日复盘**」消化进主项目 cryptotrading：在侧边栏新增导航，复用主项目已有的 A 股数据同步管线，由 LLM 自动生成结构化复盘文章，admin 一键触发，全员可读。

## 2. MVP 范围

| 维度 | 决策 |
|---|---|
| 产物 | **数据快照（JSON）+ Markdown 文章**。无视频、无 TTS 音频。 |
| 生成模式 | **后台异步任务 + SSE 进度推送**。点击立即返回，列表中显示「生成中」并实时进度。 |
| LLM | **DeepSeek**（思考模式开启，`reasoning_effort` 高强度）。 |
| 数据范围 | **A 股核心六段**：大盘指数 / 涨跌停统计 / 涨跌分布 / 行业概念排行 / 资金流向 / 强势股+成交 TOP。不含美股映射、不含宏观消息面。 |
| 详情呈现 | **顶部数据卡片 + 中部 ECharts 图表 + 下方 Markdown 文章**。 |
| 权限 | **全局共享**：所有登录用户可读；**仅 admin** 可触发生成 / 删除 / 重生成。 |

## 3. 架构方案：方案 A — 复用主项目同步管线

```
┌──────────────────┐       ┌────────────────────────────────────┐
│ 已有同步管线      │  读取 │  daily-review 模块                  │
│ (a_share_*,      │◀──────│   snapshot-builder → snapshot JSON  │
│  money_flow_*,   │       │   deepseek.service → markdown 文章   │
│  index_*)        │       │   daily-review.service 编排 5 阶段   │
└──────────────────┘       └────────┬───────────────────────────┘
                                    │ 写入
                                    ▼
                           ┌────────────────────┐
                           │ daily_review 表    │
                           └────────┬───────────┘
                                    │
                                    ▼
                           ┌────────────────────┐
                           │ REST + SSE 接口    │
                           └────────┬───────────┘
                                    │
                                    ▼
                           ┌────────────────────┐
                           │ Vue 前端 视图      │
                           │ 列表 / 详情 / 进度 │
                           └────────────────────┘
```

不引入 BullMQ / Redis；不引入新的数据源（不接 yfinance）；不接 COS（无大文件）。

## 4. 数据模型

### 4.1 实体：`daily_review`

```ts
// apps/server/src/entities/daily-review/daily-review.entity.ts
@Entity('daily_review')
@Unique(['tradeDate'])
export class DailyReview {
  @PrimaryGeneratedColumn('uuid') id: string

  @Column({ type: 'varchar', length: 8 })
  tradeDate: string  // 'YYYYMMDD'，遵守 CLAUDE.md 的 A 股日期规范

  @Column({ type: 'varchar', length: 16 })
  status: 'pending' | 'fetching' | 'generating' | 'completed' | 'failed'

  @Column({ type: 'jsonb', nullable: true })
  snapshot: SnapshotPayload | null

  @Column({ type: 'text', nullable: true })
  articleMd: string | null

  @Column({ type: 'text', nullable: true })
  reasoningContent: string | null  // DeepSeek 思考链原文，admin 折叠查看

  @Column({ type: 'varchar', length: 64, nullable: true })
  llmModel: string | null

  @Column({ type: 'jsonb', nullable: true })
  tokenUsage: { prompt: number; completion: number; reasoning: number; total: number } | null

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null

  @Column({ type: 'uuid' })
  createdById: string

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date
}
```

### 4.2 SnapshotPayload 结构

```ts
type SnapshotPayload = {
  indices: { tsCode: string; name: string; close: number; pctChg: number; amount: number }[]
  limitStats: { upCount: number; downCount: number; brokenCount: number }
  updownDist: { up: number; down: number; flat: number; limitUp: number; limitDown: number }
  industryRank: { name: string; pctChg: number; leader: string }[]   // top10
  conceptRank:  { name: string; pctChg: number; leader: string }[]   // top10
  moneyFlow: {
    market: { mainNetIn: number }
    stocksTopIn:  { tsCode: string; name: string; mainNetIn: number }[]  // top20
    stocksTopOut: { tsCode: string; name: string; mainNetIn: number }[]  // bottom20
  }
  strongStocks: { tsCode: string; name: string; pctChg: number; turnoverRate: number }[]  // top20
  volumeTop:    { tsCode: string; name: string; amount: number; pctChg: number }[]       // top20
  generatedAt: string  // UTC ISO，遵守 CLAUDE.md 时间规范
}
```

### 4.3 设计要点

- **Unique(tradeDate)**：同一交易日仅一份记录；重生成走 `upsert`，旧 snapshot/article 直接覆盖。
- **不分中间任务表**：状态、进度阶段、错误信息都收敛到本表，避免无谓抽象；进度推送靠内存 Subject，不落库。
- **不预分明细表**：snapshot 落 `jsonb`，无关联查询需求；前端要原始数据时一把读出。
- **金额单位**：snapshot 中所有金额字段统一为「**元**」（不是万元/亿元），由 snapshot-builder 在聚合时做单位归一，前端展示再换算。**注释里要明确单位**。

## 5. 后端 API

### 5.1 REST + SSE

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| `GET` | `/api/daily-review` | 登录 | 列表（分页，`tradeDate DESC`，可按 status 过滤） |
| `GET` | `/api/daily-review/:tradeDate` | 登录 | 详情，返回 snapshot + articleMd + meta；`reasoningContent` 仅 admin 可见 |
| `POST` | `/api/daily-review` | admin | 启动生成 `{ tradeDate?: 'YYYYMMDD' }`，缺省取最近交易日 |
| `DELETE` | `/api/daily-review/:tradeDate` | admin | 删除一条 |
| `GET` | `/api/daily-review/:tradeDate/stream` | 登录 | SSE 进度流（生成中订阅，完成/失败即关闭） |

`POST` 立即返回 `{ tradeDate, status: 'fetching' }`，前端拿到后立刻订阅 SSE。

### 5.2 模块结构

```
apps/server/src/daily-review/
  daily-review.module.ts
  daily-review.controller.ts          REST + SSE 端点
  daily-review.service.ts             编排（5 阶段 + 进度事件）
  snapshot-builder.service.ts         step 2-3，纯 DB 聚合
  deepseek.service.ts                 step 4，LLM 调用 + 流式
  daily-review-progress.gateway.ts    内存 SSE 中转：Map<tradeDate, Subject<ProgressEvent>>
  prompts/article-prompt.ts           system + user 模板（纯 ts 常量）
  dto/
    create-review.dto.ts
    list-query.dto.ts
```

权限：`AuthGuard` 已全局注册（CLAUDE.md 规约），Controller 内**禁止**重复 `@UseGuards(AuthGuard)`；admin only 端点用项目已有的 `@AdminOnly()` 装饰器（或同等机制）。

### 5.3 生成管线（5 阶段）

```
1. validate (0→5%)
   ─ 校验 tradeDate 合法（8 位数字、在交易日历内）
   ─ 校验该日 a_share_daily_quote、money_flow_market、money_flow_industry 已同步
   ─ 缺数据 → status=failed，errorMessage='YYYYMMDD 的 A 股日线/资金流数据尚未同步，请先到「数据同步」补齐'

2. fetch (5→30%)  snapshot-builder.service
   ─ 并行查 DB（已存在）：
     · 涨跌分布      (聚合 daily_quote.pct_chg 分桶)
     · 涨跌停统计    (聚合 daily_quote.limit_status：当前 a_share_daily_quote 是否含此列待编码阶段核对；
                     若无则改为以 pct_chg ≥ 9.9% 近似涨停，并在 prompt 中告知 LLM 此为近似值)
     · 行业/概念排行 (从 money_flow_industry/sector 取 top10)
     · 资金流向      (money_flow_market + money_flow_stock TOP20 / BOTTOM20)
     · 强势股        (daily_quote ORDER BY pct_chg DESC LIMIT 20，过滤次新股/ST)
     · 成交额 TOP    (daily_quote ORDER BY amount DESC LIMIT 20)
   ─ 实时调 Tushare（无本地表，**见 §7「前置数据缺口」**）：
     · 大盘指数日线  调用 index_daily 拿上证000001.SH / 深证399001.SZ / 创业板399006.SZ / 科创50000688.SH

3. build (30→40%)
   ─ 装配为 SnapshotPayload，持久化到 daily_review.snapshot，status=generating

4. LLM 调用（思考模式开启）
   4a. 推理中 (40→65%)  流式接收 reasoning_content
   4b. 撰写中 (65→95%)  流式接收 content（首个 content delta 触发阶段切换）

5. finalize (95→100%)
   ─ Sanity check：articleMd 长度 < 2000 字 → status=failed，errorMessage='文章长度异常 (X chars)'
   ─ 成功 → status=completed，记录 tokenUsage
```

### 5.4 DeepSeek 调用规范

**编码前必读**：[.claude/skills/deepseek-api/SKILL.md](../../../.claude/skills/deepseek-api/SKILL.md) → `thinking_mode.md` / `multi_round_chat.md`。本设计文档**不锁定模型字符串**，由编码阶段对照文档确认。

硬约束（写入 `deepseek.service.ts`）：

- `baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'`
- `apiKey = process.env.DEEPSEEK_API_KEY`（缺失则启动期报错）
- `extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }` —— **思考参数必须在 `extra_body` 内，不能写成顶层字段**
- **不传**：`temperature` / `top_p` / `presence_penalty` / `frequency_penalty`（思考模式下被忽略）
- 单轮调用，无 `tools`，无需多轮历史拼接，`reasoning_content` 不回传后续请求
- 流式响应中 `reasoning_content` 与 `content` 是**两个独立增量字段**，分别累加：

```ts
let reasoning = '', article = ''
for await (const chunk of stream) {
  const delta = chunk.choices[0].delta
  if (delta.reasoning_content) reasoning += delta.reasoning_content
  if (delta.content)            article   += delta.content
}
```

- 超时：240s（思考模式延迟较长，预期 90-180s）
- 错误处理：抛出的 SDK 错误**完整**写入 `errorMessage`，并 `logger.error(err.stack)`（CLAUDE.md 规约）

### 5.5 错误处理与边界

| 场景 | 处理 |
|---|---|
| 依赖数据未同步 | 422 + 中文错误信息（最容易踩的坑，必须显式提示） |
| 并发重复触发同一日 | 该日已 `fetching` / `generating` → 409，返回现有任务的 SSE URL |
| 进程重启 | 内存 Subject 丢失，DB 状态保留；列表上看到「fetching 超过 5 分钟无更新」的记录显示「重置」按钮，将其 status 改为 failed 后允许重试 |
| LLM 返回过短/中断 | sanity check 判失败，不存半成品 articleMd（reasoning 可以保留以便排查） |
| LLM SDK 网络错 | 重试 1 次；仍失败 → status=failed，errorMessage 写入完整原因 |

### 5.6 不做的事

- 不引入任务队列中间件
- 不缓存 prompt / response
- 不向前端流式推送文章内容（前端仅看百分比 + 阶段名）
- 不限制单用户每日生成次数（admin 自律）
- 不接 COS / 不存视频音频

## 6. 前端

### 6.1 路由

`apps/web/src/router/index.ts` 新增：

```ts
{ path: '/daily-review', name: 'daily-review',
  component: () => import('../views/DailyReviewView.vue'),
  meta: { title: '每日复盘' } },
{ path: '/daily-review/:tradeDate', name: 'daily-review-detail',
  component: () => import('../views/DailyReviewDetailView.vue'),
  meta: { title: '复盘详情' } },
```

### 6.2 侧边栏

`apps/web/src/components/layout/Sidebar.vue`：

- `menuOptions` 在「资金流向」之后新增 `{ label: '每日复盘', key: 'daily-review', icon: renderIcon(NewspaperOutline) }`
- `activeKey` 计算逻辑改为基于路由前缀匹配，让 `daily-review-detail` 也高亮 `daily-review` 菜单项：

```ts
const activeKey = computed(() => {
  const name = route.name as string
  if (name?.startsWith('daily-review')) return 'daily-review'
  return name
})
```

### 6.3 组件树

```
apps/web/src/views/
  DailyReviewView.vue            列表页（keep-alive，刷新走 onActivated）
  DailyReviewDetailView.vue      详情页
apps/web/src/components/daily-review/
  ReviewCreateButton.vue         「新增复盘」按钮 + AppModal，仅 admin 渲染
  ReviewListTable.vue            n-data-table，行内嵌进度条
  ReviewProgressBar.vue          订阅 SSE 显示百分比 + 阶段名
  ReviewSnapshotCards.vue        详情顶部 4 指数 + 涨跌停 + 资金流总览卡片
  ReviewIndustryChart.vue        行业/概念排行柱状图（ECharts，复用 useECharts）
  ReviewMoneyFlowChart.vue       资金流 TOP/BOTTOM 双向条形图
  ReviewArticleViewer.vue        markdown-it 渲染 + 目录侧栏 + admin 推理过程折叠区
apps/web/src/composables/
  useDailyReviewApi.ts           REST 封装
  useDailyReviewProgress.ts      SSE EventSource 封装
```

### 6.4 列表页

```
┌─────────────────────────────────────────────────────┐
│ 每日复盘                       [新增复盘] ← admin only │
├─────────────────────────────────────────────────────┤
│ 状态过滤： [全部▾]  日期范围：[__]-[__]              │
├─────────────────────────────────────────────────────┤
│ 交易日       状态        生成耗时   创建人  操作       │
│ 20260512    ● 生成中 67% [进度条]    -    取消         │
│ 20260511    ✓ 已完成     4m12s    张三   查看 / 重生成 │
│ 20260510    ✗ 失败       —        张三   查看错误 / 重试│
│ ...                                                  │
└─────────────────────────────────────────────────────┘
```

- 「新增复盘」点击弹 `AppModal`（复用 [@/components/common/AppModal.vue](../../../apps/web/src/components/common/AppModal.vue)），含 `n-date-picker` 选交易日（默认最近交易日，使用本地 TZ 提取年月日 — CLAUDE.md「日期选择器是本地 TZ 例外」）+ 覆盖现有版本复选框 + 提交按钮放 `#actions` slot。
- 「生成中」行内嵌 `ReviewProgressBar` 实时订阅 SSE。
- 「重生成」「重试」「取消」「删除」操作仅 admin 渲染，依赖 `useAuth().isAdmin`。

### 6.5 详情页

```
┌─────────────────────────────────────────────────────────────┐
│ ← 返回列表   2026-05-12 复盘    生成于 15:08  耗时 3m12s [...]│
├─────────────────────────────────────────────────────────────┤
│ ┌───────┬───────┬───────┬───────┐                            │
│ │ 上证   │ 深证   │ 创业板 │ 科创50 │                            │
│ │ 4225  │ 13280 │ 2870  │ 1430  │                            │
│ │ +1.08%│ +1.42%│ +1.85%│ +4.65%│                            │
│ └───────┴───────┴───────┴───────┘                            │
│ ┌─────────────┬─────────────┬─────────────┐                  │
│ │ 涨家 4012   │ 跌家 1238   │ 涨停 92     │                  │
│ │ 涨停 92     │ 跌停 8      │ 炸板 18     │                  │
│ └─────────────┴─────────────┴─────────────┘                  │
├─────────────────────────────────────────────────────────────┤
│ 行业资金流向 TOP10                  [ECharts 横向柱状图]      │
│ 主力资金净流入 TOP10 / 净流出 TOP10  [ECharts 双向条形图]      │
├─────────────────────────────────────────────────────────────┤
│ [▸ 查看 AI 推理过程  (admin only, n-collapse 折叠)]          │
├─────────────────────────────────────────────────────────────┤
│  目录    │ # AI复盘正文（markdown 渲染）                       │
│  • 先给结论│   ## 一、先给结论                                  │
│  • 大盘全景│   ...                                              │
└─────────────────────────────────────────────────────────────┘
```

- 顶部 meta：交易日、生成时间、生成耗时、所用模型、token 用量（仅 admin 可见）
- 右上角 `[...]` 菜单：「重新生成」「删除」「复制 markdown」「下载 .md 文件」；前两个 admin only
- 失败态：不渲染正文，改为大号错误卡片 + 重试按钮
- 生成中态：可进入详情看 SSE 进度；snapshot 已写入的可提前渲染上半部分卡片与图表

### 6.6 状态管理与刷新规则

- 不引入 pinia store，本地 ref + `useDailyReviewApi`
- 列表页 `<keep-alive>` 缓存；刷新逻辑走 `onActivated`（CLAUDE.md Vue 3 watch 规范）
- 进度订阅用 `useEventSource` 自定义 hook，组件卸载时自动 close
- 生成完成事件回写到列表 ref，避免重新拉接口

### 6.7 Markdown 渲染

- 优先复用项目已有 markdown 渲染组件；若无则新增 `markdown-it` 依赖
- 不强行套用 ai-a-stock-daily 的 `#1A237E + #FF6D00` 配色，跟随主项目暗色主题；保留「目录侧栏 + 大字标题 + 引文块」版式

## 6.8 SSE 进度事件结构

```ts
type ProgressEvent =
  | { stage: 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'; percent: number; message?: string }
  | { stage: 'completed';  percent: 100 }
  | { stage: 'failed';     percent: number; error: string }
```

Controller 以 `text/event-stream` 输出，`data:` 字段为 `JSON.stringify(event)`。客户端 close 触发 server 端清理订阅。

## 7. 前置数据缺口

主项目目前**未持久化**以下数据，但本特性需要：

| 数据 | 现状 | 处理 |
|---|---|---|
| 大盘指数日线 | 无 `index_daily` 实体；Tushare `trade_cal` API 在 a-shares-sync-utils 里被调用但仅作运行时使用 | **snapshot-builder 在 fetch 阶段直接调 Tushare `index_daily`**（4 个指数当日数据，单次调用极小）。先**禁止**在 daily-review 模块外重复造一份指数日线同步逻辑——若后续别处也需要，再独立立项把指数日线纳入主同步管线。Tushare 接口参数与字段在编码前**必须**通过 `tushare-sync-dev` skill 查文档核对（CLAUDE.md 第三方 API 集成规范）。 |
| 涨跌停状态列 | `a_share_daily_quote` 是否含 `limit_status` 待编码阶段核对 | 若无：使用 `pct_chg ≥ 9.9%`（主板）/ `≥ 19.9%`（创业板/科创板）近似涨停，并在 LLM prompt 中明示「该日涨停统计为近似值」 |
| 交易日历 | Tushare `trade_cal` 似在运行时拉取，无本地表 | 校验 tradeDate 时若该日 a_share_daily_quote 行数 > 0 即视为合法交易日，避免新增一次 Tushare 调用 |

这些都属于「合理范围内的妥协」，不阻塞 MVP 上线。后续如要做美股映射、宏观段，再补齐独立的指数同步管线。

## 8. 数据库迁移

新增迁移文件 `apps/server/src/migration/<timestamp>-CreateDailyReview.ts`：

- 建表 `daily_review`，列定义见 §4.1
- 唯一索引 `UQ_daily_review_trade_date`
- 普通索引 `IDX_daily_review_status` 用于列表过滤
- 普通索引 `IDX_daily_review_created_at` 用于列表排序兜底

时间列**严格 timestamptz**（CLAUDE.md 时间规范）。

附 docker exec 验证脚本：

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d daily_review"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
  "SELECT trade_date, status, char_length(article_md) FROM daily_review ORDER BY trade_date DESC LIMIT 5;"
```

## 9. 配置与环境变量

`apps/server/.env`（新增）：

```
DEEPSEEK_API_KEY=<secret>
DEEPSEEK_BASE_URL=https://api.deepseek.com  # 可选，默认值
```

`apps/server/src/app.module.ts` 注册 `DailyReviewModule`。

## 10. 测试要点

- **单元测试**
  - `snapshot-builder.service` 的每个聚合 SQL：mock TypeORM，给假数据，断言输出结构与单位归一
  - `deepseek.service` 流式累加逻辑：mock SDK stream，验证 reasoning_content 与 content 分别累加
  - `daily-review.service` 5 阶段编排：mock 各子服务，验证状态流转与失败路径
- **集成测试**
  - 一条真实交易日的端到端：依赖测试库已 seed A 股数据；mock DeepSeek（避免烧钱），断言记录写入完整、SSE 事件序列正确
  - 重复触发同日 → 409
  - 缺数据 → 422
- **Mock 红线**（CLAUDE.md 第三方 API 集成规范）
  - DeepSeek 调用的 mock 测试**不验证 API 契约**，必须额外有一次人工集成验证（用最小 prompt + 最低 effort 跑通真实 API）

## 11. 上线步骤

1. PR-1：实体 + migration + 模块骨架（空 controller/service）
2. PR-2：snapshot-builder（DB 聚合，可独立跑通并人工核对一日数据）
3. PR-3：deepseek.service + prompt 模板（先 dry-run，用最小 effort 验证调用规范）
4. PR-4：service 编排 + SSE 进度推送
5. PR-5：前端列表 + 详情 + 创建弹窗
6. PR-6：admin 推理过程折叠区 + 重试/删除/重生成
7. 灰度：admin 触发一周，观察 token 成本与失败率
8. 视频/音频迭代另行立项

## 12. 后续迭代（不在 MVP 范围）

- TTS 配音（百度/讯飞/Azure）→ 落 COS
- ffmpeg 视频合成（横屏 + 竖屏）
- 美股映射段（接 yfinance 或 Tushare `index_global` / `us_daily`）
- 宏观/消息面段（接新闻 API）
- 公众号 / 抖音自动发布
- 复盘版本多实例（保留历史）
- LLM 用量配额与成本看板

## 13. 风险与权衡

| 风险 | 应对 |
|---|---|
| DeepSeek 思考模式延迟高，前端等待体验差 | 后台异步 + SSE 阶段显示「AI 推理中 / AI 撰写中」，让用户感知到进度 |
| LLM 输出质量不稳定 | sanity check 长度 + admin 可一键重生成；prompt 模板单独放文件便于迭代 |
| A 股数据未同步导致复盘空数据 | validate 阶段显式拦截 + 中文错误提示，避免 CLAUDE.md 警告过的「伪装成功」 |
| 思考链 token 费用 | tokenUsage 落库便于成本分析；MVP 不做硬限制，admin 自律；后续可加配额 |
| 内存 SSE Subject 在进程重启后丢失 | 列表上对「fetching 超过 5 分钟无更新」的记录提供「重置」操作 |
