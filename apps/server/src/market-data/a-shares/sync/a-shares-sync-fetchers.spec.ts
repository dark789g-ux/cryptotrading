import { queryWithBackfill } from './a-shares-sync-backfill';
import type { TushareClientService } from '../services/tushare-client.service';
import type { TushareRow } from '../services/tushare-client.service';

function makeTushareMock(): { client: TushareClientService; query: jest.Mock } {
  const query = jest.fn();
  const client = { query } as unknown as TushareClientService;
  return { client, query };
}

function makeTsCodes(n: number, prefix = 'T'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(6, '0')}.SZ`);
}

function makeRows(tsCodes: string[]): TushareRow[] {
  return tsCodes.map((tsCode) => ({
    ts_code: tsCode,
    trade_date: '20260707',
    close: '10',
    open: '10',
    high: '10',
    low: '10',
    vol: '1000',
    amount: '10000',
  }));
}

describe('queryWithBackfill', () => {
  it('整拉行数充足（missing ratio < 阈值）→ 不触发补拉', async () => {
    const expected = makeTsCodes(100);
    const initialRows = makeRows(expected);
    const { client, query } = makeTushareMock();
    query.mockResolvedValue(initialRows);

    const result = await queryWithBackfill(client, 'daily', '20260707', '', expected, 0.05);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('daily', { trade_date: '20260707' }, '');
    expect(result.partial).toBe(false);
    expect(result.backfilled).toBe(0);
    expect(result.rows).toHaveLength(100);
  });

  it('整拉行数不足（missing ratio > 5%）→ 触发补拉，补拉补齐', async () => {
    const expected = makeTsCodes(100);
    const returned = expected.slice(0, 90);
    const missing = expected.slice(90);
    const initialRows = makeRows(returned);
    const batchRows = makeRows(missing);
    const { client, query } = makeTushareMock();
    query.mockResolvedValueOnce(initialRows).mockResolvedValueOnce(batchRows);

    const result = await queryWithBackfill(client, 'daily', '20260707', '', expected, 0.05);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(2, 'daily', { ts_code: missing.join(','), trade_date: '20260707' }, '');
    expect(result.partial).toBe(true);
    expect(result.backfilled).toBe(10);
    expect(result.rows).toHaveLength(100);
  });

  it('整拉行数不足，补拉部分成功', async () => {
    const expected = makeTsCodes(100);
    const returned = expected.slice(0, 90);
    const missing = expected.slice(90);
    const partialRecovery = missing.slice(0, 5);
    const initialRows = makeRows(returned);
    const batchRows = makeRows(partialRecovery);
    const { client, query } = makeTushareMock();
    query.mockResolvedValueOnce(initialRows).mockResolvedValueOnce(batchRows);

    const result = await queryWithBackfill(client, 'daily', '20260707', '', expected, 0.05);

    expect(query).toHaveBeenCalledTimes(2);
    expect(result.partial).toBe(true);
    expect(result.backfilled).toBe(5);
    expect(result.rows).toHaveLength(95);
  });

  it('missing 恰好等于阈值边界（5%）→ 不触发补拉', async () => {
    const expected = makeTsCodes(100);
    const returned = expected.slice(0, 95);
    const initialRows = makeRows(returned);
    const { client, query } = makeTushareMock();
    query.mockResolvedValue(initialRows);

    const result = await queryWithBackfill(client, 'daily', '20260707', '', expected, 0.05);

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.partial).toBe(false);
    expect(result.backfilled).toBe(0);
  });

  it('missing 超过阈值 1 个（6%）→ 触发补拉', async () => {
    const expected = makeTsCodes(100);
    const returned = expected.slice(0, 94);
    const missing = expected.slice(94);
    const initialRows = makeRows(returned);
    const batchRows = makeRows(missing);
    const { client, query } = makeTushareMock();
    query.mockResolvedValueOnce(initialRows).mockResolvedValueOnce(batchRows);

    const result = await queryWithBackfill(client, 'daily', '20260707', '', expected, 0.05);

    expect(query).toHaveBeenCalledTimes(2);
    expect(result.partial).toBe(true);
    expect(result.backfilled).toBe(6);
  });

  it('超过 100 只缺失时分批补拉', async () => {
    const expected = makeTsCodes(250);
    const returned = expected.slice(0, 100);
    const missing = expected.slice(100);
    const initialRows = makeRows(returned);
    const { client, query } = makeTushareMock();
    query.mockResolvedValueOnce(initialRows);
    for (let i = 0; i < missing.length; i += 100) {
      query.mockResolvedValueOnce(makeRows(missing.slice(i, i + 100)));
    }

    const result = await queryWithBackfill(client, 'daily', '20260707', '', expected, 0.05);

    expect(result.partial).toBe(true);
    expect(result.backfilled).toBe(150);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('expectedTsCodes 为空时不报错，partial=false', async () => {
    const initialRows: TushareRow[] = [];
    const { client, query } = makeTushareMock();
    query.mockResolvedValue(initialRows);

    const result = await queryWithBackfill(client, 'daily', '20260707', '', [], 0.05);

    expect(result.partial).toBe(false);
    expect(result.backfilled).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});
