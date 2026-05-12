# 每日复盘 LLM 抽象 + Mimo 兼容 设计稿

- 日期：2026-05-13
- 模块：`apps/server/src/daily-review`
- 目标：让每日复盘的 LLM 调用支持在 DeepSeek 与小米 Mimo 之间运行时切换

## 一、背景与目标

当前每日复盘的 LLM 调用由 `apps/server/src/daily-review/deepseek.service.ts` 承担，硬编码使用 DeepSeek（OpenAI SDK + `https://api.deepseek.com`），并通过 `extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' }` 启用思考模式。

小米 Mimo 开放平台同样提供 OpenAI 兼容 API（参见 `https://platform.xiaomimimo.com/llms-full.txt`），且：

- BaseURL：`https://api.xiaomimimo.com/v1`
- 主推模型 ID：`mimo-v2.5-pro`
- 思考模式开关字段名与 DeepSeek 一致：顶层 `thinking: { type: 'enabled' | 'disabled' }`
- 响应/流式字段：`message.reasoning_content` + `message.content`（与 DeepSeek 同形态）
- **不支持 `reasoning_effort`**（官方文档未提及此字段）
- 思考模式下 `mimo-v2.5-pro`/`mimo-v2.5` 的 `temperature` 会被强制为 1.0（当前我们未传 `temperature`，不受影响）
- 鉴权：OpenAI SDK 默认 `Authorization: Bearer` 与 Mimo curl 示例的 `api-key` header 都接受

目标：把"具体 LLM provider"作为运行时可切换的能力沉淀下来，保留 DeepSeek 的可用性，新增 Mimo 支持，且为后续接入第三家 provider 留出零侵入扩展点。

## 二、关键设计决策（已与用户确认）

| 维度 | 决策 |
|---|---|
| 兼容形态 | 运行时切换（多 provider 共存于代码层，靠 env 选一家生效） |
| Mimo 默认模型 | `mimo-v2.5-pro` |
| 抽象粒度 | `LlmProvider` 接口 + 双实现（`DeepseekLlmProvider`、`MimoLlmProvider`） |
| Env 配置 | `LLM_PROVIDER` + 统一 `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL` 四件套 |
| 旧 `DEEPSEEK_*` 变量 | 一次性废弃（删除 `.env.example` / 部署文档中所有引用，代码不留 fallback） |

## 三、架构

新增 `apps/server/src/daily-review/llm/` 目录承担 LLM provider 抽象：

```
daily-review/
  llm/
    llm-provider.interface.ts        # 接口定义 + DI token
    openai-compat-base.provider.ts   # 共享 stream-loop 抽象基类
    deepseek.provider.ts             # buildExtraBody → { thinking, reasoning_effort: 'high' }
    mimo.provider.ts                 # buildExtraBody → { thinking: { type: 'enabled' } }
  daily-review.module.ts             # 改为工厂按 LLM_PROVIDER 选实例
  daily-review.service.ts            # 注入 LlmProvider 接口（不再依赖 DeepseekService 具体类）
```

`DailyReviewService` 只看到 `LlmProvider` 接口，对 provider 是哪家无感知。两家 provider 的流式字段（`delta.reasoning_content` + `delta.content` + `usage`）完全一致，因此基类承担：
- OpenAI SDK 调用与流式循环
- reasoning / content / usage 三类 delta 的进度事件推送
- stage 切换（reasoning → writing）耗时记录
- 最终 `{ article, reasoning, tokenUsage }` 组装

子类只覆写 `buildExtraBody()` 一处差异。

## 四、接口与文件级设计

### 4.1 `llm/llm-provider.interface.ts`

```ts
import type { ProgressEvent, TokenUsage } from '../daily-review.types';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmProvider {
  readonly modelName: string;
  generateArticle(
    snapshotJson: string,
    onProgress: (e: ProgressEvent) => void,
  ): Promise<{ article: string; reasoning: string; tokenUsage: TokenUsage | null }>;
}
```

### 4.2 `llm/openai-compat-base.provider.ts`

抽象基类，把当前 `deepseek.service.ts:21-72` 的 stream-loop 逻辑**原样**搬过来：

