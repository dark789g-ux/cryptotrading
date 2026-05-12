import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts/article-prompt';
import type { ProgressEvent, TokenUsage } from './daily-review.types';

export interface DeepseekConfig { model: string; }

@Injectable()
export class DeepseekService {
  private readonly logger = new Logger(DeepseekService.name);

  constructor(
    private readonly client: OpenAI,
    private readonly config: DeepseekConfig,
  ) {}

  get modelName(): string {
    return this.config.model;
  }

  async generateArticle(
    snapshotJson: string,
    onProgress: (e: ProgressEvent) => void,
  ): Promise<{ article: string; reasoning: string; tokenUsage: TokenUsage | null }> {
    const stream: any = await (this.client.chat.completions.create as any)({
      model: this.config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(JSON.parse(snapshotJson)) },
      ],
      stream: true,
      extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    });

    let reasoning = '';
    let article = '';
    let usage: any = null;
    // reasoningStartedAt 用于在首个 content 抵达时计算 reasoning 阶段耗时，避免 pipeline 重复计时
    const reasoningStartedAt = Date.now();
    let writingStarted = false;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      // TODO: 需集成测试验证 DeepSeek 真实 reasoning_content 字段名（mock 单测不验证第三方契约）
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
}
