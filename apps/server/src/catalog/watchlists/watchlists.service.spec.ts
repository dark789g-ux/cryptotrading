import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchlistsService } from './watchlists.service';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';

describe('WatchlistsService', () => {
  let service: WatchlistsService;
  let watchlistRepo: jest.Mocked<Repository<WatchlistEntity>>;
  let itemRepo: jest.Mocked<Repository<WatchlistItemEntity>>;

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
      ],
    }).compile();

    service = module.get<WatchlistsService>(WatchlistsService);
    watchlistRepo = module.get(getRepositoryToken(WatchlistEntity));
    itemRepo = module.get(getRepositoryToken(WatchlistItemEntity));
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
});
