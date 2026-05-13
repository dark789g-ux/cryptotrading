import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import type { NewsHit, NewsSearchResult, NewsSearchSource } from './news.types';

// NewsSearchClient: Tavily 主源 + Serper 兜底
// spec: doc/specs/2026-05-13-tool-calling-daily-review-design.md §5.1 / §7 / §12 风险
//
// 第三方契约说明（接口名/参数名以官方文档为准，禁止凭历史代码推断）：
// - Tavily Search API: POST https://api.tavily.com/search
//   body: { api_key, query, search_depth: 'basic'|'advanced', max_results, days }
//   resp: { results: [{ title, url, content, published_date, ... }, ...] }
// - Serper Google Search API: POST https://google.serper.dev/search
//   header: X-API-KEY
//   body: { q }
//   resp: { news?: [{ title, link, snippet, date, source }], organic: [{ title, link, snippet, date, source? }] }
//
// TODO: 需集成测试验证 API 契约（mock 单测不验证第三方契约）

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RECENCY_DAYS = 7;
const DEFAULT_MAX_RESULTS = 8;

interface TavilyResultRaw {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
  source?: string;
}

interface TavilyResponseRaw {
  results?: TavilyResultRaw[];
}

interface SerperItemRaw {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  source?: string;
}

interface SerperResponseRaw {
  news?: SerperItemRaw[];
  organic?: SerperItemRaw[];
}

@Injectable()
export class NewsSearchClient {
  private readonly logger = new Logger(NewsSearchClient.name);

  constructor(private readonly configService: ConfigService) {}

  async search(query: string, recencyDays?: number): Promise<NewsSearchResult> {
    const days = recencyDays ?? DEFAULT_RECENCY_DAYS;
    const timeoutMs = this.resolveTimeoutMs();
    const tavilyKey = this.configService.get<string>('TAVILY_API_KEY');
    const serperKey = this.configService.get<string>('SERPER_API_KEY');

    // 主源 Tavily：仅在配置了 key 时调用
    if (tavilyKey) {
      try {
        const hits = await this.callTavily(tavilyKey, query, days, timeoutMs);
        return this.buildResult(hits, 'tavily', { query, days });
      } catch (err) {
        this.warnApi('tavily.search', err, { query, days });
        // 跌入 Serper 兜底
      }
    } else {
      this.logger.warn(
        `NewsSearchClient TAVILY_API_KEY 未配置，跳过主源直接尝试 Serper 兜底。query=${JSON.stringify(query)} recencyDays=${days}`,
      );
    }

    // 兜底 Serper
    if (serperKey) {
      try {
        const hits = await this.callSerper(serperKey, query, timeoutMs);
        return this.buildResult(hits, 'serper', { query, days });
      } catch (err) {
        this.warnApi('serper.search', err, { query, days });
      }
    } else {
      this.logger.warn(
        `NewsSearchClient SERPER_API_KEY 未配置，无法兜底。query=${JSON.stringify(query)} recencyDays=${days}`,
      );
    }

    // 两源都不可用
    this.logger.warn(
      `NewsSearchClient 主源 + 兜底均失败或未配置，返回 degraded=true。query=${JSON.stringify(query)} recencyDays=${days}`,
    );
    return { hits: [], degraded: true, source: 'none' };
  }

  private buildResult(
    hits: NewsHit[],
    source: NewsSearchSource,
    ctx: { query: string; days: number },
  ): NewsSearchResult {
    // 合法空结果与异常失败必须区分：source 已成功命中，仅是 0 条命中时也要 warn（参考 CLAUDE.md 第三方 API 集成规范）
    if (hits.length === 0) {
      this.logger.warn(
        `NewsSearchClient ${source}.search 返回 0 条 hits（合法空结果或 query 太窄）。query=${JSON.stringify(
          ctx.query,
        )} recencyDays=${ctx.days}`,
      );
    }
    return { hits, degraded: false, source };
  }

  private async callTavily(
    apiKey: string,
    query: string,
    days: number,
    timeoutMs: number,
  ): Promise<NewsHit[]> {
    const body = {
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: DEFAULT_MAX_RESULTS,
      days,
    };
    const config: AxiosRequestConfig = { timeout: timeoutMs };
    const resp = await axios.post<TavilyResponseRaw>(TAVILY_ENDPOINT, body, config);
    const results = resp.data?.results ?? [];
    return results
      .map((r) => this.mapTavilyHit(r))
      .filter((h): h is NewsHit => h !== null);
  }

  private mapTavilyHit(raw: TavilyResultRaw): NewsHit | null {
    if (!raw || !raw.url || !raw.title) return null;
    return {
      title: String(raw.title),
      source: raw.source ? String(raw.source) : this.extractHost(raw.url),
      publishedAt: raw.published_date ? String(raw.published_date) : '',
      snippet: raw.content ? String(raw.content) : '',
      url: String(raw.url),
    };
  }

  private async callSerper(apiKey: string, query: string, timeoutMs: number): Promise<NewsHit[]> {
    const body = { q: query };
    const config: AxiosRequestConfig = {
      timeout: timeoutMs,
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
    };
    const resp = await axios.post<SerperResponseRaw>(SERPER_ENDPOINT, body, config);
    const payload = resp.data ?? {};
    // 优先使用 news 块（更贴近"新闻"语义）；若无 news 块则退到 organic
    const items: SerperItemRaw[] = payload.news?.length ? payload.news : payload.organic ?? [];
    return items
      .slice(0, DEFAULT_MAX_RESULTS)
      .map((r) => this.mapSerperHit(r))
      .filter((h): h is NewsHit => h !== null);
  }

  private mapSerperHit(raw: SerperItemRaw): NewsHit | null {
    if (!raw || !raw.link || !raw.title) return null;
    return {
      title: String(raw.title),
      source: raw.source ? String(raw.source) : this.extractHost(raw.link),
      publishedAt: raw.date ? String(raw.date) : '',
      snippet: raw.snippet ? String(raw.snippet) : '',
      url: String(raw.link),
    };
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  private resolveTimeoutMs(): number {
    const raw = this.configService.get<string | number>('DAILY_REVIEW_TOOL_TIMEOUT_MS');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
  }

  private warnApi(
    apiName: string,
    err: unknown,
    params: Record<string, unknown>,
  ): void {
    let detail: string;
    if (axios.isAxiosError(err)) {
      const axErr = err as AxiosError;
      const status = axErr.response?.status;
      const data =
        typeof axErr.response?.data === 'string'
          ? axErr.response.data
          : JSON.stringify(axErr.response?.data ?? null);
      detail = `status=${status ?? 'none'} code=${axErr.code ?? 'none'} message=${axErr.message} body=${data}`;
    } else if (err instanceof Error) {
      detail = `${err.name}: ${err.message}`;
    } else {
      detail = JSON.stringify(err);
    }
    this.logger.warn(
      `NewsSearchClient ${apiName} 调用失败：${detail}. params=${JSON.stringify(params)}`,
    );
  }
}
