import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPreferenceEntity } from '../entities/config/user-preference.entity';
import {
  PreferencesService,
  SYMBOLS_VIEW_PREFERENCES_KEY,
} from './preferences.service';

describe('PreferencesService', () => {
  let service: PreferencesService;
  let repo: jest.Mocked<Repository<UserPreferenceEntity>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PreferencesService,
        {
          provide: getRepositoryToken(UserPreferenceEntity),
          useValue: {
            findOneBy: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(PreferencesService);
    repo = module.get(getRepositoryToken(UserPreferenceEntity));
  });

  const EMPTY = {
    crypto: { table: [], split: [] },
    aShares: { table: [], split: [] },
    usStocks: { table: [], split: [] },
    aSharesIndex: { table: [], split: [] },
  };

  describe('getSymbolsView · sanitizeScopeView（只净化结构，不做业务 fallback）', () => {
    it('无记录 → 三个 scope 均为 { table: [], split: [] }', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual(EMPTY);
    });

    it('新格式对象（table + split 都有）→ 原样净化', async () => {
      const stored = {
        crypto: {
          table: [{ key: 'close', visible: false }],
          split: [{ key: 'close', visible: true }],
        },
        aShares: {
          table: [
            { key: 'name', visible: true },
            { key: 'buySignal', visible: true },
          ],
          split: [{ key: 'name', visible: true }],
        },
        usStocks: {
          table: [{ key: 'ma5', visible: false }],
          split: [{ key: 'ticker', visible: true }],
        },
        aSharesIndex: {
          table: [{ key: 'pctChange', visible: true }],
          split: [{ key: 'close', visible: false }],
        },
      };
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: stored,
      } as UserPreferenceEntity);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual(stored);
    });

    it('新格式对象只有 table → split 落空 []（缺失 scope 也落空）', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: {
          crypto: { table: [{ key: 'close', visible: false }] },
          aShares: { table: [{ key: 'name', visible: true }] },
          // usStocks 缺失
        },
      } as UserPreferenceEntity);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual({
        crypto: { table: [{ key: 'close', visible: false }], split: [] },
        aShares: { table: [{ key: 'name', visible: true }], split: [] },
        usStocks: { table: [], split: [] },
        aSharesIndex: { table: [], split: [] },
      });
    });

    it('老格式扁平数组 → 当作 table，split 落空 []', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: {
          crypto: [{ key: 'close', visible: false }],
          aShares: [
            { key: 'name', visible: true },
            { key: 'buySignal', visible: true },
          ],
          usStocks: [{ key: 'ticker', visible: true }],
        },
      } as UserPreferenceEntity);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual({
        crypto: { table: [{ key: 'close', visible: false }], split: [] },
        aShares: {
          table: [
            { key: 'name', visible: true },
            { key: 'buySignal', visible: true },
          ],
          split: [],
        },
        usStocks: { table: [{ key: 'ticker', visible: true }], split: [] },
        aSharesIndex: { table: [], split: [] },
      });
    });

    it('非法输入（null / string / number）→ { table: [], split: [] }', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: {
          crypto: null,
          aShares: 'not-an-object',
          usStocks: 42,
        },
      } as UserPreferenceEntity);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual(EMPTY);
    });

    it('数组含非法项（key 空串 / visible 非布尔 / 缺字段 / null）→ 过滤掉（table 与 split 对称）', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: {
          crypto: {
            table: [
              { key: 'close', visible: true },
              { key: '', visible: true }, // key 空串
              { key: 'name' }, // 缺 visible
              { visible: false }, // 缺 key
              null, // null
              { key: 'open', visible: 'yes' }, // visible 非布尔
              { key: 'high', visible: false }, // 合法
            ],
            split: [
              { key: 'low', visible: true }, // 合法
              { key: '', visible: false }, // 非法
            ],
          },
        },
      } as UserPreferenceEntity);

      await expect(service.getSymbolsView('user-1')).resolves.toEqual({
        crypto: {
          table: [
            { key: 'close', visible: true },
            { key: 'high', visible: false },
          ],
          split: [{ key: 'low', visible: true }],
        },
        aShares: { table: [], split: [] },
        usStocks: { table: [], split: [] },
        aSharesIndex: { table: [], split: [] },
      });
    });
  });

  describe('saveSymbolsView', () => {
    it('保留未知列键与顺序（新结构）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const input = {
        crypto: { table: [], split: [] },
        aShares: {
          table: [
            { key: 'tsCode', visible: true },
            { key: 'name', visible: true },
            { key: 'tags', visible: true },
            { key: 'buySignal', visible: false },
          ],
          split: [{ key: 'name', visible: true }],
        },
        usStocks: { table: [{ key: 'ticker', visible: true }], split: [] },
        aSharesIndex: { table: [], split: [] },
      };

      await service.saveSymbolsView('user-1', input);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ value: input }),
      );
    });

    it('table 槽内非法项被过滤（split 槽同样过滤）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveSymbolsView('user-1', {
        crypto: {
          table: [
            { key: 'name', visible: true },
            { key: '', visible: true },
            { visible: true },
            { key: 'actions' },
            null,
            { key: 'tsCode', visible: false },
          ],
          split: [{ key: 'close', visible: 'maybe' }],
        },
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: {
            crypto: {
              table: [
                { key: 'name', visible: true },
                { key: 'tsCode', visible: false },
              ],
              split: [],
            },
            aShares: { table: [], split: [] },
            usStocks: { table: [], split: [] },
            aSharesIndex: { table: [], split: [] },
          },
        }),
      );
    });

    it('更新已有记录（不走 create 分支）', async () => {
      const existing = {
        id: 'pref-1',
        userId: 'user-1',
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: EMPTY,
      } as UserPreferenceEntity;
      repo.findOneBy.mockResolvedValueOnce(existing);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const newValue = {
        crypto: { table: [{ key: 'close', visible: false }], split: [] },
        aShares: { table: [{ key: 'tsCode', visible: true }], split: [] },
        usStocks: { table: [{ key: 'ticker', visible: true }], split: [] },
        aSharesIndex: { table: [], split: [] },
      };

      await service.saveSymbolsView('user-1', newValue);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ value: newValue }),
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('save 后 getSymbolsView 读回一致（round-trip）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);

      let captured!: UserPreferenceEntity;
      repo.save.mockImplementation(async (entity) => {
        captured = entity as UserPreferenceEntity;
        return captured;
      });

      const input = {
        crypto: {
          table: [{ key: 'close', visible: false }],
          split: [{ key: 'close', visible: true }],
        },
        aShares: {
          table: [{ key: 'name', visible: true }],
          split: [{ key: 'name', visible: true }, { key: 'tsCode', visible: false }],
        },
        usStocks: { table: [], split: [] },
        aSharesIndex: {
          table: [{ key: 'pctChange', visible: true }],
          split: [{ key: 'close', visible: false }],
        },
      };

      await service.saveSymbolsView('user-1', input);

      repo.findOneBy.mockResolvedValueOnce(captured);
      await expect(service.getSymbolsView('user-1')).resolves.toEqual(input);
    });
  });
});
