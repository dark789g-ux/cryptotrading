import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPreferenceEntity } from '../entities/config/user-preference.entity';
import {
  PreferencesService,
  COLUMN_PREFERENCE_KEY_PREFIX,
  COLUMN_PREFERENCE_TABLE_IDS,
  isValidTableId,
  EMPTY_SCOPE_VIEW,
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

  describe('isValidTableId', () => {
    it('合法 tableId → true', () => {
      for (const id of COLUMN_PREFERENCE_TABLE_IDS) {
        expect(isValidTableId(id)).toBe(true);
      }
    });

    it('非法 tableId → false', () => {
      expect(isValidTableId('unknown')).toBe(false);
      expect(isValidTableId('')).toBe(false);
      expect(isValidTableId('symbols_view_columns')).toBe(false);
    });
  });

  describe('getTableColumns', () => {
    it('无记录 → EMPTY_SCOPE_VIEW', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await expect(service.getTableColumns('user-1', 'aShares')).resolves.toEqual(EMPTY_SCOPE_VIEW);
      expect(repo.findOneBy).toHaveBeenCalledWith({
        userId: 'user-1',
        key: COLUMN_PREFERENCE_KEY_PREFIX + 'aShares',
      });
    });

    it('有记录 → sanitize 后返回', async () => {
      const stored = {
        table: [{ key: 'name', visible: true }],
        split: [{ key: 'close', visible: false }],
      };
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: COLUMN_PREFERENCE_KEY_PREFIX + 'aShares',
        value: stored,
      } as UserPreferenceEntity);

      await expect(service.getTableColumns('user-1', 'aShares')).resolves.toEqual(stored);
    });

    it('老格式扁平数组 → 当作 table，split 落空 []', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: COLUMN_PREFERENCE_KEY_PREFIX + 'usStocks',
        value: [{ key: 'ticker', visible: true }],
      } as UserPreferenceEntity);

      await expect(service.getTableColumns('user-1', 'usStocks')).resolves.toEqual({
        table: [{ key: 'ticker', visible: true }],
        split: [],
      });
    });

    it('非法输入（null / string / number）→ EMPTY_SCOPE_VIEW', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: COLUMN_PREFERENCE_KEY_PREFIX + 'crypto',
        value: null,
      } as UserPreferenceEntity);

      await expect(service.getTableColumns('user-1', 'crypto')).resolves.toEqual(EMPTY_SCOPE_VIEW);
    });

    it('数组含非法项 → 过滤掉（table 与 split 对称）', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: COLUMN_PREFERENCE_KEY_PREFIX + 'aSharesIndex',
        value: {
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
      } as UserPreferenceEntity);

      await expect(service.getTableColumns('user-1', 'aSharesIndex')).resolves.toEqual({
        table: [
          { key: 'close', visible: true },
          { key: 'high', visible: false },
        ],
        split: [{ key: 'low', visible: true }],
      });
    });
  });

  describe('saveTableColumns', () => {
    it('首次存储 → INSERT，用 newId', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const input = {
        table: [{ key: 'tsCode', visible: true }],
        split: [],
      };

      await service.saveTableColumns('user-1', 'watchlist', input);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          key: COLUMN_PREFERENCE_KEY_PREFIX + 'watchlist',
          value: input,
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('重复存储 → UPDATE 同一行', async () => {
      const existing = {
        id: 'pref-1',
        userId: 'user-1',
        key: COLUMN_PREFERENCE_KEY_PREFIX + 'backtestMetrics',
        value: { table: [], split: [] },
      } as UserPreferenceEntity;
      repo.findOneBy.mockResolvedValueOnce(existing);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const newValue = {
        table: [{ key: 'return', visible: true }],
        split: [],
      };

      await service.saveTableColumns('user-1', 'backtestMetrics', newValue);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ value: newValue }),
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('sanitize 过滤非法 item', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveTableColumns('user-1', 'aSharesIndexSw', {
        table: [
          { key: 'pe', visible: true },
          { key: '', visible: true },
          { visible: true },
          { key: 'pb' },
          null,
          { key: 'close', visible: false },
        ],
        split: [{ key: 'open', visible: 'maybe' }],
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: {
            table: [
              { key: 'pe', visible: true },
              { key: 'close', visible: false },
            ],
            split: [],
          },
        }),
      );
    });

    it('save 后 getTableColumns 读回一致（round-trip）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);

      let captured!: UserPreferenceEntity;
      repo.save.mockImplementation(async (entity) => {
        captured = entity as UserPreferenceEntity;
        return captured;
      });

      const input = {
        table: [{ key: 'close', visible: false }],
        split: [{ key: 'volume', visible: true }],
      };

      await service.saveTableColumns('user-1', 'aShares', input);

      repo.findOneBy.mockResolvedValueOnce(captured);
      await expect(service.getTableColumns('user-1', 'aShares')).resolves.toEqual(input);
    });
  });
});
