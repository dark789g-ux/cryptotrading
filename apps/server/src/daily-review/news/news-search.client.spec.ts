import axios from 'axios';
import type { ConfigService } from '@nestjs/config';
import { NewsSearchClient } from './news-search.client';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

// mock isAxiosError —— 在 catch 分支判断真实异常类型用，本测试里抛的是普通 Error
(mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn(() => false);

function buildConfig(overrides: Record<string, string | number | undefined> = {}): ConfigService {
  const store: Record<string, string | number | undefined> = {
    TAVILY_API_KEY: 'tavily-test-key',
    SERPER_API_KEY: 'serper-test-key',
    DAILY_REVIEW_TOOL_TIMEOUT_MS: 15000,
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => store[key]),
  } as unknown as ConfigService;
}

describe('NewsSearchClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(false);
  });

  it('1) Tavily 成功 → source=tavily, hits 来自 Tavily results', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        results: [
          {
            title: 'DeepSeek 完成新一轮融资',
            url: 'https://news.example.com/a',
            content: '据知情人士透露，DeepSeek 完成 B 轮融资……',
            published_date: '2026-05-12T08:00:00Z',
            source: 'example.com',
          },
          {
            title: '工信部发布新政',
            url: 'https://gov.example.cn/b',
            content: '工信部今日发布新政……',
            published_date: '2026-05-13T01:00:00Z',
          },
        ],
      },
    } as any);

    const client = new NewsSearchClient(buildConfig());
    const result = await client.search('DeepSeek 融资', 5);

    expect(result.source).toBe('tavily');
    expect(result.degraded).toBe(false);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toEqual({
      title: 'DeepSeek 完成新一轮融资',
      source: 'example.com',
      publishedAt: '2026-05-12T08:00:00Z',
      snippet: '据知情人士透露，DeepSeek 完成 B 轮融资……',
      url: 'https://news.example.com/a',
    });
    // 第二条 source 字段缺失，回退到 host
    expect(result.hits[1].source).toBe('gov.example.cn');

    // 仅调一次 axios，且打到 Tavily endpoint
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockedAxios.post.mock.calls[0] as unknown as [string, any, any];
    expect(url).toBe('https://api.tavily.com/search');
    expect(body).toMatchObject({
      api_key: 'tavily-test-key',
      query: 'DeepSeek 融资',
      search_depth: 'basic',
      max_results: 8,
      days: 5,
    });
    expect(config.timeout).toBe(15000);
  });

  it('2) Tavily 失败 → Serper 兜底成功，source=serper', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(new Error('tavily down'))
      .mockResolvedValueOnce({
        data: {
          news: [
            {
              title: '中概股大涨',
              link: 'https://serper.example.com/c',
              snippet: '中概股美东时间大涨……',
              date: '2026-05-13',
              source: 'serper-source',
            },
          ],
          organic: [
            {
              title: '不应被取',
              link: 'https://should-not-be-used',
            },
          ],
        },
      } as any);

    const client = new NewsSearchClient(buildConfig());
    const result = await client.search('中概股');

    expect(result.source).toBe('serper');
    expect(result.degraded).toBe(false);
    // news 块优先于 organic
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toEqual({
      title: '中概股大涨',
      source: 'serper-source',
      publishedAt: '2026-05-13',
      snippet: '中概股美东时间大涨……',
      url: 'https://serper.example.com/c',
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    const tavilyCall = mockedAxios.post.mock.calls[0] as unknown as [string, any, any];
    const serperCall = mockedAxios.post.mock.calls[1] as unknown as [string, any, any];
    expect(tavilyCall[0]).toBe('https://api.tavily.com/search');
    expect(serperCall[0]).toBe('https://google.serper.dev/search');
    expect(serperCall[1]).toEqual({ q: '中概股' });
    expect(serperCall[2].headers['X-API-KEY']).toBe('serper-test-key');
  });

  it('2b) Serper 在无 news 块时退到 organic', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(new Error('tavily down'))
      .mockResolvedValueOnce({
        data: {
          organic: [
            {
              title: 'organic 命中',
              link: 'https://serper.example.com/d',
              snippet: '正文片段',
              date: '2026-05-13',
            },
          ],
        },
      } as any);

    const client = new NewsSearchClient(buildConfig());
    const result = await client.search('A股');

    expect(result.source).toBe('serper');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].url).toBe('https://serper.example.com/d');
    expect(result.hits[0].source).toBe('serper.example.com');
  });

  it('3) Tavily + Serper 均失败 → degraded=true, hits=[], source=none, 且 warn', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(new Error('tavily down'))
      .mockRejectedValueOnce(new Error('serper down'));

    const client = new NewsSearchClient(buildConfig());
    const warnSpy = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await client.search('AI 算力');

    expect(result).toEqual({ hits: [], degraded: true, source: 'none' });

    // 至少包含一条 apiName=tavily.search、一条 apiName=serper.search、一条"主源+兜底均失败"的 warn
    const warnMsgs = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMsgs.some((m) => m.includes('tavily.search'))).toBe(true);
    expect(warnMsgs.some((m) => m.includes('serper.search'))).toBe(true);
    expect(warnMsgs.some((m) => m.includes('主源 + 兜底均失败'))).toBe(true);
    // warn 必须带 params（query）
    expect(warnMsgs.some((m) => m.includes('AI 算力'))).toBe(true);
  });

  it('4) TAVILY_API_KEY 未配置 → 直接走 Serper', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        news: [
          {
            title: 'serper-only-hit',
            link: 'https://serper.example.com/e',
            snippet: 'snippet',
            date: '2026-05-13',
            source: 'serper-source',
          },
        ],
      },
    } as any);

    const client = new NewsSearchClient(buildConfig({ TAVILY_API_KEY: undefined }));
    const result = await client.search('政策');

    expect(result.source).toBe('serper');
    expect(result.degraded).toBe(false);
    expect(result.hits).toHaveLength(1);

    // 只调一次 axios，且打到 Serper
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url] = mockedAxios.post.mock.calls[0] as unknown as [string, any, any];
    expect(url).toBe('https://google.serper.dev/search');
  });

  it('4b) Tavily + Serper key 都未配置 → degraded=true, source=none, 且不发起任何请求', async () => {
    const client = new NewsSearchClient(
      buildConfig({ TAVILY_API_KEY: undefined, SERPER_API_KEY: undefined }),
    );
    const result = await client.search('xyz');
    expect(result).toEqual({ hits: [], degraded: true, source: 'none' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('成功返回 0 条 hits 也会 warn（合法空结果）', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [] } } as any);

    const client = new NewsSearchClient(buildConfig());
    const warnSpy = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await client.search('冷门词');
    expect(result.source).toBe('tavily');
    expect(result.degraded).toBe(false);
    expect(result.hits).toEqual([]);

    const warnMsgs = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMsgs.some((m) => m.includes('返回 0 条 hits'))).toBe(true);
  });

  it('DAILY_REVIEW_TOOL_TIMEOUT_MS 未配置时使用默认 15000ms', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [] } } as any);
    const client = new NewsSearchClient(
      buildConfig({ DAILY_REVIEW_TOOL_TIMEOUT_MS: undefined }),
    );
    await client.search('q');
    const [, , config] = mockedAxios.post.mock.calls[0] as unknown as [string, any, any];
    expect(config.timeout).toBe(15000);
  });
});
