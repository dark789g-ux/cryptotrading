import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts/article-prompt';
import type { ProgressEvent } from './daily-review.types';

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
  ): Promise<{ article: string; reasoning: string; tokenUsage: any }> {
    const stream: any = await (this.client.chat.completions.create as any)({
      model: this.config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(JSON.parse(snapshotJson)) },
      ],
      stream: true,
      extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    });

    let reasoning = '', article = '', usage: any = null;
    let stage: 'reasoning' | 'writing' = 'reasoning';

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        onProgress({ stage: 'reasoning', percent: this.estimatePercent('reasoning', reasoning.length) });
      }
      if (delta?.content) {
        if (stage === 'reasoning') stage = 'writing';
        article += delta.content;
        onProgress({ stage: 'writing', percent: this.estimatePercent('writing', article.length) });
      }
      if (chunk.usage) usage = chunk.usage;
    }

    return {
      article, reasoning,
      tokenUsage: usage ? {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        reasoning: usage.reasoning_tokens ?? 0,
        total: usage.total_tokens,
      } : null,
    };
  }

  private estimatePercent(s: 'reasoning' | 'writing', chars: number): number {
    if (s === 'reasoning') return 40 + Math.min(25, Math.floor((chars / 4000) * 25));
    return 65 + Math.min(30, Math.floor((chars / 8000) * 30));
  }
}
