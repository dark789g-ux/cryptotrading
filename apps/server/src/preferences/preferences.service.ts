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
}