```ts
import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt } from '../prompts/article-prompt';
import type { ProgressEvent, TokenUsage } from '../daily-review.types';
import type { LlmProvider } from './llm-provider.interface';

@Injectable()
export abstract class OpenAiCompatLlmProvider implements LlmProvider {
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly client: OpenAI,
    private readonly _model: string,
  ) {}

  get modelName(): string {
    return this._model;
  }

  protected abstract buildExtraBody(): Record<string, unknown>;

  async generateArticle(
    snapshotJson: string,
    onProgress: (e: ProgressEvent) => void,
  ): Promise<{ article: string; reasoning: string; tokenUsage: TokenUsage | null }> {
    const stream: any = await (this.client.chat.completions.create as any)({
      model: this._model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(JSON.parse(snapshotJson)) },
      ],
      stream: true,
      extra_body: this.buildExtraBody(),
    });

    let reasoning = '';
    let article = '';
    let usage: any = null;
    const reasoningStartedAt = Date.now();
    let writingStarted = false;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      // TODO: 需集成测试验证两家真实 stream 中 delta.reasoning_content 字段名（mock 单测不验证第三方契约）
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        onProgress({ type: 'reasoning_delta', text: delta.reasoning_content, ts: Date.now() });
      }
      if (delta?.content) {
        if (!writingStarted) {
          writingStarted = true;
          const now = Date.now();
          onProgress({ type: 'stage_done', stage: 'reasoning', durationMs: now - reasoningStartedAt, ts: now });
          onProgress({ type: 'stage', stage: 'writing', percent: 70, ts: now });
        }
        article += delta.content;
        onProgress({ type: 'content_delta', text: delta.content, ts: Date.now() });
      }
      if (chunk.usage) usage = chunk.usage;
    }

    const tokenUsage: TokenUsage | null = usage ? {
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      reasoning: usage.reasoning_tokens ?? 0,
      total: usage.total_tokens,
    } : null;
    if (tokenUsage) onProgress({ type: 'usage', tokens: tokenUsage, ts: Date.now() });

    return { article, reasoning, tokenUsage };
  }
}
```

### 4.3 `llm/deepseek.provider.ts`

```ts
import { Injectable } from '@nestjs/common';
import { OpenAiCompatLlmProvider } from './openai-compat-base.provider';

@Injectable()
export class DeepseekLlmProvider extends OpenAiCompatLlmProvider {
  protected buildExtraBody(): Record<string, unknown> {
    return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
  }
}
```

### 4.4 `llm/mimo.provider.ts`

```ts
import { Injectable } from '@nestjs/common';
import { OpenAiCompatLlmProvider } from './openai-compat-base.provider';

@Injectable()
export class MimoLlmProvider extends OpenAiCompatLlmProvider {
  // Mimo 文档未提供 reasoning_effort；mimo-v2.5-pro/v2.5/v2-pro/v2-omni 默认即开启 thinking，
  // 显式写一次保证语义不被 SDK 默认值意外覆盖
  // TODO: 需集成测试验证 Mimo 真实 stream 中 delta.reasoning_content 字段名与 DeepSeek 是否完全一致
  protected buildExtraBody(): Record<string, unknown> {
    return { thinking: { type: 'enabled' } };
  }
}
```

### 4.5 `daily-review.module.ts`

```ts
import { LLM_PROVIDER } from './llm/llm-provider.interface';
import { DeepseekLlmProvider } from './llm/deepseek.provider';
import { MimoLlmProvider } from './llm/mimo.provider';

const LLM_CLIENT = 'LLM_CLIENT';

const llmClientProvider = {
  provide: LLM_CLIENT,
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) =>
    new OpenAI({
      apiKey: cfg.getOrThrow<string>('LLM_API_KEY'),
      baseURL: cfg.getOrThrow<string>('LLM_BASE_URL'),
      timeout: 240_000,
    }),
};

const llmProviderProvider = {
  provide: LLM_PROVIDER,
  inject: [LLM_CLIENT, ConfigService],
  useFactory: (client: OpenAI, cfg: ConfigService) => {
    const kind = cfg.getOrThrow<string>('LLM_PROVIDER');
    const model = cfg.getOrThrow<string>('LLM_MODEL');
    switch (kind) {
      case 'deepseek': return new DeepseekLlmProvider(client, model);
      case 'mimo':     return new MimoLlmProvider(client, model);
      default:
        throw new Error(`Unknown LLM_PROVIDER: ${kind} (expected 'deepseek' or 'mimo')`);
    }
  },
};
```

未识别的 `LLM_PROVIDER` 在应用启动阶段直接抛错（fail-fast），避免静默回退到任意一家。

### 4.6 `daily-review.service.ts`

仅 3 处改动：

| 位置 | 改前 | 改后 |
|---|---|---|
| import 段（行 9） | `import { DeepseekService } from './deepseek.service'` | `import { LLM_PROVIDER, type LlmProvider } from './llm/llm-provider.interface'` |
| 构造函数（行 24） | `private readonly deepseek: DeepseekService` | `@Inject(LLM_PROVIDER) private readonly llm: LlmProvider` |
| 调用点（行 129、146） | `this.deepseek.generateArticle(...)` / `this.deepseek.modelName` | `this.llm.generateArticle(...)` / `this.llm.modelName` |

## 五、Env 配置

`apps/server/.env.example` 中删除以下 3 行：

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

替换为：

```dotenv
# LLM provider for daily-review
# LLM_PROVIDER 可选值：deepseek | mimo
#   - deepseek: LLM_BASE_URL=https://api.deepseek.com,        LLM_MODEL=deepseek-v4-pro
#   - mimo:     LLM_BASE_URL=https://api.xiaomimimo.com/v1,   LLM_MODEL=mimo-v2.5-pro
LLM_PROVIDER=mimo
LLM_API_KEY=
LLM_BASE_URL=https://api.xiaomimimo.com/v1
LLM_MODEL=mimo-v2.5-pro
```

若 `docker-compose.prod.yml` 或部署文档（含 README）里有 `DEEPSEEK_*` 引用，一并改成 `LLM_*` 形态；代码层不保留任何 fallback。

