import type { ProgressEvent, TokenUsage } from '../daily-review.types';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmProvider {
  readonly modelName: string;
  generateArticle(
    snapshotJson: string,
    onProgress: (e: ProgressEvent) => void,
  ): Promise<{ article: string; reasoning: string; tokenUsage: TokenUsage | null }>;
}
