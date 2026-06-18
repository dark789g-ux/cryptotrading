/**
 * oamv.service.spec.ts
 *
 * 单测 OamvService.get0amvData 的日期区间分支（KlineChart 工具栏 update:range 接入）：
 *   1. 不传 range → find({ order: DESC, take: days })，结果 reverse（保最近 N 条 ASC）
 *   2. 传 {startDate, endDate} → find({ where: tradeDate Between, order: ASC })，无 take
 *   3. 只传 startDate → MoreThanOrEqual
 *   4. 只传 endDate   → LessThanOrEqual
 * 不连真 DB，mock repo.find。
 */

import { Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { OamvService } from './oamv.service';

function makeRepoMock(rows: Array<{ tradeDate: string }> = []) {
  return { find: jest.fn().mockResolvedValue(rows) };
}

function makeService(repo: ReturnType<typeof makeRepoMock>): OamvService {
  // OamvService 构造：(repo, tushareClient)；get0amvData 只碰 repo。
  return new OamvService(repo as never, null as never);
}

describe('OamvService.get0amvData - 日期区间分支', () => {
  it('不传 range：取最近 days 条（DESC + take）并 reverse 成 ASC', async () => {
    const repo = makeRepoMock([{ tradeDate: '20240103' }, { tradeDate: '20240102' }]);
    const svc = makeService(repo);

    const out = await svc.get0amvData(120);

    expect(repo.find).toHaveBeenCalledWith({ order: { tradeDate: 'DESC' }, take: 120 });
    // reverse：DESC 结果翻成 ASC
    expect(out.map((r) => r.tradeDate)).toEqual(['20240102', '20240103']);
  });

  it('传 startDate+endDate：tradeDate Between，ASC，无 take', async () => {
    const repo = makeRepoMock([{ tradeDate: '20240102' }]);
    const svc = makeService(repo);

    await svc.get0amvData(250, { startDate: '20240101', endDate: '20240201' });

    expect(repo.find).toHaveBeenCalledWith({
      where: { tradeDate: Between('20240101', '20240201') },
      order: { tradeDate: 'ASC' },
    });
  });

  it('只传 startDate：MoreThanOrEqual', async () => {
    const repo = makeRepoMock();
    const svc = makeService(repo);

    await svc.get0amvData(250, { startDate: '20240101' });

    expect(repo.find).toHaveBeenCalledWith({
      where: { tradeDate: MoreThanOrEqual('20240101') },
      order: { tradeDate: 'ASC' },
    });
  });

  it('只传 endDate：LessThanOrEqual', async () => {
    const repo = makeRepoMock();
    const svc = makeService(repo);

    await svc.get0amvData(250, { endDate: '20240201' });

    expect(repo.find).toHaveBeenCalledWith({
      where: { tradeDate: LessThanOrEqual('20240201') },
      order: { tradeDate: 'ASC' },
    });
  });

  it('range 对象存在但两端皆空：回落到 days 分支', async () => {
    const repo = makeRepoMock([{ tradeDate: '20240102' }]);
    const svc = makeService(repo);

    await svc.get0amvData(250, {});

    expect(repo.find).toHaveBeenCalledWith({ order: { tradeDate: 'DESC' }, take: 250 });
  });
});
