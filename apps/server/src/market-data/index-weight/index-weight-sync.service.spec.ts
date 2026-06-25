import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IndexWeightSyncService } from './index-weight-sync.service';
import { IndexWeightEntity } from '../../entities/index-catalog/index-weight.entity';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

describe('IndexWeightSyncService', () => {
  let service: IndexWeightSyncService;
  let tushareClient: { query: jest.Mock };
  let weightRepo: {
    find: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
    manager: { transaction: jest.Mock };
    create: jest.Mock;
  };
  let catalogRepo: { find: jest.Mock };

  const mockRepo = () => ({
    find: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    insert: jest.fn().mockResolvedValue({}),
    manager: {
      transaction: jest.fn().mockImplementation(async (cb: (m: any) => Promise<unknown>) => {
        const managerRepo = {
          getRepository: () => ({
            update: weightRepo.update,
            insert: weightRepo.insert,
            create: weightRepo.create,
          }),
        };
        return cb(managerRepo);
      }),
    },
    create: jest.fn().mockImplementation((x: any) => x),
  });

  beforeEach(async () => {
    tushareClient = { query: jest.fn() };
    weightRepo = mockRepo();
    catalogRepo = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexWeightSyncService,
        { provide: getRepositoryToken(IndexWeightEntity), useValue: weightRepo },
        { provide: getRepositoryToken(ThsIndexCatalogEntity), useValue: catalogRepo },
        { provide: TushareClientService, useValue: tushareClient },
      ],
    }).compile();

    service = module.get(IndexWeightSyncService);
  });

  describe('syncForMonth', () => {
    it('首次同步生成新版本：插入 active 行，expireDate 为 NULL', async () => {
      tushareClient.query.mockResolvedValue([
        { con_code: '000001.SZ', trade_date: '20240628', weight: 0.1 },
        { con_code: '000002.SZ', trade_date: '20240628', weight: 0.2 },
      ]);
      weightRepo.find.mockResolvedValue([]);

      const changed = await service.syncForMonth('000001.SH', '2024-06');

      expect(changed).toBe(true);
      expect(weightRepo.update).toHaveBeenCalledWith(
        { indexCode: '000001.SH', expireDate: expect.any(Object) },
        { expireDate: expect.any(String) },
      );
      expect(weightRepo.insert).toHaveBeenCalled();
      const inserted = weightRepo.insert.mock.calls[0][0] as Array<{ indexCode: string; conCode: string; effectiveDate: string; expireDate: null }>;
      expect(inserted).toHaveLength(2);
      expect(inserted[0].expireDate).toBeNull();
      expect(inserted[0].effectiveDate).toBe('20240628');
    });

    it('成分无变化时跳过：不生成新版本', async () => {
      tushareClient.query.mockResolvedValue([
        { con_code: '000001.SZ', trade_date: '20240628', weight: 0.1 },
      ]);
      weightRepo.find.mockResolvedValue([{ conCode: '000001.SZ' }]);

      const changed = await service.syncForMonth('000001.SH', '2024-06');

      expect(changed).toBe(false);
      expect(weightRepo.insert).not.toHaveBeenCalled();
    });

    it('成分变化时版本切换：旧版本 expireDate 设为生效日前一天', async () => {
      tushareClient.query.mockResolvedValue([
        { con_code: '000001.SZ', trade_date: '20240628', weight: 0.1 },
        { con_code: '000003.SZ', trade_date: '20240628', weight: 0.2 },
      ]);
      weightRepo.find.mockResolvedValue([{ conCode: '000001.SZ' }]);

      const changed = await service.syncForMonth('000001.SH', '2024-06');

      expect(changed).toBe(true);
      expect(weightRepo.update).toHaveBeenCalled();
      const updateCall = weightRepo.update.mock.calls[0];
      expect(updateCall[1].expireDate).toBe('20240627');
    });

    it('返回 0 行时抛出 index_weight_empty', async () => {
      tushareClient.query.mockResolvedValue([]);
      await expect(service.syncForMonth('000001.SH', '2024-06')).rejects.toThrow('index_weight_empty');
    });
  });

  describe('syncIfNeeded', () => {
    it('对 type=M 的每个指数逐月同步', async () => {
      catalogRepo.find.mockResolvedValue([
        { tsCode: '000001.SH' },
        { tsCode: '000016.SH' },
      ]);
      tushareClient.query.mockResolvedValue([
        { con_code: '000001.SZ', trade_date: '20240628', weight: 0.1 },
      ]);
      weightRepo.find.mockResolvedValue([]);

      const result = await service.syncIfNeeded({ startDate: '20240601', endDate: '20240630' });

      expect(result.totalIndexes).toBe(2);
      expect(result.successIndexes).toBe(2);
      expect(tushareClient.query).toHaveBeenCalledTimes(2);
    });

    it('ths_index_catalog type=M 为空时返回 market_scope_empty 错误', async () => {
      catalogRepo.find.mockResolvedValue([]);
      const result = await service.syncIfNeeded({ startDate: '20240601', endDate: '20240630' });
      expect(result.errors[0].apiName).toBe('market_scope_empty');
    });
  });
});
