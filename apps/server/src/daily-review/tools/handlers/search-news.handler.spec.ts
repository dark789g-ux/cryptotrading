import { SearchNewsHandler } from './search-news.handler';
import type { NewsSearchClient } from '../../news/news-search.client';
import { ToolArgError } from '../tool-types';

function buildClient(result: any): NewsSearchClient {
  return {
    search: jest.fn().mockResolvedValue(result),
  } as unknown as NewsSearchClient;
}

describe('SearchNewsHandler', () => {
  it('1) 正常路径：转发 NewsSearchClient 返回值（含 degraded=false）', async () => {
    const client = buildClient({
      hits: [
        { title: 't1', source: 'x', publishedAt: '2026-05-13', snippet: 's1', url: 'http://a' },
      ],
      degraded: false,
      source: 'tavily',
    });
    const handler = new SearchNewsHandler(client);
    const out: any = await handler.call({ query: 'DeepSeek 融资', recencyDays: 5 });

    expect(client.search).toHaveBeenCalledWith('DeepSeek 融资', 5);
    expect(out.source).toBe('tavily');
    expect(out.degraded).toBe(false);
    expect(out.hits).toHaveLength(1);
  });

  it('2) 降级路径：NewsSearchClient 返回 degraded=true / source=none 时原样转发', async () => {
    const client = buildClient({ hits: [], degraded: true, source: 'none' });
    const handler = new SearchNewsHandler(client);
    const out: any = await handler.call({ query: '半导体' });

    // recencyDays 缺省时传 undefined，由 NewsSearchClient 自行取默认值
    expect(client.search).toHaveBeenCalledWith('半导体', undefined);
    expect(out.degraded).toBe(true);
    expect(out.source).toBe('none');
    expect(out.hits).toEqual([]);
  });

  it('3) 入参 query 缺失/空串时抛 ToolArgError', async () => {
    const handler = new SearchNewsHandler(buildClient({ hits: [], degraded: false, source: 'tavily' }));
    await expect(handler.call({})).rejects.toBeInstanceOf(ToolArgError);
    await expect(handler.call({ query: '  ' })).rejects.toBeInstanceOf(ToolArgError);
  });
});
