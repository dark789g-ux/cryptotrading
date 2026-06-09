/**
 * a-shares.service.spec.ts
 *
 * 单测 ASharesService.getKlines 的日期区间参数扩展：
 *   1. 不传 range → params=[tsCode, safeLimit]，SQL 不含 trade_date 区间
 *   2. 传 {startDate, endDate} → params=[tsCode, startDate, endDate, safeLimit]，含两段约束
 *   3. 只传 startDate → params=[tsCode, startDate, safeLimit]，只含 >=
 *   4. 只传 endDate   → params=[tsCode, endDate, safeLimit]，只含 <=
 * 不连真 DB，mock dataSource.query 返回空数组。
 */

import { ASharesService } from './a-shares.service';

// ── 工具 ──────────────────────────────────────────────────────────────────────

/** 折叠连续空白，便于子串匹配（不受缩进/换行影响）。 */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── mock 工厂 ─────────────────────────────────────────────────────────────────

function makeDataSourceMock() {
  return { query: jest.fn().mockResolvedValue([]) };
}

function makeService(dataSource: ReturnType<typeof makeDataSourceMock>): ASharesService {
  // ASharesService 构造函数：symbolRepo, dataSource, syncService
  // getKlines 只碰 dataSource，其余 null 即可。
  return new ASharesService(null as never, dataSource as never, null as never);
}

// ── 辅助：调用并取 dataSource.query 的实参 ────────────────────────────────────

async function callGetKlines(
  service: ASharesService,
  dataSource: ReturnType<typeof makeDataSourceMock>,
  args: Parameters<ASharesService['getKlines']>,
): Promise<{ sql: string; params: unknown[] }> {
  await service.getKlines(...args);
  const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
  return { sql, params };
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe('ASharesService.getKlines - 日期区间参数', () => {
  const tsCode = '000001.SZ';
  const defaultLimit = 300;
  const safeLimit = 300; // Math.min(1000, Math.max(30, 300)) = 300

  describe('不传 range（向后兼容）', () => {
    it('params 数组为 [tsCode, safeLimit]', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { params } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', undefined]);
      expect(params).toEqual([tsCode, safeLimit]);
    });

    it('SQL 不含 trade_date 区间约束', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', undefined]);
      const flat = squash(sql);
      expect(flat).not.toContain('trade_date >=');
      expect(flat).not.toContain('trade_date <=');
    });
  });

  describe('传 {startDate, endDate}', () => {
    const startDate = '20240101';
    const endDate = '20240630';

    it('params 数组为 [tsCode, startDate, endDate, safeLimit]', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { params } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate, endDate }]);
      expect(params).toEqual([tsCode, startDate, endDate, safeLimit]);
    });

    it('SQL 含 q.trade_date >= $2 且 q.trade_date <= $3，LIMIT $4', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate, endDate }]);
      const flat = squash(sql);
      expect(flat).toContain('q.trade_date >= $2');
      expect(flat).toContain('q.trade_date <= $3');
      expect(flat).toContain('LIMIT $4');
    });
  });

  describe('只传 startDate', () => {
    const startDate = '20240101';

    it('params 数组为 [tsCode, startDate, safeLimit]', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { params } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate }]);
      expect(params).toEqual([tsCode, startDate, safeLimit]);
    });

    it('SQL 含 q.trade_date >= $2，不含 <=，LIMIT $3', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { startDate }]);
      const flat = squash(sql);
      expect(flat).toContain('q.trade_date >= $2');
      expect(flat).not.toContain('trade_date <=');
      expect(flat).toContain('LIMIT $3');
    });
  });

  describe('只传 endDate', () => {
    const endDate = '20240630';

    it('params 数组为 [tsCode, endDate, safeLimit]', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { params } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { endDate }]);
      expect(params).toEqual([tsCode, endDate, safeLimit]);
    });

    it('SQL 含 q.trade_date <= $2，不含 >=，LIMIT $3', async () => {
      const ds = makeDataSourceMock();
      const svc = makeService(ds);
      const { sql } = await callGetKlines(svc, ds, [tsCode, defaultLimit, 'qfq', { endDate }]);
      const flat = squash(sql);
      expect(flat).toContain('q.trade_date <= $2');
      expect(flat).not.toContain('trade_date >=');
      expect(flat).toContain('LIMIT $3');
    });
  });
});
