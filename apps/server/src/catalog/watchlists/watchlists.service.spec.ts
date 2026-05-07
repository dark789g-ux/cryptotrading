import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchlistsService } from './watchlists.service';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';
import { NotFoundException } from '@nestjs/common';

describe('WatchlistsService', () => {
  let service: WatchlistsService;
  let watchlistRepo: jest.Mocked<Repository<WatchlistEntity>>;
  let itemRepo: jest.Mocked<Repository<WatchlistItemEntity>>;
  let tushareClient: jest.Mocked<TushareClientService>;
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WatchlistsService,
        {
          provide: getRepositoryToken(WatchlistEntity),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            query: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(WatchlistItemEntity),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            delete: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: TushareClientService,
          useValue: { query: jest.fn() },
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn((cb) => cb({
              delete: jest.fn(),
              create: jest.fn((_, data) => data),
              save: jest.fn(),
            })),
          },
        },
      ],
    }).compile();

    service = module.get<WatchlistsService>(WatchlistsService);
    watchlistRepo = module.get(getRepositoryToken(WatchlistEntity));
    itemRepo = module.get(getRepositoryToken(WatchlistItemEntity));
    tushareClient = module.get(TushareClientService);
    dataSource = module.get(getDataSourceToken());
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('reorderWatchlists', () => {
    it('should update displayOrder for each watchlist', async () => {
      watchlistRepo.update.mockResolvedValue({ affected: 1 } as any);
      const result = await service.reorderWatchlists('user-1', ['id-a', 'id-b', 'id-c']);
      expect(result).toEqual({ ok: true });
      expect(watchlistRepo.update).toHaveBeenCalledTimes(3);
      expect(watchlistRepo.update).toHaveBeenNthCalledWith(
        1,
        { id: 'id-a', userId: 'user-1' },
        { displayOrder: 0 },
      );
    });
  });

  describe('reorderItems', () => {
    it('should update displayOrder for each item', async () => {
      watchlistRepo.findOne.mockResolvedValue({
        id: 'wl-1',
        items: [],
      } as WatchlistEntity);
      itemRepo.update.mockResolvedValue({ affected: 1 } as any);
      const result = await service.reorderItems('user-1', 'wl-1', ['BTCUSDT', 'ETHUSDT']);
      expect(result).toEqual({ ok: true });
      expect(itemRepo.update).toHaveBeenCalledTimes(2);
    });
  });

  describe('getWatchlistQuotes', () => {
    it('should query A-share quote tables for watchlist symbols stored as ts_code', async () => {
      watchlistRepo.findOne.mockResolvedValue({
        id: 'wl-1',
        userId: 'user-1',
        items: [{ symbol: '000001.SZ' }, { symbol: '000002.SZ' }],
      } as WatchlistEntity);
      watchlistRepo.query.mockResolvedValue([
        {
          symbol: '000001.SZ',
          close: '12.3400000000',
          ma5: 12.1,
          ma30: 11.8,
          kdjJ: 72.5,
          riskRewardRatio: 2.1,
          stopLossPct: 6.2,
          openTime: '20260430',
        },
      ]);

      const result = await service.getWatchlistQuotes('user-1', 'wl-1', '1d', 1, 20);

      expect(result).toEqual({
        items: [
          {
            symbol: '000001.SZ',
            close: '12.3400000000',
            ma5: 12.1,
            ma30: 11.8,
            kdjJ: 72.5,
            riskRewardRatio: 2.1,
            stopLossPct: 6.2,
            openTime: '20260430',
          },
        ],
        total: 2,
        page: 1,
        page_size: 20,
      });
      const [sql, params] = watchlistRepo.query.mock.calls[0];
      expect(sql).toContain('a_share_daily_quotes');
      expect(sql).toContain('a_share_daily_indicators');
      expect(params).toEqual(['1d', ['000001.SZ', '000002.SZ']]);
    });
  });

  describe('importFromIndex', () => {
    const watchlistId = 'wl-uuid-1';
    const userId = 'user-1';

    beforeEach(() => {
      watchlistRepo.findOne.mockResolvedValue({
        id: watchlistId,
        userId,
        items: [{ symbol: 'OLD.SH' }],
      } as any);
    });

    it('should throw BadRequestException when Tushare returns empty list', async () => {
      tushareClient.query.mockResolvedValue([]);
      await expect(
        service.importFromIndex(userId, watchlistId, 'UNKNOWN.XX'),
      ).rejects.toThrow('未找到该指数成分数据');
    });

    it('should throw NotFoundException when watchlist not found', async () => {
      watchlistRepo.findOne.mockResolvedValue(null);
      tushareClient.query.mockResolvedValue([{ con_code: '600000.SH' }]);
      await expect(
        service.importFromIndex(userId, watchlistId, '399300.SZ'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should replace members and return counts', async () => {
      const conCodes = ['600000.SH', '000001.SZ'];
      tushareClient.query.mockResolvedValue(
        conCodes.map((c) => ({ con_code: c })),
      );

      const result = await service.importFromIndex(userId, watchlistId, '399300.SZ');

      expect(tushareClient.query).toHaveBeenCalledWith(
        'index_weight',
        expect.objectContaining({ index_code: '399300.SZ', start_date: expect.any(String), end_date: expect.any(String) }),
        'con_code',
      );
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(result).toEqual({ imported: 2, replaced: 1 });
    });

    it('should deduplicate con_codes from multiple months of index_weight data', async () => {
      // index_weight 是月度数据，同一成分会出现多次
      tushareClient.query.mockResolvedValue([
        { con_code: '600000.SH' },
        { con_code: '000001.SZ' },
        { con_code: '600000.SH' }, // 重复
        { con_code: '000001.SZ' }, // 重复
      ]);

      const result = await service.importFromIndex(userId, watchlistId, '399300.SZ');
      expect(result.imported).toBe(2);
    });
  });
});
