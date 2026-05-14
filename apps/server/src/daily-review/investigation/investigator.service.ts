import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDER, type LlmProvider } from '../llm/llm-provider.interface';
import { ToolDispatcherService } from './tools/tool-dispatcher.service';
import {
  INVESTIGATOR_SYSTEM_PROMPT,
  buildInvestigatorUserPrompt,
} from '../llm/prompts/investigator-prompt';
import type {
  EvidencePack,
  ProgressEvent,
  SnapshotPayload,
  ToolCallLog,
} from '../types/daily-review.types';

export interface InvestigateResult {
  evidencePack: EvidencePack | null;
  toolCallLog: ToolCallLog[];
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Stage1 · Investigator
 *
 * 用 LLM tool-calling 循环（`LlmProvider.runToolLoop`）针对当日 snapshot 自主追查归因。
 * 失败处理策略（spec § 5.4 + § 6.2）：
 *  - 整阶段超时 / LLM 异常 / JSON 解析失败：返回 null
 *  - 任何异常都不向上抛；外层 pipeline 看到 null 走 Writer 降级写作
 *
 * 不在此处持久化，由 `DailyReviewService.runPipeline` 在最终 update 时一并落库。
 */
@Injectable()
export class InvestigatorService {
  private readonly logger = new Logger(InvestigatorService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly tools: ToolDispatcherService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 跑完一次 Investigator 循环。
   *
   * @returns - `evidencePack` 字段：成功返回结构化证据；解析失败时为 `{ hypotheses: [], rawText }`；超时/异常为 null。
   *          - 整个返回值在「整阶段失败需要降级」时返回 null，由外层据此判断是否记 `investigator_degraded`。
   */
  async investigate(
    snapshot: SnapshotPayload,
    onProgress: (e: ProgressEvent) => void,
  ): Promise<InvestigateResult | null> {
    const maxToolCalls = this.readInt('DAILY_REVIEW_TOOL_BUDGET', 8);
    const timeoutMs = this.readInt('DAILY_REVIEW_INVESTIGATOR_TIMEOUT_MS', 300_000);

    const runPromise = this.llm.runToolLoop({
      systemPrompt: INVESTIGATOR_SYSTEM_PROMPT,
      userPrompt: buildInvestigatorUserPrompt(snapshot),
      tools: this.tools.getSchemas(),
      maxToolCalls,
      maxTokens: 12_000,
      dispatchTool: (i, name, args) => this.tools.dispatch(i, name, args),
      onProgress,
    });

    // Promise.race 套整阶段超时；超时分支返回 sentinel 让 catch 之后再统一返回 null
    const TIMEOUT_SENTINEL = Symbol('investigator_timeout');
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });

    try {
      const winner = await Promise.race([runPromise, timeoutPromise]);
      if (winner === TIMEOUT_SENTINEL) {
        this.logger.warn(
          `[investigator_degraded] runToolLoop timeout after ${timeoutMs}ms, fallback to null evidencePack`,
        );
        onProgress({
          type: 'stage',
          stage: 'investigate',
          percent: 60,
          ts: Date.now(),
          message: 'investigator_degraded: timeout',
        });
        // 后台 runPromise 仍可能 resolve/reject —— 加一个 noop catch 避免 unhandledRejection
        runPromise.catch((err: any) => {
          this.logger.warn(`[investigator_degraded] late tool-loop rejection ignored: ${err?.message ?? err}`);
        });
        return null;
      }
      // 正常路径
      return winner;
    } catch (err: any) {
      this.logger.warn(
        `[investigator_degraded] runToolLoop threw: ${err?.message ?? err}; fallback to null evidencePack`,
      );
      onProgress({
        type: 'stage',
        stage: 'investigate',
        percent: 60,
        ts: Date.now(),
        message: `investigator_degraded: ${err?.message ?? 'error'}`,
      });
      return null;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private readInt(key: string, fallback: number): number {
    const raw = this.config.get<string | number | undefined>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}
