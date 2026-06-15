import { UsStocksSymbolsService } from './us-stocks-symbols.service';

/**
 * 单测 UsStocksSymbolsService.updateTracked 的 tracked 写契约：
 *   - 只 UPDATE { ticker } → { tracked }（不碰其它列）
 *   - 按 ticker 去重（保留最后一条）
 *   - 过滤非法项（缺 ticker / tracked 非布尔）
 *   - 汇总 affected 行数
 * 不连真 DB，mock repo.update。
 */

function makeRepoMock(affectedPerCall = 1) {
  return {
    update: jest.fn().mockResolvedValue({ affected: affectedPerCall }),
    createQueryBuilder: jest.fn(),
  };
}

function makeService(repo: ReturnType<typeof makeRepoMock>): UsStocksSymbolsService {
  return new UsStocksSymbolsService(repo as never);
}

describe('UsStocksSymbolsService.updateTracked', () => {
  it('空数组 → 不调用 update，updated=0', async () => {
    const repo = makeRepoMock();
    const svc = makeService(repo);
    await expect(svc.updateTracked([])).resolves.toEqual({ updated: 0 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('每条只 UPDATE { ticker } → { tracked }（不碰其它列）', async () => {
    const repo = makeRepoMock();
    const svc = makeService(repo);
    await svc.updateTracked([
      { ticker: 'NVDA', tracked: true },
      { ticker: 'MSFT', tracked: false },
    ]);
    expect(repo.update).toHaveBeenCalledTimes(2);
    expect(repo.update).toHaveBeenNthCalledWith(1, { ticker: 'NVDA' }, { tracked: true });
    expect(repo.update).toHaveBeenNthCalledWith(2, { ticker: 'MSFT' }, { tracked: false });
  });

  it('同 ticker 去重，保留最后一条', async () => {
    const repo = makeRepoMock();
    const svc = makeService(repo);
    await svc.updateTracked([
      { ticker: 'NVDA', tracked: true },
      { ticker: 'NVDA', tracked: false },
    ]);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith({ ticker: 'NVDA' }, { tracked: false });
  });

  it('过滤非法项（缺 ticker / tracked 非布尔 / null）', async () => {
    const repo = makeRepoMock();
    const svc = makeService(repo);
    await svc.updateTracked([
      { ticker: 'NVDA', tracked: true },
      { ticker: '', tracked: true } as never,
      { tracked: true } as never,
      { ticker: 'MSFT' } as never,
      null as never,
      { ticker: 'AAPL', tracked: 'yes' } as never,
    ]);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith({ ticker: 'NVDA' }, { tracked: true });
  });

  it('汇总 affected 行数', async () => {
    const repo = makeRepoMock(1);
    const svc = makeService(repo);
    await expect(
      svc.updateTracked([
        { ticker: 'NVDA', tracked: true },
        { ticker: 'MSFT', tracked: true },
      ]),
    ).resolves.toEqual({ updated: 2 });
  });

  it('不存在的 ticker（affected=0）不计入 updated', async () => {
    const repo = makeRepoMock(0);
    const svc = makeService(repo);
    await expect(
      svc.updateTracked([{ ticker: 'NOPE', tracked: true }]),
    ).resolves.toEqual({ updated: 0 });
  });
});
