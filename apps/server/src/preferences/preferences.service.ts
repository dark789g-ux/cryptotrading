import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { newId } from '../auth/auth.utils';
import { UserPreferenceEntity } from '../entities/user-preference.entity';

export interface ColumnPreferenceItem {
  key: string;
  visible: boolean;
}

export interface SymbolsViewColumnPreferences {
  crypto: ColumnPreferenceItem[];
  aShares: ColumnPreferenceItem[];
}

export const SYMBOLS_VIEW_PREFERENCES_KEY = 'symbols_view_columns';

/** 只校验基本结构合法性，不校验 key 是否在已知列表中。 */
function sanitizeScopeColumns(input: unknown): ColumnPreferenceItem[] {
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
    crypto: sanitizeScopeColumns(input.crypto),
    aShares: sanitizeScopeColumns(input.aShares),
  };
}

const EMPTY_SYMBOLS_VIEW_PREFERENCES: SymbolsViewColumnPreferences = {
  crypto: [],
  aShares: [],
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
