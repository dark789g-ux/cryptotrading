# Tool-Calling Daily Review Agent 设计

- 日期：2026-05-13
- 状态：草稿，待审阅
- 涉及模块：`apps/server/src/daily-review`、`apps/web/src/components/daily-review`
- 关联前作：`feat(daily-review): 抽象 LlmProvider 接口` (8e707bb)、`feat(daily-review/web): 详情页接入 AI 思考过程实时面板` (3fc0520)

## 1 背景与目标

现有 `daily-review` 模块通过单次 LLM 调用 + 大 JSON snapshot 产出 5000-8000 字的 A 股复盘文章，prompt 强制八段结构。对比参考报告（公众号「知行 AI 量化」2026-05-13 复盘文章），现有产出在以下维度有结构性差距：

| 差距维度 | 现状 | 参考报告 |
|---|---|---|
| 板块归因 | 仅基于资金面与涨幅 | 显式引用 DeepSeek 融资、工信部新政等外部催化 |
| 盘后/隔夜 | 缺失 | 美股、芯片股、中概股、大宗商品独立成段 |
| 宏观与政策 | 缺失 | 独立一段，列出当日 5-8 条政策事件 |
| 明日操作清单 | 缺失 | 含「开盘前/30 分钟/盘中/收盘前」四时段表 + 三信号 + 五纪律 |
| 资金切换路径 | 弱 | 机构 / 游资 / 政策资金分类 |
| 与历史复盘联动 | 无 | 验证「上次对今日的判断」 |

目标：在保留现有 NestJS / TypeORM / WebSocket gateway 架构的前提下，把生成流程升级为 **三阶段 tool-calling pipeline**，让 LLM 在中间阶段自主追查异常并积累结构化证据，由 Writer 阶段固定结构出稿。

## 2 决策摘要（用户已确认）

| 决策项 | 决策 |
|---|---|
| Agent 形态 | Tool-Calling Agent |
| 核心能力 | LLM 自主追查异常 |
| 外部新闻源 | LLM 外部搜索 API (Tavily 主, Serper 兜底) |
| Loop 控制 | 分阶段硬约束（Stage0 / Stage1 / Stage2） |
| 工具集颗粒度 | 5 个中颗粒度工具 |
| 隔夜美股 | Stage0 静态拉，不做成 tool |
| LLM 模型 | Investigator 与 Writer 共用同一 model |
| evidencePack 历史 | 持久化到 DB，可被 `read_previous_review` 回查 |
| 报告段数 | 由八段扩为九段（新增「明日操作清单」） |
| evidencePack 缺失降级 | 接受，Stage2 写「外部归因数据缺失」并跳过第六段 |
| 板块拆解硬性数量 | 3-5 个 |
| 框架 | **不引入 LangChain**，复用现有 LlmProvider 抽象手写 tool loop |
| `macro_events` 表 | 现在就建 |
| 前端工具调用面板 | admin-only |

## 3 三阶段流水线

```
Stage 0 · Pre-warm  (纯代码，无 LLM)
  └ SnapshotBuilderService 并行 fire:
      ├ 现有: indices / updown / sectors / moneyFlow / strongStocks / volumeTop
      ├ 新增 OvernightMarketService.fetch()      → snapshot.overnight
      ├ 新增 MacroCalendarService.fetchToday()   → snapshot.macroCalendar
      └ 新增 ReviewHistoryService.previousSummary(1) → snapshot.previousReviewSummary

Stage 1 · Investigator  (LLM + tool-calling)
  ├ Input: BaseSnapshot
  ├ Tools: 5 个中颗粒度（见 §5）
  ├ Budget: max_tool_calls=8, max_tokens=12000, 整阶段超时 5 分钟
  ├ Output: EvidencePack (结构化 JSON)
  └ 失败降级: evidencePack=null，Stage2 仍跑

Stage 2 · Writer  (LLM, no tools, 1 次)
  ├ Input: BaseSnapshot + EvidencePack
  └ Output: 5000-8000 字 Markdown, 固定 9 段
```

`DailyReviewService.runPipeline()` 的 stage 枚举从 `validate|fetch|build|reasoning|writing|finalize` 扩展为 `validate|fetch|build|investigate|reasoning|writing|finalize`，新增 `investigate` 阶段会产生 `tool_call` 事件流推给前端。

## 4 数据层变更

### 4.1 `DailyReviewEntity` 新增列

