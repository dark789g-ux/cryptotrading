import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchlistsService } from './watchlists.service';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';

describe('WatchlistsService.upsertByName', () => {
  let service: WatchlistsService;
  let watchlistRepo: jest.Mocked<Repository<WatchlistEntity>>;
  let managerQuery: jest.Mock;
  let dataSourceTransaction: jest.Mock;

  beforeEach(async () => {
    managerQuery = jest.fn().mockResolvedValue(undefined);
    dataSourceTransaction = jest.fn((cb: any) => cb({ query: managerQuery }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WatchlistsService,
        {
          provide: getRepositoryToken(WatchlistEntity),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            create: jest.fn((data: any) => ({ ...data })),
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
          useValue: { transaction: dataSourceTransaction },
        },
      ],
    }).compile();

    service = module.get<WatchlistsService>(WatchlistsService);
    watchlistRepo = module.get(getRepositoryToken(WatchlistEntity));
  });

  it('creates a new watchlist when name does not exist and inserts all symbols', async () => {
    // findOne 第一次（查 existing）→ null；第二次（ensureNameAvailable）→ null
    watchlistRepo.findOne.mockResolvedValue(null as any);
    watchlistRepo.save.mockImplementation(async (entity: any) => ({
      id: 'new-wl-uuid',
      userId: entity.userId,
      name: entity.name,
      items: [],
    } as any));

    const result = await service.upsertByName('user-1', {
      name: '半导体',
      symbols: ['600000.SH', '000001.SZ', '600519.SH'],
    });

    expect(result).toEqual({
      watchlistId: 'new-wl-uuid',
      name: '半导体',
      created: true,
      added: 3,
      skipped: 0,
    });
    expect(dataSourceTransaction).toHaveBeenCalledTimes(1);
    expect(managerQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = managerQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO watchlist_items/);
    expect(sql).toMatch(/ON CONFLICT \(watchlist_id, symbol\) DO NOTHING/);
    expect(sql).toMatch(/unnest\(\$2::text\[\]\)/);
    expect(params).toEqual(['new-wl-uuid', ['600000.SH', '000001.SZ', '600519.SH']]);
  });

  it('reuses existing watchlist and counts added/skipped correctly when some symbols already in list', async () => {
    watchlistRepo.findOne.mockResolvedValueOnce({
      id: 'wl-existing',
      userId: 'user-1',
      name: '科创50',
      items: [{ symbol: '600000.SH' }, { symbol: '000001.SZ' }],
    } as any);

    const result = await service.upsertByName('user-1', {
      name: '科创50',
      // 600000.SH 已在 → skipped；600519.SH 新 → added；000001.SZ 已在 → skipped
      symbols: ['600000.SH', '600519.SH', '000001.SZ'],
    });

    expect(result).toEqual({
      watchlistId: 'wl-existing',
      name: '科创50',
      created: false,
      added: 1,
      skipped: 2,
    });
    expect(watchlistRepo.save).not.toHaveBeenCalled();
    expect(managerQuery).toHaveBeenCalledTimes(1);
    const [, params] = managerQuery.mock.calls[0];
    expect(params).toEqual(['wl-existing', ['600519.SH']]);
  });

  it('dedupes input symbols (warn) and computes skipped on the deduped list', async () => {
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    watchlistRepo.findOne.mockResolvedValueOnce({
      id: 'wl-1',
      userId: 'user-1',
      name: '医药',
      items: [{ symbol: '600276.SH' }],
    } as any);

    // 入参 5 条，去重后 3 条：['600276.SH','000661.SZ','300760.SZ']
    // 已在 items 内：600276.SH → skipped=1
    // 新增：000661.SZ、300760.SZ → added=2
    const result = await service.upsertByName('user-1', {
      name: '医药',
      symbols: ['600276.SH', '000661.SZ', '600276.SH', '300760.SZ', '000661.SZ'],
    });

    expect(result).toEqual({
      watchlistId: 'wl-1',
      name: '医药',
      created: false,
      added: 2,
      skipped: 1,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('[upsertByName] symbols 含重复');
    expect(warnMsg).toContain('original=5');
    expect(warnMsg).toContain('deduped=3');

    const [, params] = managerQuery.mock.calls[0];
    expect(params).toEqual(['wl-1', ['000661.SZ', '300760.SZ']]);
  });
});
