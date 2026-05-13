import { ConfigService } from '@nestjs/config';
import { ToolDispatcherService } from './tool-dispatcher.service';
import { ToolArgError, type ToolHandler } from './tool-types';
import type { SearchNewsHandler } from './handlers/search-news.handler';
import type { LookupStockHandler } from './handlers/lookup-stock.handler';
import type { LookupConceptHandler } from './handlers/lookup-concept.handler';
import type { ReadPreviousReviewHandler } from './handlers/read-previous-review.handler';
import type { FetchTopListHandler } from './handlers/fetch-top-list.handler';

function buildHandler(name: string, impl: ToolHandler['call'] = jest.fn().mockResolvedValue({})): ToolHandler {
  return { name, call: impl };
}

function buildConfig(overrides: Record<string, string | number | undefined> = {}): ConfigService {
  const store: Record<string, string | number | undefined> = {
    DAILY_REVIEW_TOOL_TIMEOUT_MS: 15000,
    ...overrides,
  };
  return { get: jest.fn((key: string) => store[key]) } as unknown as ConfigService;
}

function buildSvc(custom: Partial<Record<string, ToolHandler>> = {}, cfg = buildConfig()) {
  const search = (custom.search_news ?? buildHandler('search_news', jest.fn().mockResolvedValue({ hits: [], degraded: false, source: 'tavily' }))) as unknown as SearchNewsHandler;
  const stock = (custom.lookup_stock ?? buildHandler('lookup_stock', jest.fn().mockResolvedValue({ basic: {} }))) as unknown as LookupStockHandler;
  const concept = (custom.lookup_concept ?? buildHandler('lookup_concept', jest.fn().mockResolvedValue({ matchedName: 'x' }))) as unknown as LookupConceptHandler;
  const prev = (custom.read_previous_review ?? buildHandler('read_previous_review', jest.fn().mockResolvedValue(null))) as unknown as ReadPreviousReviewHandler;
  const top = (custom.fetch_top_list ?? buildHandler('fetch_top_list', jest.fn().mockResolvedValue({ mode: 'daily', entries: [] }))) as unknown as FetchTopListHandler;
  return new ToolDispatcherService(cfg, search, stock, concept, prev, top);
}

describe('ToolDispatcherService', () => {
  describe('getSchemas', () => {
    it('返回 5 个 tool 的 OpenAI tool-use JSON Schema，name 唯一、含 required 字段', () => {
      const svc = buildSvc();
      const schemas = svc.getSchemas();
      expect(schemas).toHaveLength(5);
      const names = schemas.map((s) => s.function.name).sort();
      expect(names).toEqual([
        'fetch_top_list',
        'lookup_concept',
        'lookup_stock',
        'read_previous_review',
        'search_news',
      ]);
      for (const s of schemas) {
        expect(s.type).toBe('function');
        const params: any = s.function.parameters;
        expect(params.type).toBe('object');
        expect(Array.isArray(params.required)).toBe(true);
        expect(params.required.length).toBeGreaterThan(0);
      }
    });
  });

  describe('dispatch', () => {
    it('1) 路由到正确 handler：name=search_news 时调 SearchNewsHandler.call 并回传 result', async () => {
      const searchCall = jest.fn().mockResolvedValue({ hits: [{ title: 't' }], degraded: false, source: 'tavily' });
      const svc = buildSvc({ search_news: buildHandler('search_news', searchCall) });

      const out = await svc.dispatch(0, 'search_news', { query: 'x' });
      expect(searchCall).toHaveBeenCalledWith({ query: 'x' });
      expect(out.error).toBeUndefined();
      expect((out.result as any).hits).toHaveLength(1);
      expect(out.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('2) 未知工具名：返回 { result: null, error: "unknown tool: ..." }', async () => {
      const svc = buildSvc();
      const out = await svc.dispatch(3, 'no_such_tool', {});
      expect(out.result).toBeNull();
      expect(out.error).toContain('unknown tool: no_such_tool');
      expect(out.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('3) handler 抛异常：被包成 error 返回不向上抛（含 ToolArgError + 通用 Error）', async () => {
      const argErr = buildHandler('lookup_stock', jest.fn().mockRejectedValue(new ToolArgError('missing required arg: tsCode')));
      const generic = buildHandler('lookup_concept', jest.fn().mockRejectedValue(new Error('db down')));
      const svc = buildSvc({ lookup_stock: argErr, lookup_concept: generic });

      const a = await svc.dispatch(1, 'lookup_stock', {});
      expect(a.result).toBeNull();
      expect(a.error).toBe('missing required arg: tsCode');

      const b = await svc.dispatch(2, 'lookup_concept', { conceptName: 'x' });
      expect(b.result).toBeNull();
      expect(b.error).toBe('db down');
    });

    it('4) 超时：handler 卡住 > timeoutMs 时返回 timeout error 且不抛', async () => {
      const slow = buildHandler(
        'fetch_top_list',
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)),
      );
      const svc = buildSvc(
        { fetch_top_list: slow },
        buildConfig({ DAILY_REVIEW_TOOL_TIMEOUT_MS: 30 }),
      );
      const out = await svc.dispatch(0, 'fetch_top_list', { mode: 'daily', tradeDate: '20260513' });
      expect(out.result).toBeNull();
      expect(out.error).toMatch(/timeout/i);
    });

    it('5) args=null / undefined 时 handler 收到 {}（不爆 cannot read properties of null）', async () => {
      const seen: any[] = [];
      const sink = buildHandler('search_news', async (args) => {
        seen.push(args);
        return { ok: true };
      });
      const svc = buildSvc({ search_news: sink });
      // 故意传 null 验证 dispatcher 兜底（签名虽允许 Record<string, unknown>，但运行时 LLM 可能给 null）
      await svc.dispatch(0, 'search_news', null as unknown as Record<string, unknown>);
      expect(seen[0]).toEqual({});
    });
  });
});
