/**
 * oamv.service.spec.ts
 *
 * 单测 OamvService：
 *   - get0amvData 日期区间分支（KlineChart 工具栏 update:range 接入）
 *   - recalcKlines 自定义 KDJ 参数重算
 * 不连真 DB，mock repo.find。
 */

import { Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity';
import { calcKdjSeries, roundKdjPoint } from '../../indicators/kdj';
import { OamvService } from './oamv.service';

function makeRepoMock(rows: unknown[] = []) {
  return { find: jest.fn().mockResolvedValue(rows) };
}

function makeService(repo: ReturnType<typeof makeRepoMock>): OamvService {
  // OamvService 构造：(repo, indexDailyRepo)；get0amvData / recalcKlines 只碰 repo，indexDailyRepo 传 null。
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

// ── 工具：构造模拟 OamvDailyEntity 行 ─────────────────────────────────────────

function makeMockEntities(count = 12): OamvDailyEntity[] {
  const rows: OamvDailyEntity[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + i * 2;
    const row = new OamvDailyEntity();
    row.id = `id-${i}`;
    row.tradeDate = `202401${String(i + 1).padStart(2, '0')}`;
    row.open = String(base);
    row.high = String(base + 3);
    row.low = String(base - 1);
    row.close = String(base + (i % 3) - 1);
    row.amvDif = 0.5 + i * 0.1;
    row.amvDea = 0.3 + i * 0.05;
    row.amvMacd = 0.2 + i * 0.05;
    row.ma5 = base + 0.5;
    row.ma30 = base - 0.5;
    row.ma60 = base - 1.5;
    row.ma120 = base - 3;
    row.ma240 = base - 5;
    row.kdjK = 50 + i;
    row.kdjD = 45 + i;
    row.kdjJ = 60 + i;
    row.createdAt = new Date('2024-01-01T00:00:00Z');
    rows.push(row);
  }
  return rows;
}

// ── 测试套件：recalcKlines ────────────────────────────────────────────────────

describe('OamvService.recalcKlines', () => {
  it('不传 kdjParams 时返回与 get0amvData 完全相同的数据', async () => {
    const rows = makeMockEntities();
    const repo = makeRepoMock(rows);
    const svc = makeService(repo);

    const fromGet = await svc.get0amvData(250);
    const fromRecalc = await svc.recalcKlines(250);

    expect(fromRecalc).toEqual(fromGet);
  });

  it('自定义 KDJ 参数会改变 kdjK/kdjD/kdjJ，其余字段保持不变', async () => {
    const rows = makeMockEntities();
    const repo = makeRepoMock(rows);
    const svc = makeService(repo);

    const defaultRows = await svc.recalcKlines(250);
    const customRows = await svc.recalcKlines(250, undefined, { n: 6, m1: 2, m2: 2 });

    expect(customRows).toHaveLength(defaultRows.length);

    for (let i = 0; i < customRows.length; i++) {
      const custom = customRows[i];
      const baseline = defaultRows[i];

      expect(custom.kdjK).not.toEqual(baseline.kdjK);
      expect(custom.kdjD).not.toEqual(baseline.kdjD);
      expect(custom.kdjJ).not.toEqual(baseline.kdjJ);

      expect(custom.id).toEqual(baseline.id);
      expect(custom.tradeDate).toEqual(baseline.tradeDate);
      expect(custom.open).toEqual(baseline.open);
      expect(custom.high).toEqual(baseline.high);
      expect(custom.low).toEqual(baseline.low);
      expect(custom.close).toEqual(baseline.close);
      expect(custom.amvDif).toEqual(baseline.amvDif);
      expect(custom.amvDea).toEqual(baseline.amvDea);
      expect(custom.amvMacd).toEqual(baseline.amvMacd);
      expect(custom.ma5).toEqual(baseline.ma5);
      expect(custom.ma30).toEqual(baseline.ma30);
      expect(custom.ma60).toEqual(baseline.ma60);
      expect(custom.ma120).toEqual(baseline.ma120);
      expect(custom.ma240).toEqual(baseline.ma240);
    }
  });

  it('显式传入默认参数 9/3/3 时不触发重算，结果与 get0amvData 一致', async () => {
    const rows = makeMockEntities();
    const repo = makeRepoMock(rows);
    const svc = makeService(repo);

    const fromGet = await svc.get0amvData(250);
    const fromRecalc = await svc.recalcKlines(250, undefined, { n: 9, m1: 3, m2: 3 });

    expect(fromRecalc).toEqual(fromGet);
  });

  it('自定义 KDJ 结果按 4 位小数取整，并与 calcKdjSeries 取整后一致', async () => {
    const rows = makeMockEntities();
    const repo = makeRepoMock(rows);
    const svc = makeService(repo);

    const kdjParams = { n: 6, m1: 2, m2: 2 };
    const out = await svc.recalcKlines(250, undefined, kdjParams);

    const expected = calcKdjSeries(
      rows.map((r) => ({
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
      })),
      kdjParams.n,
      kdjParams.m1,
      kdjParams.m2,
    ).map(roundKdjPoint);

    expect(out).toHaveLength(expected.length);
    for (let i = 0; i < out.length; i++) {
      expect(out[i].kdjK).toBeCloseTo(expected[i].k, 4);
      expect(out[i].kdjD).toBeCloseTo(expected[i].d, 4);
      expect(out[i].kdjJ).toBeCloseTo(expected[i].j, 4);
      expect(out[i].kdjK).toEqual(parseFloat(out[i].kdjK!.toFixed(4)));
      expect(out[i].kdjD).toEqual(parseFloat(out[i].kdjD!.toFixed(4)));
      expect(out[i].kdjJ).toEqual(parseFloat(out[i].kdjJ!.toFixed(4)));
    }
  });
});
