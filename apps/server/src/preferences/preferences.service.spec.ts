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
  SYNC_STEPS_KEY_PREFIX,
  SYNC_STEPS_SCOPES,
  isValidSyncScope,
  sanitizeSyncSteps,
  KLINE_PREFS_KEY_PREFIX,
  KLINE_PREFS_KEYS,
  isValidKlinePrefsKey,
  EMPTY_KLINE_PREFS,
  sanitizeKlinePrefs,
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

  describe('isValidSyncScope', () => {
    it('合法 scope → true', () => {
      for (const s of SYNC_STEPS_SCOPES) {
        expect(isValidSyncScope(s)).toBe(true);
      }
    });

    it('非法 scope → false', () => {
      expect(isValidSyncScope('unknown')).toBe(false);
      expect(isValidSyncScope('')).toBe(false);
      expect(isValidSyncScope('ASHARE')).toBe(false);
    });
  });

  describe('sanitizeSyncSteps', () => {
    it('合法字符串数组原样保留', () => {
      expect(sanitizeSyncSteps(['step-a', 'step-b'])).toEqual(['step-a', 'step-b']);
    });

    it('过滤非字符串和空串', () => {
      expect(sanitizeSyncSteps(['a', 123, null, '', undefined, 'b'])).toEqual(['a', 'b']);
    });

    it('非数组输入 → 空数组', () => {
      expect(sanitizeSyncSteps(null)).toEqual([]);
      expect(sanitizeSyncSteps('string')).toEqual([]);
      expect(sanitizeSyncSteps(42)).toEqual([]);
      expect(sanitizeSyncSteps({ steps: ['a'] })).toEqual([]);
    });
  });

  describe('getSyncSteps', () => {
    it('无记录 → { steps: [] }', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await expect(service.getSyncSteps('user-1', 'ashare')).resolves.toEqual({ steps: [] });
      expect(repo.findOneBy).toHaveBeenCalledWith({
        userId: 'user-1',
        key: SYNC_STEPS_KEY_PREFIX + 'ashare',
      });
    });

    it('有记录 → 返回存储的步骤', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYNC_STEPS_KEY_PREFIX + 'us',
        value: { steps: ['step-x', 'step-y'] },
      } as UserPreferenceEntity);

      await expect(service.getSyncSteps('user-1', 'us')).resolves.toEqual({
        steps: ['step-x', 'step-y'],
      });
    });

    it('脏数据（非数组）→ sanitize 后 { steps: [] }', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYNC_STEPS_KEY_PREFIX + 'ashare',
        value: 'not-an-array',
      } as UserPreferenceEntity);

      await expect(service.getSyncSteps('user-1', 'ashare')).resolves.toEqual({ steps: [] });
    });

    it('脏数据（含非字符串、空串）→ sanitize 后干净', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: SYNC_STEPS_KEY_PREFIX + 'ashare',
        value: ['step-a', 123, '', null, 'step-b'],
      } as UserPreferenceEntity);

      await expect(service.getSyncSteps('user-1', 'ashare')).resolves.toEqual({
        steps: ['step-a', 'step-b'],
      });
    });
  });

  describe('saveSyncSteps', () => {
    it('首次写入 → INSERT，用 newId', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveSyncSteps('user-1', 'ashare', ['step-a', 'step-b']);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          key: SYNC_STEPS_KEY_PREFIX + 'ashare',
          value: { steps: ['step-a', 'step-b'] },
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('已存在记录 → UPDATE 同一行', async () => {
      const existing = {
        id: 'pref-1',
        userId: 'user-1',
        key: SYNC_STEPS_KEY_PREFIX + 'us',
        value: { steps: ['old-step'] },
      } as UserPreferenceEntity;
      repo.findOneBy.mockResolvedValueOnce(existing);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveSyncSteps('user-1', 'us', ['new-step']);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ value: { steps: ['new-step'] } }),
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('sanitize 入参（过滤非字符串/空串）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveSyncSteps('user-1', 'ashare', ['step-a', 42, '', null, 'step-b']);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: { steps: ['step-a', 'step-b'] },
        }),
      );
    });

    it('save 后 getSyncSteps 读回一致（round-trip）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);

      let captured!: UserPreferenceEntity;
      repo.save.mockImplementation(async (entity) => {
        captured = entity as UserPreferenceEntity;
        return captured;
      });

      const steps = ['step-a', 'step-b'];
      await service.saveSyncSteps('user-1', 'us', steps);

      repo.findOneBy.mockResolvedValueOnce(captured);
      await expect(service.getSyncSteps('user-1', 'us')).resolves.toEqual({ steps });
    });
  });

  // ── K线偏好 ──────────────────────────────────────────────

  describe('isValidKlinePrefsKey', () => {
    it('合法 key → true', () => {
      for (const k of KLINE_PREFS_KEYS) {
        expect(isValidKlinePrefsKey(k)).toBe(true);
      }
    });

    it('非法 key → false', () => {
      expect(isValidKlinePrefsKey('unknown')).toBe(false);
      expect(isValidKlinePrefsKey('')).toBe(false);
      expect(isValidKlinePrefsKey('A-SHARE')).toBe(false);
    });
  });

  describe('sanitizeKlinePrefs', () => {
    it('非法输入（null / 数组 / 字符串）→ 空结构', () => {
      expect(sanitizeKlinePrefs(null)).toEqual(EMPTY_KLINE_PREFS);
      expect(sanitizeKlinePrefs(['VOL', 'MACD'])).toEqual(EMPTY_KLINE_PREFS);
      expect(sanitizeKlinePrefs('string')).toEqual(EMPTY_KLINE_PREFS);
      expect(sanitizeKlinePrefs(42)).toEqual(EMPTY_KLINE_PREFS);
    });

    it('合法结构原样保留', () => {
      const input: any = {
        order: ['VOL', 'KDJ', 'MACD'],
        visibility: { VOL: true, KDJ: false },
        heightPct: { VOL: 10, KDJ: 15 },
        params: { KDJ: { n: 9, m1: 3, m2: 3 } },
        mainIndicators: { MA5: true, MA30: false },
      };
      expect(sanitizeKlinePrefs(input)).toEqual({
        order: ['VOL', 'KDJ', 'MACD'],
        visibility: { VOL: true, KDJ: false },
        heightPct: { VOL: 10, KDJ: 15 },
        params: { KDJ: { n: 9, m1: 3, m2: 3 } },
        mainIndicators: { MA5: true, MA30: false },
      });
    });

    it('heightPct 越界值（3, 21, NaN, "8"）被过滤', () => {
      const input: any = {
        order: [],
        visibility: {},
        heightPct: { VOL: 10, LOW: 3, HIGH: 21, NAN: NaN, STR: '8' },
      };
      expect(sanitizeKlinePrefs(input).heightPct).toEqual({ VOL: 10 });
    });

    it('order 非字符串项被过滤', () => {
      const input: any = {
        order: ['VOL', 123, null, '', 'MACD', undefined],
        visibility: {},
        heightPct: {},
      };
      expect(sanitizeKlinePrefs(input).order).toEqual(['VOL', 'MACD']);
    });

    it('visibility 非 boolean 值被过滤', () => {
      const input: any = {
        order: [],
        visibility: { VOL: true, KDJ: 'yes', MACD: 1, BRICK: null },
        heightPct: {},
      };
      expect(sanitizeKlinePrefs(input).visibility).toEqual({ VOL: true });
    });

    it('params 非对象被省略，对象原样保留', () => {
      expect(sanitizeKlinePrefs({ params: 'bad' }).params).toBeUndefined();
      expect(sanitizeKlinePrefs({ params: [1, 2] }).params).toBeUndefined();
      expect(sanitizeKlinePrefs({ params: null }).params).toBeUndefined();

      const obj: any = { KDJ: { n: 9 } };
      expect(sanitizeKlinePrefs({ params: obj }).params).toEqual({ KDJ: { n: 9 } });
    });

    it('mainIndicators 非对象被省略，合法对象保留', () => {
      expect(sanitizeKlinePrefs({ mainIndicators: 'bad' }).mainIndicators).toBeUndefined();
      expect(sanitizeKlinePrefs({ mainIndicators: null }).mainIndicators).toBeUndefined();

      const input: any = { mainIndicators: { MA5: true, MA30: false } };
      expect(sanitizeKlinePrefs(input).mainIndicators).toEqual({ MA5: true, MA30: false });
    });

    it('mainIndicators 中非 boolean 值被过滤', () => {
      const input: any = { mainIndicators: { MA5: true, MA30: 'yes', VWAP5: 1 } };
      expect(sanitizeKlinePrefs(input).mainIndicators).toEqual({ MA5: true });
    });

    it('空对象 → 空结构', () => {
      expect(sanitizeKlinePrefs({})).toEqual(EMPTY_KLINE_PREFS);
    });
  });

  describe('getKlinePrefs', () => {
    it('无记录 → EMPTY_KLINE_PREFS', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);

      await expect(service.getKlinePrefs('user-1', 'crypto')).resolves.toEqual(EMPTY_KLINE_PREFS);
      expect(repo.findOneBy).toHaveBeenCalledWith({
        userId: 'user-1',
        key: KLINE_PREFS_KEY_PREFIX + 'crypto',
      });
    });

    it('有记录 → sanitize 后返回', async () => {
      const stored = {
        order: ['VOL', 'MACD'],
        visibility: { VOL: true },
        heightPct: { VOL: 10 },
        mainIndicators: { MA5: true },
      };
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: KLINE_PREFS_KEY_PREFIX + 'crypto',
        value: stored,
      } as UserPreferenceEntity);

      await expect(service.getKlinePrefs('user-1', 'crypto')).resolves.toEqual(stored);
    });

    it('脏数据 → sanitize 后返回干净结构', async () => {
      repo.findOneBy.mockResolvedValueOnce({
        id: 'pref-1',
        userId: 'user-1',
        key: KLINE_PREFS_KEY_PREFIX + 'crypto',
        value: 'corrupted',
      } as UserPreferenceEntity);

      await expect(service.getKlinePrefs('user-1', 'crypto')).resolves.toEqual(EMPTY_KLINE_PREFS);
    });
  });

  describe('saveKlinePrefs', () => {
    it('首次存储 → INSERT，用 newId', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const input = {
        order: ['VOL', 'MACD'],
        visibility: { VOL: true },
        heightPct: { VOL: 10 },
      };

      await service.saveKlinePrefs('user-1', 'crypto', input);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          key: KLINE_PREFS_KEY_PREFIX + 'crypto',
          value: input,
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('重复存储 → UPDATE 同一行', async () => {
      const existing = {
        id: 'pref-1',
        userId: 'user-1',
        key: KLINE_PREFS_KEY_PREFIX + 'crypto',
        value: { order: [], visibility: {}, heightPct: {} },
      } as UserPreferenceEntity;
      repo.findOneBy.mockResolvedValueOnce(existing);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      const newValue = {
        order: ['KDJ'],
        visibility: { KDJ: true },
        heightPct: { KDJ: 15 },
      };

      await service.saveKlinePrefs('user-1', 'crypto', newValue);

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ value: newValue }),
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('sanitize 入参（过滤非法字段）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);
      repo.save.mockImplementation(async (entity) => entity as UserPreferenceEntity);

      await service.saveKlinePrefs('user-1', 'crypto', {
        order: ['VOL', 123, null, 'MACD'],
        visibility: { VOL: true, BAD: 'yes' },
        heightPct: { VOL: 10, LOW: 3, HIGH: 21 },
        params: 'invalid',
        mainIndicators: { MA5: true, BAD: 1 },
      } as any);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          value: {
            order: ['VOL', 'MACD'],
            visibility: { VOL: true },
            heightPct: { VOL: 10 },
            mainIndicators: { MA5: true },
          },
        }),
      );
    });

    it('save 后 getKlinePrefs 读回一致（round-trip）', async () => {
      repo.findOneBy.mockResolvedValueOnce(null);
      repo.create.mockImplementation((entity) => entity as UserPreferenceEntity);

      let captured!: UserPreferenceEntity;
      repo.save.mockImplementation(async (entity) => {
        captured = entity as UserPreferenceEntity;
        return captured;
      });

      const input = {
        order: ['VOL', 'MACD'],
        visibility: { VOL: true, MACD: false },
        heightPct: { VOL: 10, MACD: 12 },
        params: { KDJ: { n: 9 } },
        mainIndicators: { MA5: true },
      };
      await service.saveKlinePrefs('user-1', 'a-share', input);

      repo.findOneBy.mockResolvedValueOnce(captured);
      await expect(service.getKlinePrefs('user-1', 'a-share')).resolves.toEqual(input);
    });
  });
});
