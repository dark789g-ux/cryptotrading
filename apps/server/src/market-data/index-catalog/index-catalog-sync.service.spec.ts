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
});
