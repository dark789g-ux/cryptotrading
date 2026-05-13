// NewsHit / NewsSearchResult 共享类型
// 来源：doc/specs/2026-05-13-tool-calling-daily-review-design.md §5.1 search_news

export interface NewsHit {
  title: string;
  source: string;
  publishedAt: string;
  snippet: string;
  url: string;
}

export type NewsSearchSource = 'tavily' | 'serper' | 'none';

export interface NewsSearchResult {
  hits: NewsHit[];
  degraded: boolean;
  source: NewsSearchSource;
}