```typescript
@Column({ type: 'jsonb', nullable: true })
evidencePack: EvidencePack | null;

@Column({ type: 'jsonb', nullable: true })
investigatorToolCalls: ToolCallLog[] | null;

@Column({ type: 'int', nullable: true })
investigatorToolCallCount: number | null;
```

Migration：纯加列，无 NOT NULL，对存量数据零影响。

### 4.2 新表 `macro_events`

```sql
CREATE TABLE macro_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_date  date NOT NULL,
  event_time  time NULL,
  title       varchar(255) NOT NULL,
  category    varchar(50)  NOT NULL,  -- monetary | fiscal | data | corporate
  importance  varchar(10)  NOT NULL,  -- low | mid | high
  detail      text NULL,
  source_url  varchar(500) NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_macro_events_date ON macro_events(event_date);
```

`MacroCalendarService.fetchToday(tradeDate)` 读 `event_date BETWEEN tradeDate - 1 AND tradeDate + 3`，区分今日发生 / 未来三日预告。

### 4.3 `SnapshotPayload` 类型扩展

```typescript
interface SnapshotPayload {
  // 现有字段保留
  indices: IndexQuote[];
  updownDist: UpdownDist;
  limitStats: LimitStats;
  industryRank: SectorRank[];
  conceptRank: SectorRank[];
  moneyFlow: MoneyFlow;
  strongStocks: StrongStock[];
  volumeTop: VolumeStock[];
  generatedAt: string;

  // 新增
  overnight: OvernightPayload | null;
  macroCalendar: MacroCalendarPayload | null;
  previousReviewSummary: { tradeDate: string; nextDayJudgmentExcerpt: string } | null;
}

interface OvernightPayload {
  usIndices: { name: string; close: number; pctChg: number; quotedAt: string }[];
  chipStocks: { ticker: string; pctChg: number; note?: string }[];
  chinaConcepts: { ticker: string; pctChg: number }[];
  commodities: { name: string; price: number; unit: string; quotedAt: string }[];
}

interface MacroCalendarPayload {
  todayEvents: { time: string; event: string; importance: 'low'|'mid'|'high' }[];
  upcomingEvents: { date: string; event: string }[];
}
```

### 4.4 `EvidencePack` 类型

```typescript
interface EvidencePack {
  hypotheses: Array<{
    claim: string;
    supportingFacts: Array<
      | { type: 'news'; source: string; summary: string; url: string; publishedAt: string }
      | { type: 'moneyflow'; summary: string }
      | { type: 'concept_constituent'; summary: string; tsCodes: string[] }
      | { type: 'top_list'; summary: string; tsCode: string }
    >;
    relevantSectors: string[];
    relevantStocks: string[];   // ts_code
  }>;
  yesterdayVerification: {
    yesterdayJudgment: string;
    todayValidated: boolean;
    deviationNote: string;
  } | null;
  rawText?: string;             // 解析失败时兜底
}

interface ToolCallLog {
  callIndex: number;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  startedAt: string;            // UTC 墙钟字符串
  error?: string;
}
```

## 5 Stage 1 · Investigator 详细设计

### 5.1 工具集（5 个）

| Tool | 参数 | 返回 | 背后实现 |
|---|---|---|---|
| `search_news` | `query: string`（≤80 字）, `recencyDays?: number`（默认 7） | `{ hits: NewsHit[] }` | `NewsSearchClient` Tavily 主 / Serper 兜底 |
| `lookup_stock` | `tsCode: string` | `{ basic, recentFlow, concepts, topListEntries }` | `a_share_symbols` + `money_flow_stocks` 聚合 + Tushare `top_list` |
| `lookup_concept` | `conceptName: string` | `{ matchedName, todayPctChg, constituents }` | `money_flow_sectors`/`money_flow_industries` + 成分股 JOIN。**不内嵌新闻检索**；如需催化信息，LLM 自行接着调 `search_news` |
| `read_previous_review` | `offsetDays: number`（1=上一交易日） | `{ tradeDate, nextDayJudgment, evidencePack }` | `daily_review` 表，按 `tradeDate ORDER BY DESC LIMIT 1 OFFSET (offsetDays-1)` |
| `fetch_top_list` | `mode: 'daily' \| 'recent5d'`；`mode=daily` 时必填 `tradeDate`；`mode=recent5d` 时必填 `tsCode` | `mode=daily` → `{ entries: TopListEntry[] }`（当日完整榜）；`mode=recent5d` → `{ entries: TopListEntry[]; appearCount: number }`（指定股近 5 日上榜历史） | Tushare `top_list` + `top_inst` |

