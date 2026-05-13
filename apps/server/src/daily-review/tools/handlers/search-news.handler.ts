import { Injectable } from '@nestjs/common';
import { NewsSearchClient } from '../../news/news-search.client';
import { ToolArgError, type SearchNewsResult, type ToolHandler } from '../tool-types';

/**
 * search_news（spec § 5.1）
 *
 * 入参：query: string（≤80 字，由 LLM 保证）；recencyDays?: number，默认 7
 * 出参：{ hits, degraded, source }（直接转发 NewsSearchClient.search 返回值）
 *
 * NewsSearchClient 内部已处理：
 * - Tavily 主源失败 → Serper 兜底 → 两源都不可用返回 { hits:[], degraded:true, source:'none' }
 * - 0 条命中也会 logger.warn 区分「合法空结果」与「调用失败」
 * 这里只做参数校验 + 直接转发，让 LLM 通过 degraded 字段感知降级。
 */
@Injectable()
export class SearchNewsHandler implements ToolHandler {
  readonly name = 'search_news';

  constructor(private readonly newsSearchClient: NewsSearchClient) {}

  async call(args: Record<string, unknown>): Promise<SearchNewsResult> {
    const query = this.parseQuery(args.query);
    const recencyDays = this.parseRecencyDays(args.recencyDays);

    const result = await this.newsSearchClient.search(query, recencyDays);
    return {
      hits: result.hits,
      degraded: result.degraded,
      source: result.source,
    };
  }

  private parseQuery(raw: unknown): string {
    if (typeof raw !== 'string') {
      throw new ToolArgError("missing required arg: query (string)");
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new ToolArgError('missing required arg: query (empty string)');
    }
    // LLM 偶发越过 80 字限制时静默截断（保留 LLM 意图，避免直接拒绝）
    return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
  }

  private parseRecencyDays(raw: unknown): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.floor(n);
  }
}
