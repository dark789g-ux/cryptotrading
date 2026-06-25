import { filterExistingDates } from './money-flow-sync.helpers';

/**
 * filterExistingDates 的 category 收敛回归测试。
 *
 * 背景（真实 bug）：index_daily_quotes 同表混装 market/industry/concept/sw 四类，
 * sw 增量同步若不按 category='sw' 收敛，会被同表 industry/concept（ths 先写）已写的
 * 同一 trade_date 误判为「已同步」而整窗口跳过——导致申万指数停更。
 *
 * 本文件用 mock queryBuilder，只能验证「是否带上了 category 收敛子句 + 入参」与
 * 「已存在日期被剔除」的纯逻辑；真正的 SQL 语义须靠集成/真机验证。
 */
describe('filterExistingDates', () => {
  function makeRepo(existing: Array<{ tradeDate: string }>) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(existing),
    };
    return {
      qb,
      repo: { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never,
    };
  }

  it('不传 categoryScope：不加 category 子句，按 trade_date 剔除已存在日期', async () => {
    const { qb, repo } = makeRepo([{ tradeDate: '20260623' }]);
    const res = await filterExistingDates(repo, ['20260623', '20260624', '20260625']);
    expect(res).toEqual({ dates: ['20260624', '20260625'], skipped: 1 });
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('categoryScope=单值：带 category IN (:cats) 且 cats=[值]', async () => {
    const { qb, repo } = makeRepo([]);
    await filterExistingDates(repo, ['20260624', '20260625'], 'sw');
    expect(qb.andWhere).toHaveBeenCalledWith('e.category IN (:...cats)', {
      cats: ['sw'],
    });
  });

  it('categoryScope=数组：cats 原样透传', async () => {
    const { qb, repo } = makeRepo([]);
    await filterExistingDates(repo, ['20260625'], ['industry', 'concept']);
    expect(qb.andWhere).toHaveBeenCalledWith('e.category IN (:...cats)', {
      cats: ['industry', 'concept'],
    });
  });

  it('收敛后查询返回空：所有日期均视为未同步（不被他类污染）', async () => {
    // 模拟 sw 收敛后查不到任何 sw 行（尽管同表有 industry/concept 的同日数据）
    const { repo } = makeRepo([]);
    const res = await filterExistingDates(repo, ['20260624', '20260625'], 'sw');
    expect(res).toEqual({ dates: ['20260624', '20260625'], skipped: 0 });
  });
});