工具 schema 用 JSON Schema（OpenAI tool-use 协议格式），由 `ToolDispatcherService.getSchemas()` 集中生成。

### 5.2 Investigator System Prompt

```
你是 A 股资深研究员，负责为今日复盘补充「为什么」层面的归因证据。

【你的输入】
- 今日市场 snapshot（指数 / 涨跌分布 / 板块 / 资金流 / 强势股 / 隔夜美股 / 已知宏观日历 / 上一交易日复盘判断摘要）

【你的任务】
1. 通读 snapshot，识别 3-7 条值得追查的异常或亮点（先在 reasoning 中写出 hypothesis 列表）
2. 用工具逐条求证；每个 hypothesis 必须有至少 1 条 supportingFact 才能保留
3. 调完所有工具后输出最终 evidence pack JSON（schema 见下）

【硬约束】
- 最多调 8 次工具（超过自动截断）
- 单次 query 字符串 ≤ 80 字
- 不要为同一个 hypothesis 调超过 2 次工具
- search_news 单 pipeline 不超过 4 次
- 调够之后直接回复 {"done": true, "evidencePack": {...}}，不要再调工具

【evidence pack JSON schema】
{
  "hypotheses": [
    {
      "claim": "string，单条不超过 80 字",
      "supportingFacts": [
        // 任选下列任一类型
        { "type": "news", "source": "string", "summary": "string", "url": "string", "publishedAt": "ISO8601" },
        { "type": "moneyflow", "summary": "string" },
        { "type": "concept_constituent", "summary": "string", "tsCodes": ["601138.SH"] },
        { "type": "top_list", "summary": "string", "tsCode": "601138.SH" }
      ],
      "relevantSectors": ["string"],
      "relevantStocks": ["ts_code"]
    }
  ],
  "yesterdayVerification": {
    "yesterdayJudgment": "string",
    "todayValidated": true,
    "deviationNote": "string"
  } | null
}

【数据纪律】
- supportingFact 必须能在工具返回里追溯，禁止编造 url / publishedAt
- relevantStocks 用 ts_code 而非中文名（如 "601138.SH"）
- 涉及上次判断验证时，必须先调 read_previous_review(1)
```

### 5.3 控制循环（手写，非 LangChain）

```typescript
// llm/openai-compat-base.provider.ts 新增
async runToolLoop(args: {
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSchema[];
  maxToolCalls: number;
  maxTokens: number;
  onToolCall?: (call: ToolCallLog) => void;
  onProgress?: ProgressCb;
}): Promise<{
  evidencePack: EvidencePack | null;
  toolCallLog: ToolCallLog[];
  tokenUsage: TokenUsage;
}> {
  const messages = [
    { role: 'system', content: args.systemPrompt },
    { role: 'user', content: args.userPrompt },
  ];
  const toolCallLog: ToolCallLog[] = [];

  for (let i = 0; i < args.maxToolCalls + 1; i++) {
    const resp = await this.chatCompletion({
      messages, tools: args.tools, tool_choice: 'auto',
      max_tokens: args.maxTokens,
    });
    const msg = resp.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // LLM 自然结束 → 解析 evidencePack
      return parseFinalMessage(msg, toolCallLog, resp.usage);
    }

    if (i === args.maxToolCalls) {
      // 已达预算上限，再追加一条 user 消息强制收口
      messages.push({
        role: 'user',
        content: '已达工具调用预算上限，请立即输出 evidence pack JSON，不要再调工具。',
      });
      continue;
    }

    for (const tc of msg.tool_calls) {
      const log = await dispatchTool(tc, args.onToolCall);
      toolCallLog.push(log);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(log.result) });
    }
  }

  // 兜底：仍未收口
  return { evidencePack: null, toolCallLog, tokenUsage };
}
```

### 5.4 失败降级矩阵

| 失败信号 | 处理 |
|---|---|
| 工具调用超 8 次 | 强制 stop，已收集证据进 Stage2 |
| 单次工具异常（Tavily 超时 / Tushare 502） | 返回 `{ error: "..." }` 给 LLM，LLM 自动绕开 |
| LLM Stage1 总超时 5 分钟 | `evidencePack=null`，Stage2 走降级写作 |
| evidencePack JSON 解析失败 | 兜底为 `{ hypotheses: [], rawText }`，Stage2 仍能产出 |

## 6 Stage 2 · Writer 详细设计

