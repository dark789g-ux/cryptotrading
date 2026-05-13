import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ToolSchema } from '../llm/llm-provider.interface';
import { SearchNewsHandler } from './handlers/search-news.handler';
import { LookupStockHandler } from './handlers/lookup-stock.handler';
import { LookupConceptHandler } from './handlers/lookup-concept.handler';
import { ReadPreviousReviewHandler } from './handlers/read-previous-review.handler';
import { FetchTopListHandler } from './handlers/fetch-top-list.handler';
import { ToolArgError, type ToolHandler } from './tool-types';

/**
 * ToolDispatcherService（spec § 5.1 / § 5.3）
 *
 * 职责：
 * 1) getSchemas() —— 集中下发 5 个工具的 OpenAI tool-use JSON Schema，给 LlmProvider.runToolLoop
 * 2) dispatch()   —— 由 runToolLoop 在每次工具调用回调；路由到 handler、统一计时、统一异常包装、统一超时
 *
 * 关键约束（CLAUDE.md / spec）：
 * - 单工具超时 DAILY_REVIEW_TOOL_TIMEOUT_MS（默认 15000ms），用 Promise.race 实现，超时后包成 error 返回
 * - try/catch 包整个 handler 调用；任何异常（含 ToolArgError、网络异常、DB 异常）都不抛出，
 *   而是返回 { result: null, durationMs, error: err.message }，由 LLM 自行绕开
 * - ToolCallLog.startedAt / callIndex 由调用方（runToolLoop）填，dispatch 只回 result/durationMs/error
 */
@Injectable()
export class ToolDispatcherService {
  private readonly logger = new Logger(ToolDispatcherService.name);
  private static readonly DEFAULT_TIMEOUT_MS = 15000;

  private readonly handlers: Map<string, ToolHandler>;

  constructor(
    private readonly configService: ConfigService,
    private readonly searchNewsHandler: SearchNewsHandler,
    private readonly lookupStockHandler: LookupStockHandler,
    private readonly lookupConceptHandler: LookupConceptHandler,
    private readonly readPreviousReviewHandler: ReadPreviousReviewHandler,
    private readonly fetchTopListHandler: FetchTopListHandler,
  ) {
    this.handlers = new Map<string, ToolHandler>([
      [this.searchNewsHandler.name, this.searchNewsHandler],
      [this.lookupStockHandler.name, this.lookupStockHandler],
      [this.lookupConceptHandler.name, this.lookupConceptHandler],
      [this.readPreviousReviewHandler.name, this.readPreviousReviewHandler],
      [this.fetchTopListHandler.name, this.fetchTopListHandler],
    ]);
  }

  /**
   * 返回 5 个工具的 OpenAI tool-use 协议 JSON Schema。
   * description 用中文便于 LLM 理解；parameters 严格按 spec § 5.1 列出必填/可选。
   */
  getSchemas(): ToolSchema[] {
    return [
      {
        type: 'function',
        function: {
          name: 'search_news',
          description:
            '检索最近 N 天的财经新闻 / 政策 / 公告，用于为某条假设找外部催化证据。',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: '检索关键词，≤80 字（如 "DeepSeek 融资"、"工信部 新政"）',
              },
              recencyDays: {
                type: 'number',
                description: '回溯天数，默认 7',
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'lookup_stock',
          description:
            '查询单只 A 股的基础信息、近期资金流（近 5/20 日）、所属概念、近 5 日龙虎榜上榜记录。',
          parameters: {
            type: 'object',
            properties: {
              tsCode: {
                type: 'string',
                description: 'A 股 ts_code（如 "601138.SH"、"000001.SZ"）',
              },
            },
            required: ['tsCode'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'lookup_concept',
          description:
            '按板块/概念中文名查询该板块当日涨跌幅与成分股资金流（top 30，含龙头标记）。本工具不返回新闻，需要催化信息请额外调 search_news。',
          parameters: {
            type: 'object',
            properties: {
              conceptName: {
                type: 'string',
                description: '板块或行业的中文名（如 "半导体"、"AI 算力"）',
              },
            },
            required: ['conceptName'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_previous_review',
          description:
            '读取上一交易日已完成的复盘文章，用于验证"上次对今日的判断"。offsetDays=1 表示最近一次复盘。',
          parameters: {
            type: 'object',
            properties: {
              offsetDays: {
                type: 'number',
                description: '回溯第几次复盘，1=上一次，2=上上一次，依此类推',
              },
            },
            required: ['offsetDays'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'fetch_top_list',
          description:
            '龙虎榜查询。mode=daily 返回 tradeDate 当日完整榜；mode=recent5d 返回 tsCode 近 5 个交易日的上榜历史与 appearCount。',
          parameters: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['daily', 'recent5d'],
                description: "查询模式：'daily' = 单日全榜，'recent5d' = 某股近 5 日上榜",
              },
              tradeDate: {
                type: 'string',
                description: 'YYYYMMDD（mode=daily 必填）',
              },
              tsCode: {
                type: 'string',
                description: 'A 股 ts_code（mode=recent5d 必填）',
              },
            },
            required: ['mode'],
            additionalProperties: false,
          },
        },
      },
    ];
  }

  /**
   * 路由 + 计时 + 异常包装 + 超时。
   * 入参 callIndex 仅作日志标识，不影响行为。
   */
  async dispatch(
    callIndex: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: unknown; durationMs: number; error?: string }> {
    const start = Date.now();
    const handler = this.handlers.get(name);
    if (!handler) {
      const error = `unknown tool: ${name}`;
      this.logger.warn(
        `ToolDispatcher [#${callIndex}] ${error}. args=${this.safeStringify(args)}`,
      );
      return { result: null, durationMs: Date.now() - start, error };
    }

    const timeoutMs = this.resolveTimeoutMs();
    try {
      const result = await this.raceWithTimeout(handler.call(args ?? {}), timeoutMs, name);
      return { result, durationMs: Date.now() - start };
    } catch (err: unknown) {
      const message = this.extractErrorMessage(err);
      this.logger.warn(
        `ToolDispatcher [#${callIndex}] tool=${name} failed: ${message}. args=${this.safeStringify(args)}`,
      );
      return { result: null, durationMs: Date.now() - start, error: message };
    }
  }

  private async raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    toolName: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`tool ${toolName} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private resolveTimeoutMs(): number {
    const raw = this.configService.get<string | number>('DAILY_REVIEW_TOOL_TIMEOUT_MS');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : ToolDispatcherService.DEFAULT_TIMEOUT_MS;
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof ToolArgError) return err.message;
    if (err instanceof Error) return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  private safeStringify(v: unknown): string {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
}
