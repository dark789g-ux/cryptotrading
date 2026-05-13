import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt } from '../prompts/article-prompt';
import type {
  EvidencePack,
  ProgressEvent,
  ToolCallLog,
  TokenUsage,
} from '../daily-review.types';
import type {
  LlmProvider,
  RunToolLoopArgs,
  RunToolLoopResult,
  ToolSchema,
} from './llm-provider.interface';

// OpenAI tool-use 协议下的 message 形态（仅本文件内部使用，避免依赖 openai 子路径类型导出差异）
interface ToolCallStruct {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallStruct[];
  tool_call_id?: string;
}

/** UTC 墙钟字符串（CLAUDE.md 时间规范，禁止 toISOString().slice）。 */
function toUtcWallClock(d: Date): string {
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}Z`;
}

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
    evidencePack?: EvidencePack | null,
  ): Promise<{ article: string; reasoning: string; tokenUsage: TokenUsage | null }> {
    const stream: any = await (this.client.chat.completions.create as any)({
      model: this._model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(JSON.parse(snapshotJson), evidencePack) },
      ],
      stream: true,
      extra_body: this.buildExtraBody(),
    });

    let reasoning = '';
    let article = '';
    let usage: any = null;
    // reasoningStartedAt 用于在首个 content 抵达时计算 reasoning 阶段耗时，避免 pipeline 重复计时
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
    // usage 事件在末尾推出：admin 元信息条凭它显示输入/输出/推理 token
    if (tokenUsage) onProgress({ type: 'usage', tokens: tokenUsage, ts: Date.now() });

    return { article, reasoning, tokenUsage };
  }

  /**
   * 非流式 chat（tool-calling 协议）。基础 chat 入口集中在这里，便于子类覆写或 mock。
   * 注意：tool-calling 与 reasoning 流式互不兼容，这里固定 stream=false。
   */
  protected async chatWithTools(args: {
    messages: ChatMessage[];
    tools?: ToolSchema[];
    maxTokens: number;
  }): Promise<{ message: ChatMessage; usage: any }> {
    const body: Record<string, unknown> = {
      model: this._model,
      messages: args.messages,
      stream: false,
      max_tokens: args.maxTokens,
      extra_body: this.buildExtraBody(),
    };
    if (args.tools && args.tools.length > 0) {
      body.tools = args.tools;
      body.tool_choice = 'auto';
    }
    const resp: any = await (this.client.chat.completions.create as any)(body);
    const message: ChatMessage = resp.choices?.[0]?.message ?? { role: 'assistant', content: '' };
    return { message, usage: resp.usage ?? null };
  }

  async runToolLoop(args: RunToolLoopArgs): Promise<RunToolLoopResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.userPrompt },
    ];
    const toolCallLog: ToolCallLog[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let callIndex = 0;
    let lastMessage: ChatMessage | null = null;

    // 总轮次上限 = maxToolCalls + 1（最后一轮强制不再调用工具，让 LLM 输出最终消息）
    for (let i = 0; i <= args.maxToolCalls; i++) {
      const { message, usage } = await this.chatWithTools({
        messages,
        tools: args.tools,
        maxTokens: args.maxTokens,
      });
      lastMessage = message;
      if (usage) {
        promptTokens += usage.prompt_tokens ?? 0;
        completionTokens += usage.completion_tokens ?? 0;
        totalTokens += usage.total_tokens ?? 0;
      }
      messages.push(message);

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // 自然结束，跳出
        break;
      }

      // 达到上限：不再 dispatch，追加强制收口的 user message 后让循环再走一轮纯文本输出
      if (i === args.maxToolCalls) {
        messages.push({
          role: 'user',
          content: '已达工具调用预算上限，请立即输出 evidence pack JSON，不要再调工具。',
        });
        // 多走一轮拿最终消息
        const { message: finalMsg, usage: finalUsage } = await this.chatWithTools({
          messages,
          tools: args.tools,
          maxTokens: args.maxTokens,
        });
        lastMessage = finalMsg;
        if (finalUsage) {
          promptTokens += finalUsage.prompt_tokens ?? 0;
          completionTokens += finalUsage.completion_tokens ?? 0;
          totalTokens += finalUsage.total_tokens ?? 0;
        }
        messages.push(finalMsg);
        break;
      }

      for (const tc of toolCalls) {
        const startedAtDate = new Date();
        const startedAt = toUtcWallClock(startedAtDate);
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch (e) {
          parsedArgs = { __rawArguments: tc.function.arguments };
        }
        const name = tc.function.name;
        const myIndex = callIndex++;

        let result: unknown;
        let durationMs = 0;
        let error: string | undefined;
        try {
          const r = await args.dispatchTool(myIndex, name, parsedArgs);
          result = r.result;
          durationMs = r.durationMs;
          error = r.error;
        } catch (e: any) {
          result = null;
          durationMs = Date.now() - startedAtDate.getTime();
          error = e?.message ?? String(e);
        }

        const log: ToolCallLog = {
          callIndex: myIndex,
          name,
          args: parsedArgs,
          result,
          durationMs,
          startedAt,
          ...(error !== undefined ? { error } : {}),
        };
        toolCallLog.push(log);
        args.onProgress?.({
          type: 'tool_call',
          callIndex: myIndex,
          name,
          args: parsedArgs,
          durationMs,
          startedAt,
          ...(error !== undefined ? { error } : {}),
          ts: Date.now(),
        });

        // 把工具结果（或错误）塞回 messages，让 LLM 自行绕开
        const toolPayload = error
          ? JSON.stringify({ error })
          : JSON.stringify(result ?? null);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolPayload,
        });
      }
    }

    const evidencePack = parseFinalEvidencePack(lastMessage);
    return {
      evidencePack,
      toolCallLog,
      tokenUsage: { promptTokens, completionTokens, totalTokens },
    };
  }
}

/**
 * 解析最终消息为 EvidencePack：
 *  - 期望形态：{"done": true, "evidencePack": {...}} 或裸 {"hypotheses": [...]}（容错）
 *  - 失败时兜底为 { hypotheses: [], rawText: msg.content }
 *  - 消息为空时返回 null（不写 rawText，便于上层识别"LLM 完全无输出"）
 */
function parseFinalEvidencePack(msg: ChatMessage | null): EvidencePack | null {
  const text = (msg?.content ?? '').trim();
  if (!text) return null;
  const tryParse = (s: string): EvidencePack | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object') {
        if (obj.evidencePack && typeof obj.evidencePack === 'object') {
          const ep = obj.evidencePack as EvidencePack;
          if (!Array.isArray(ep.hypotheses)) ep.hypotheses = [];
          return ep;
        }
        if (Array.isArray(obj.hypotheses)) {
          return obj as EvidencePack;
        }
      }
      return null;
    } catch {
      return null;
    }
  };
  // 直接试 parse；若失败，尝试抓取首个 {...} JSON 子串
  const direct = tryParse(text);
  if (direct) return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sub = text.slice(start, end + 1);
    const fromSub = tryParse(sub);
    if (fromSub) return fromSub;
  }
  return { hypotheses: [], rawText: text };
}