### 6.1 报告结构（9 段）

| 段号 | 段名 | 数据源 |
|---|---|---|
| 0 | 开篇声明 | 模板硬编码 |
| 一 | 先给结论 | snapshot + evidencePack.yesterdayVerification |
| 二 | 大盘全景数据 | snapshot |
| 三 | 重点板块拆解（**3-5 个**） | snapshot + evidencePack.hypotheses |
| 四 | 潜力板块跟踪 | snapshot + evidencePack |
| 五 | 盘后/隔夜信息 | snapshot.overnight |
| 六 | 宏观与政策消息面 | evidencePack.hypotheses 中 type=news 的 facts + snapshot.macroCalendar |
| 七 | 综合结论与策略建议 | 综合 |
| 八 | 重点个股观察池 | snapshot.strongStocks + evidencePack 个股归因 |
| 九 | 最实战的结论：明日操作清单 | 综合（含 4 时段表 + 3 信号 + 5 纪律） |

### 6.2 Writer Prompt 关键约束

在现有 `SYSTEM_PROMPT` 基础上叠加：

```
【新增结构约束】
- 「重点板块拆解」必须 3-5 个板块，每个板块写「核心驱动因素」小节，
  显式引用 evidencePack.hypotheses[i].supportingFacts；
  无 evidence 的板块写「暂无外部催化证据，仅由资金面驱动」，禁止虚构
- 「宏观与政策消息面」逐条来自 evidencePack 中 type=news 的 facts
  + snapshot.macroCalendar.todayEvents，禁止补充其它事件
- 「最实战的结论」必须包含：
    - 4 时段表：开盘前 9:15-9:25 / 开盘 30 分钟 9:30-10:00 / 盘中 10:00-14:30 / 收盘前 14:45-15:00
    - 3 个信号：量能阈值 / 龙头股阈值 / 指数关键位
    - 5 条纪律：不追高 / 止损 / 仓位 / 不逆势加仓 / 收盘前减仓
- 若 evidencePack.yesterdayVerification 非空，第一段末尾加「上次判断验证」一句

【evidencePack 缺失降级】
- 若 evidencePack 为 null：
  - 跳过第六段，仅保留 macroCalendar 部分
  - 第三段所有板块归因统一写「基于资金面与盘面表现推断」
  - 开篇声明追加一句「本报告外部归因数据缺失，归因仅供参考」
```

## 7 服务依赖图

```
DailyReviewService
  ├ SnapshotBuilderService               (改)
  │   ├ TushareClientService              (现有)
  │   ├ OvernightMarketService            (新)
  │   ├ MacroCalendarService              (新)
  │   └ ReviewHistoryService              (新)
  ├ InvestigatorService                   (新)
  │   ├ LlmProvider.runToolLoop()         (新接口)
  │   └ ToolDispatcherService             (新)
  │       ├ NewsSearchClient              (新, Tavily 主)
  │       ├ TushareClientService          (现有)
  │       ├ ReviewHistoryService          (新)
  │       └ DataSource                    (现有)
  ├ LlmProvider                           (现有, 加 runToolLoop)
  └ DailyReviewProgressGateway            (现有, 新增 tool_call 事件)
```

## 8 前端变更

- `apps/web/src/components/daily-review/ReviewThinkingPanel.vue`：
  - 新增 stage `investigate` 的进度条段
  - 新增「工具调用」折叠区，**admin-only** 可见
  - WebSocket 事件流增加 `type: 'tool_call'` 的处理，渲染 toolName / args 摘要 / 耗时

- `ReviewDetailPage.vue`：
  - admin 用户在「思考过程」面板下方新增「Evidence Pack」JSON 折叠面板
  - 普通用户只看到文章主体 + stage 进度

## 9 环境变量

```
TAVILY_API_KEY=...
SERPER_API_KEY=...                      # 可选
DAILY_REVIEW_TOOL_BUDGET=8
DAILY_REVIEW_TOOL_TIMEOUT_MS=15000
DAILY_REVIEW_INVESTIGATOR_TIMEOUT_MS=300000   # 5 分钟
DAILY_REVIEW_OVERNIGHT_ENABLED=true
```

## 10 任务拆分（供并行开发）

按"互不相交的文件域"切，避免 agent 互相覆盖：