## 六、测试策略

### 6.1 删除

- `apps/server/src/daily-review/deepseek.service.ts`
- `apps/server/src/daily-review/deepseek.service.spec.ts`

### 6.2 新增

- `llm/openai-compat-base.provider.spec.ts`
  - mock 一个 async-iterable stream（含 reasoning_delta / content_delta / usage 三类 chunk）
  - 用一个最小子类（`buildExtraBody → {}`）验证：
    - reasoning_content delta 触发 `reasoning_delta` 进度事件
    - 首个 content delta 触发 `stage_done(reasoning)` + `stage(writing,70)` 事件
    - 流结束后推送 `usage` 事件
    - 返回 `{ article, reasoning, tokenUsage }` 字段正确组装
- `llm/deepseek.provider.spec.ts`
  - 仅断言 `buildExtraBody()` 返回 `{ thinking: { type: 'enabled' }, reasoning_effort: 'high' }`
- `llm/mimo.provider.spec.ts`
  - 断言 `buildExtraBody()` 返回 `{ thinking: { type: 'enabled' } }`，**不包含** `reasoning_effort` 键

### 6.3 修改

- `daily-review.service.spec.ts`
  - 把对 `DeepseekService` 类型的 mock 替换为对 `LlmProvider` 接口的 mock；行为断言（调用次数、参数、返回值传递）不变

### 6.4 集成测试缺口（按 CLAUDE.md "Mock 单测不验证第三方契约"）

`mimo.provider.ts` 头部已写入 `// TODO: 需集成测试验证 Mimo 真实 stream 中 delta.reasoning_content 字段名与 DeepSeek 是否完全一致`。验证方式：切到 `LLM_PROVIDER=mimo` 跑一条真实复盘，核对：
- 前端"思考过程"面板能持续吐 reasoning 增量
- 最终落库的 `reasoning_content` 字段非空
- `tokenUsage.reasoning` 非 0

## 七、文件改动清单（实施视角，便于拆任务）

**新增（互不相交，可并行）：**
- `daily-review/llm/llm-provider.interface.ts`
- `daily-review/llm/openai-compat-base.provider.ts`
- `daily-review/llm/deepseek.provider.ts`
- `daily-review/llm/mimo.provider.ts`
- `daily-review/llm/openai-compat-base.provider.spec.ts`
- `daily-review/llm/deepseek.provider.spec.ts`
- `daily-review/llm/mimo.provider.spec.ts`

**修改（必须等新文件就位后再改）：**
- `daily-review/daily-review.module.ts`
- `daily-review/daily-review.service.ts`
- `daily-review/daily-review.service.spec.ts`
- `apps/server/.env.example`
- 若存在：`docker-compose.prod.yml`、README、其它部署文档中的 `DEEPSEEK_*` 引用

**删除（依赖最后一步）：**
- `daily-review/deepseek.service.ts`
- `daily-review/deepseek.service.spec.ts`

## 八、风险与待验证项

1. **Mimo 真实流式 delta 字段名**：官方 llms-full.txt 仅展示非流式响应 `message.reasoning_content`，流式增量字段名按 OpenAI 兼容惯例**应为** `delta.reasoning_content`，需切到 Mimo 跑一条真实复盘后核对。若字段名不同，需在 `MimoLlmProvider` 内做一次字段映射（基类可暴露 `extractDelta(chunk)` hook）。
2. **鉴权 header**：OpenAI SDK 默认 `Authorization: Bearer`；Mimo 官方 Python OpenAI SDK 示例直接 `OpenAI(api_key=..., base_url=...)`，说明 Mimo 接受 Bearer。默认无需改 SDK；若上线后真出现 401，再补 `defaultHeaders: { 'api-key': key }`。
3. **思考模式下的 `temperature`**：Mimo `mimo-v2.5-pro`/`v2.5` 在 thinking 模式下会被强制为 1.0。当前代码未传 `temperature`，无影响；后续若有需求要降随机性，应改用 `top_p` 或切到 `mimo-v2-flash`（thinking 默认关，可改 temperature）。
4. **Out of scope**：TTS / 多模态 / web_search 工具调用 / 多轮对话 reasoning_content 透传 / 前后端 UI 显示 provider 名称 —— 本次均不涉及。

## 九、验收标准

1. `LLM_PROVIDER=deepseek` + DeepSeek 凭据下，每日复盘行为与改造前完全一致（reasoning 流、article 流、token 用量、stage 时间均正常）
2. `LLM_PROVIDER=mimo` + Mimo 凭据下，能跑通一条真实复盘，前端思考面板持续滚动 reasoning 增量，最终 `reasoning_content` / `article` / `tokenUsage` 三者均非空
3. `LLM_PROVIDER` 取除 `deepseek`/`mimo` 之外的值时，应用启动直接抛 `Unknown LLM_PROVIDER: <x>` 错误
4. `pnpm --filter @cryptotrading/server build` 通过；该模块所有 `*.spec.ts` 通过
5. 仓库内不再有任何 `DEEPSEEK_*` 引用（除 git 历史外）
