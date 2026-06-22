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

export interface SymbolsViewColumnPreferences {
  crypto: ScopeViewPreferences;
  aShares: ScopeViewPreferences;
  usStocks: ScopeViewPreferences;
  aSharesIndex: ScopeViewPreferences;
}

export const SYMBOLS_VIEW_PREFERENCES_KEY = 'symbols_view_columns';

/**
 * 只做结构净化，不做业务 fallback。
 * 兼容老格式（扁平数组）→ 当作 table 槽位，split 落空 []（表示未设置，由前端 hydrate 回填）。
 */
function sanitizeScopeView(input: unknown): ScopeViewPreferences {
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
function sanitizeItems(input: unknown): ColumnPreferenceItem[] {
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

function sanitizeSymbolsView(value: unknown): SymbolsViewColumnPreferences {
  const input =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    crypto: sanitizeScopeView(input.crypto),
    aShares: sanitizeScopeView(input.aShares),
    usStocks: sanitizeScopeView(input.usStocks),
    aSharesIndex: sanitizeScopeView(input.aSharesIndex),
  };
}

const EMPTY_SYMBOLS_VIEW_PREFERENCES: SymbolsViewColumnPreferences = {
  crypto: { table: [], split: [] },
  aShares: { table: [], split: [] },
  usStocks: { table: [], split: [] },
  aSharesIndex: { table: [], split: [] },
};

@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(UserPreferenceEntity)
    private readonly repo: Repository<UserPreferenceEntity>,
  ) {}

  async getSymbolsView(userId: string): Promise<SymbolsViewColumnPreferences> {
    const row = await this.repo.findOneBy({ userId, key: SYMBOLS_VIEW_PREFERENCES_KEY });
    if (!row) return EMPTY_SYMBOLS_VIEW_PREFERENCES;
    return sanitizeSymbolsView(row.value);
  }

  async saveSymbolsView(userId: string, value: unknown): Promise<{ ok: true }> {
    const sanitized = sanitizeSymbolsView(value);
    const existing = await this.repo.findOneBy({ userId, key: SYMBOLS_VIEW_PREFERENCES_KEY });
    if (existing) {
      existing.value = sanitized;
      await this.repo.save(existing);
      return { ok: true };
    }

    await this.repo.save(
      this.repo.create({
        id: newId(),
        userId,
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: sanitized,
      }),
    );

    return { ok: true };
  }
}
