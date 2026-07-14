import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { newId } from '../auth/shared/auth.utils';
import { UserPreferenceEntity } from '../entities/config/user-preference.entity';

export interface ColumnPreferenceItem {
  key: string;
  visible: boolean;
}

/** 单个 scope 下按视图（表格 / 分栏）分层的列偏好。 */
export interface ScopeViewPreferences {
  table: ColumnPreferenceItem[];
  split: ColumnPreferenceItem[];
}

export const COLUMN_PREFERENCE_KEY_PREFIX = 'columns:';

export const COLUMN_PREFERENCE_TABLE_IDS = [
  'aShares',
  'usStocks',
  'crypto',
  'aSharesIndex',
  'aSharesIndexSw',
  'aSharesIndexCustom',
  'watchlist',
  'backtestMetrics',
] as const;

export type ColumnPreferenceTableId = (typeof COLUMN_PREFERENCE_TABLE_IDS)[number];

export function isValidTableId(x: string): x is ColumnPreferenceTableId {
  return (COLUMN_PREFERENCE_TABLE_IDS as readonly string[]).includes(x);
}

export const EMPTY_SCOPE_VIEW: ScopeViewPreferences = { table: [], split: [] };

/**
 * 只做结构净化，不做业务 fallback。
 * 兼容老格式（扁平数组）→ 当作 table 槽位，split 落空 []（表示未设置，由前端 hydrate 回填）。
 */
export function sanitizeScopeView(input: unknown): ScopeViewPreferences {
  if (Array.isArray(input)) {
    return { table: sanitizeItems(input), split: [] };
  }
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    return {
      table: sanitizeItems(obj.table),
      split: sanitizeItems(obj.split),
    };
  }
  return { table: [], split: [] };
}

export const SYNC_STEPS_KEY_PREFIX = 'sync-steps:';

export const SYNC_STEPS_SCOPES = ['ashare', 'us'] as const;

export type SyncStepsScope = (typeof SYNC_STEPS_SCOPES)[number];

export function isValidSyncScope(x: string): x is SyncStepsScope {
  return (SYNC_STEPS_SCOPES as readonly string[]).includes(x);
}

export function sanitizeSyncSteps(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (item): item is string => typeof item === 'string' && item !== '',
  );
}

// ── K线偏好 ──────────────────────────────────────────────

export interface KlinePrefs {
  order: string[];
  visibility: Record<string, boolean>;
  heightPct: Record<string, number>;
  params?: Record<string, unknown>;
  mainIndicators?: Record<string, boolean>;
}

export const KLINE_PREFS_KEY_PREFIX = 'kline-prefs:';

export const KLINE_PREFS_KEYS = [
  'a-share',
  'crypto',
  'backtest',
  'watchlist',
  'us-stock',
  'us-index',
  'a-shares-index-kline',
  'a-shares-etf-kline',
  'oamv',
  'money-flow-kline',
  'regime-backtest',
] as const;

export type KlinePrefsKey = (typeof KLINE_PREFS_KEYS)[number];

export function isValidKlinePrefsKey(x: string): x is KlinePrefsKey {
  return (KLINE_PREFS_KEYS as readonly string[]).includes(x);
}

export const EMPTY_KLINE_PREFS: KlinePrefs = { order: [], visibility: {}, heightPct: {} };

/**
 * 只做结构净化，不做业务 fallback。
 * 与 sanitizeScopeView / sanitizeSyncSteps 一致风格。
 * 不校验 key 是否在已知白名单（前端 normalizePrefs 负责）。
 */
export function sanitizeKlinePrefs(input: unknown): KlinePrefs {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { order: [], visibility: {}, heightPct: {} };
  }
  const obj = input as Record<string, unknown>;

  // order: 非数组→[], 过滤出 string 且非空项
  const order: string[] = Array.isArray(obj.order)
    ? (obj.order as unknown[]).filter(
        (v): v is string => typeof v === 'string' && v !== '',
      )
    : [];

  // visibility: 非对象→{}, 过滤出 key 为非空 string、value 为 boolean
  const visibilityRaw =
    obj.visibility !== null && typeof obj.visibility === 'object' && !Array.isArray(obj.visibility)
      ? Object.fromEntries(
          Object.entries(obj.visibility as Record<string, unknown>).filter(
            ([k, v]) => typeof k === 'string' && k !== '' && typeof v === 'boolean',
          ),
        )
      : {};
  const visibility: Record<string, boolean> = visibilityRaw as Record<string, boolean>;

  // heightPct: 非对象→{}, 过滤出 key 为非空 string、value 为有限数字且在 4-20 范围内的项
  const heightPctRaw =
    obj.heightPct !== null && typeof obj.heightPct === 'object' && !Array.isArray(obj.heightPct)
      ? Object.fromEntries(
          Object.entries(obj.heightPct as Record<string, unknown>).filter(
            ([k, v]) =>
              typeof k === 'string' &&
              k !== '' &&
              typeof v === 'number' &&
              Number.isFinite(v) &&
              v >= 4 &&
              v <= 20,
          ),
        )
      : {};
  const heightPct: Record<string, number> = heightPctRaw as Record<string, number>;

  // params: 非对象→省略; 否则原样保留（前端做业务归一化）
  const params =
    obj.params !== null && typeof obj.params === 'object' && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : undefined;

  // mainIndicators: 非对象→省略; 否则过滤出 key 为非空 string、value 为 boolean
  const mainIndicatorsRaw =
    obj.mainIndicators !== null && typeof obj.mainIndicators === 'object' && !Array.isArray(obj.mainIndicators)
      ? Object.fromEntries(
          Object.entries(obj.mainIndicators as Record<string, unknown>).filter(
            ([k, v]) => typeof k === 'string' && k !== '' && typeof v === 'boolean',
          ),
        )
      : undefined;
  const mainIndicators = mainIndicatorsRaw !== undefined
    ? (mainIndicatorsRaw as Record<string, boolean>)
    : undefined;

  const result: KlinePrefs = { order, visibility, heightPct };
  if (params !== undefined) result.params = params;
  if (mainIndicators !== undefined) result.mainIndicators = mainIndicators;
  return result;
}

