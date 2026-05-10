// TODO: 需集成测试验证 API 契约（ths_index / ths_member 接口名与参数）
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexCatalogSyncService } from './index-catalog-sync.service';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

function makeRepoMock<T extends object>(): jest.Mocked<Repository<T>> {
  return {
    upsert: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(),
    create: jest.fn().mockImplementation((x: T) => x),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    query: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

describe('IndexCatalogSyncService', () => {
  let service: IndexCatalogSyncService;
  let catalogRepo: jest.Mocked<Repository<ThsIndexCatalogEntity>>;
  let memberRepo: jest.Mocked<Repository<ThsMemberStockEntity>>;
  let tushare: { query: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    catalogRepo = makeRepoMock();
    memberRepo = makeRepoMock();
    tushare = { query: jest.fn() };
    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (manager: { delete: jest.Mock; upsert: jest.Mock }) => Promise<void>) =>
        cb({
          delete: jest.fn().mockResolvedValue({ affected: 0 }),
          upsert: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexCatalogSyncService,
        { provide: getRepositoryToken(ThsIndexCatalogEntity), useValue: catalogRepo },
        { provide: getRepositoryToken(ThsMemberStockEntity), useValue: memberRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: TushareClientService, useValue: tushare },
      ],
    }).compile();

    service = module.get(IndexCatalogSyncService);
  });

  describe('syncCatalog', () => {
    it('调用 ths_index 时 type=I exchange=A 字段完整', async () => {
      tushare.query.mockResolvedValue([
        { ts_code: '881101.TI', name: '采掘', count: 50, exchange: 'A', list_date: '20100101', type: 'I' },
      ]);

      const result = await service.syncCatalog('I');

      expect(tushare.query).toHaveBeenCalledWith(
        'ths_index',
        { type: 'I', exchange: 'A' },
        'ts_code,name,count,exchange,list_date,type',
      );
      expect(catalogRepo.upsert).toHaveBeenCalled();
      expect(result.success).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('返回空数据时记 warn 并 success=0', async () => {
      tushare.query.mockResolvedValue([]);
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const result = await service.syncCatalog('N');

      expect(result.success).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ths_index type=N'));
    });

    it('同 ts_code 重复行去重后仅 upsert 一条', async () => {
      tushare.query.mockResolvedValue([
        { ts_code: 'X.TI', name: 'A', count: 1, exchange: 'A', list_date: '20100101', type: 'I' },
        { ts_code: 'X.TI', name: 'B', count: 2, exchange: 'A', list_date: '20100101', type: 'I' },
      ]);

      const result = await service.syncCatalog('I');

      expect(result.success).toBe(1);
    });

    it('ths_index 调用失败时 errors 透出且不 upsert', async () => {
      tushare.query.mockRejectedValue(new Error('rate limit'));

      const result = await service.syncCatalog('I');

      expect(catalogRepo.upsert).not.toHaveBeenCalled();
      expect(result.errors[0]).toContain('ths_index type=I');
    });
  });

  describe('syncMembers', () => {
    function setupCatalogQuery(tsCodes: string[]) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(tsCodes.map((t) => ({ tsCode: t }))),
      };
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(qb) as never;
    }

    it('对每个 ts_code 各调一次 ths_member 并事务式写入', async () => {
      setupCatalogQuery(['881101.TI', '881102.TI']);
      tushare.query.mockResolvedValue([
        { ts_code: '881101.TI', con_code: '000001.SZ', con_name: '平安银行', is_new: 'Y' },
      ]);

      const result = await service.syncMembers('I');

      expect(tushare.query).toHaveBeenCalledTimes(2);
      expect(tushare.query).toHaveBeenNthCalledWith(
        1,
        'ths_member',
        { ts_code: '881101.TI' },
        'ts_code,con_code,con_name,is_new',
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('某个 ts_code 调用失败时记 errors 但继续后续', async () => {
      setupCatalogQuery(['A.TI', 'B.TI']);
      tushare.query
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([
          { ts_code: 'B.TI', con_code: '000001.SZ', con_name: 'X', is_new: 'Y' },
        ]);

      const result = await service.syncMembers('I');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('A.TI');
      expect(result.success).toBe(1);
    });

    it('某个 ts_code 返回空数据时记 warn 跳过', async () => {
      setupCatalogQuery(['EMPTY.TI']);
      tushare.query.mockResolvedValue([]);
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const result = await service.syncMembers('I');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EMPTY.TI'));
      expect(result.success).toBe(0);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('目录中无指定 type 的 ts_code 时记 warn 并 success=0', async () => {
      setupCatalogQuery([]);
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const result = await service.syncMembers('N');

      expect(result.success).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('type=N'));
      expect(tushare.query).not.toHaveBeenCalled();
    });
  });
});