| 任务 ID | 文件域 | 内容 |
|---|---|---|
| T1 | `apps/server/src/entities/daily-review/`, 新 migration | DailyReviewEntity 加列 + macro_events 表 migration |
| T2 | `apps/server/src/daily-review/overnight/` | OvernightMarketService + 测试 |
| T3 | `apps/server/src/daily-review/macro/` | MacroCalendarService + 实体 + 测试 |
| T4 | `apps/server/src/daily-review/history/` | ReviewHistoryService + 测试 |
| T5 | `apps/server/src/daily-review/news/` | NewsSearchClient (Tavily + Serper) + 测试 |
| T6 | `apps/server/src/daily-review/tools/` | ToolDispatcherService + 5 个 tool handler + 测试 |
| T7 | `apps/server/src/daily-review/llm/` | LlmProvider.runToolLoop() 实现 + 测试 |
| T8 | `apps/server/src/daily-review/investigator.service.ts` (新) + `daily-review.service.ts` (改 runPipeline) | Stage1 主循环 + pipeline 编排 |
| T9 | `apps/server/src/daily-review/prompts/` | article-prompt.ts 升级到 9 段 + investigator-prompt.ts 新增 |
| T10 | `apps/server/src/daily-review/snapshot-builder.service.ts` (改) | 接入 T2/T3/T4 并行拉 |
| T11 | `apps/web/src/components/daily-review/` | ReviewThinkingPanel 加 tool_call 渲染 + admin 折叠 |
| T12 | `apps/server/src/daily-review/daily-review-progress.gateway.ts` (改) | 新增 tool_call 事件 |

依赖：T1 → T3（macro_events 实体）；T2/T3/T4 → T10；T5/T6 → T8；T7 → T8；T9 独立。可分两批并行：
- Batch 1（无相互依赖）：T1, T2, T4, T5, T7, T9, T11
- Batch 2（依赖 Batch 1）：T3 (依赖 T1), T6 (依赖 T5), T10 (依赖 T2/T3/T4), T8 (依赖 T6/T7), T12

## 11 测试策略

- 每个新 service 都有 unit test（mock 外部依赖）
- ToolDispatcherService 集成测试：用真实 Tushare key + 真实 Tavily key，跑一次 5 个工具的完整调用
- LlmProvider.runToolLoop 单测：mock chatCompletion 返回伪 tool_calls 序列，验证循环终止条件
- 端到端测试：在测试库准备一份 fixture snapshot，调 DeepSeek（或 Mimo）真实接口跑完三阶段，断言：
  - `evidencePack.hypotheses.length >= 3`
  - articleMd 包含 9 段二级标题
  - articleMd 长度 5000-8000 字
  - `investigatorToolCallCount <= 8`

## 12 风险与回滚

| 风险 | 缓解 |
|---|---|
| Tavily/Serper 都不可用 | NewsSearchClient 返回 `{ hits: [], degraded: true }`，LLM 看到后跳过 news 类 hypothesis |
| LLM tool-use 兼容性差（Mimo 早期版本） | LlmProvider 在 `capabilities` 字段标注 `supportsToolUse`；不支持的 provider 直接降级为「skip stage1」 |
| Tushare 7000 积分 us_daily / top_list 不够 | OvernightMarketService 加配置开关，缺失时填空数组 |
| Stage1 token 成本激增 | `DAILY_REVIEW_TOOL_BUDGET` 可调；admin 列表页新增「token 总消耗」列做监控 |
| 文章质量回退 | 保留 `articleMd` 全字段 + `evidencePack` 历史快照，可一键回滚到旧 pipeline（保留旧 prompt 入口作降级路径） |

## 13 验收清单

- [ ] 用 2026-05-13 作为目标日跑一次，产出文章包含 9 段二级标题
- [ ] 「重点板块拆解」段含 3-5 个板块，每个板块至少引用 1 条 supportingFact
- [ ] 「宏观与政策消息面」段至少 3 条事件且全部能在 evidencePack 中追溯
- [ ] 「明日操作清单」段含 4 时段表 + 3 信号 + 5 纪律
- [ ] admin 用户在前端能看到 `tool_call` 事件流与 evidence pack JSON
- [ ] 普通用户看到的 API 响应不含 evidencePack / investigatorToolCalls / tokenUsage / llmModel
- [ ] Stage1 强制超时降级用例：mock Investigator 卡住 6 分钟，pipeline 仍能完成且开篇声明含「外部归因数据缺失」一句

---

数据来源说明：参考文章「2026-05-13 复盘以及05-14日前瞻」抓取自微信公众号「知行 AI 量化」，本设计仅做架构对标，不复制任何文字内容。