// ── 列偏好 ──────────────────────────────────────────────

/** 只校验基本结构合法性，不校验 key 是否在已知列表中。 */
export function sanitizeItems(input: unknown): ColumnPreferenceItem[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (item): item is ColumnPreferenceItem =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).key === 'string' &&
      (item as Record<string, unknown>).key !== '' &&
      typeof (item as Record<string, unknown>).visible === 'boolean',
  );
}

@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(UserPreferenceEntity)
    private readonly repo: Repository<UserPreferenceEntity>,
  ) {}

  async getTableColumns(
    userId: string,
    tableId: ColumnPreferenceTableId,
  ): Promise<ScopeViewPreferences> {
    const row = await this.repo.findOneBy({
      userId,
      key: COLUMN_PREFERENCE_KEY_PREFIX + tableId,
    });
    if (!row) return EMPTY_SCOPE_VIEW;
    return sanitizeScopeView(row.value);
  }

  async saveTableColumns(
    userId: string,
    tableId: ColumnPreferenceTableId,
    value: unknown,
  ): Promise<{ ok: true }> {
    const sanitized = sanitizeScopeView(value);
    const key = COLUMN_PREFERENCE_KEY_PREFIX + tableId;
    const existing = await this.repo.findOneBy({ userId, key });
    if (existing) {
      existing.value = sanitized;
      await this.repo.save(existing);
      return { ok: true };
    }

    await this.repo.save(
      this.repo.create({
        id: newId(),
        userId,
        key,
        value: sanitized,
      }),
    );

    return { ok: true };
  }

  async getSyncSteps(
    userId: string,
    scope: SyncStepsScope,
  ): Promise<{ steps: string[] }> {
    const row = await this.repo.findOneBy({
      userId,
      key: SYNC_STEPS_KEY_PREFIX + scope,
    });
    if (!row) return { steps: [] };
    const raw = typeof row.value === 'object' && row.value !== null && 'steps' in row.value
      ? (row.value as { steps: unknown }).steps
      : row.value;
    return { steps: sanitizeSyncSteps(raw) };
  }

  async saveSyncSteps(
    userId: string,
    scope: SyncStepsScope,
    steps: unknown,
  ): Promise<{ ok: true }> {
    const sanitized = sanitizeSyncSteps(steps);
    const key = SYNC_STEPS_KEY_PREFIX + scope;
    const existing = await this.repo.findOneBy({ userId, key });
    if (existing) {
      existing.value = { steps: sanitized };
      await this.repo.save(existing);
      return { ok: true };
    }

    await this.repo.save(
      this.repo.create({
        id: newId(),
        userId,
        key,
        value: { steps: sanitized },
      }),
    );

    return { ok: true };
  }

  // ── K线偏好 ────────────────────────────────────────────

  async getKlinePrefs(
    userId: string,
    prefsKey: KlinePrefsKey,
  ): Promise<KlinePrefs> {
    const row = await this.repo.findOneBy({
      userId,
      key: KLINE_PREFS_KEY_PREFIX + prefsKey,
    });
    if (!row) return EMPTY_KLINE_PREFS;
    return sanitizeKlinePrefs(row.value);
  }

  async saveKlinePrefs(
    userId: string,
    prefsKey: KlinePrefsKey,
    value: unknown,
  ): Promise<{ ok: true }> {
    const sanitized = sanitizeKlinePrefs(value);
    const key = KLINE_PREFS_KEY_PREFIX + prefsKey;
    const existing = await this.repo.findOneBy({ userId, key });
    if (existing) {
      existing.value = sanitized;
      await this.repo.save(existing);
      return { ok: true };
    }

    await this.repo.save(
      this.repo.create({
        id: newId(),
        userId,
        key,
        value: sanitized,
      }),
    );

    return { ok: true };
  }
}
