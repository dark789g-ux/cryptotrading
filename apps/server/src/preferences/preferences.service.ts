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

interface ColumnDefinition {
  key: string;
  defaultVisible: boolean;
  locked?: boolean;
}

const SYMBOLS_VIEW_COLUMN_REGISTRY: Record<keyof SymbolsViewColumnPreferences, ColumnDefinition[]> = {
  crypto: [
    { key: 'symbol', defaultVisible: true, locked: true },
    { key: 'close', defaultVisible: true },
    { key: 'ma5', defaultVisible: true },
    { key: 'ma30', defaultVisible: true },
    { key: 'ma60', defaultVisible: true },
    { key: 'kdjJ', defaultVisible: true },
    { key: 'riskRewardRatio', defaultVisible: true },
    { key: 'stopLossPct', defaultVisible: true },
    { key: 'openTime', defaultVisible: true },
    { key: 'actions', defaultVisible: true, locked: true },
  ],
  aShares: [
    { key: 'tsCode', defaultVisible: true, locked: true },
    { key: 'name', defaultVisible: true },
    { key: 'market', defaultVisible: true },
    { key: 'industry', defaultVisible: true },
    { key: 'close', defaultVisible: true },
    { key: 'pctChg', defaultVisible: true },
    { key: 'amount', defaultVisible: true },
    { key: 'turnoverRate', defaultVisible: true },
    { key: 'pe', defaultVisible: true },
    { key: 'peTtm', defaultVisible: true },
    { key: 'pb', defaultVisible: true },
    { key: 'tradeDate', defaultVisible: true },
    { key: 'actions', defaultVisible: true, locked: true },
  ],
};

export const DEFAULT_SYMBOLS_VIEW_COLUMNS: SymbolsViewColumnPreferences = {
  crypto: SYMBOLS_VIEW_COLUMN_REGISTRY.crypto.map((column) => ({
    key: column.key,
    visible: column.defaultVisible,
  })),
  aShares: SYMBOLS_VIEW_COLUMN_REGISTRY.aShares.map((column) => ({
    key: column.key,
    visible: column.defaultVisible,
  })),
};

export const SYMBOLS_VIEW_PREFERENCES_KEY = 'symbols_view_columns';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeScopeColumns(
  input: unknown,
  registry: readonly ColumnDefinition[],
): ColumnPreferenceItem[] {
  const inputItems = Array.isArray(input) ? input : [];
  const normalized: ColumnPreferenceItem[] = [];
  const seen = new Set<string>();
  const known = new Map(registry.map((item) => [item.key, item]));

  for (const item of inputItems) {
    if (!isRecord(item)) continue;
    const key = typeof item.key === 'string' ? item.key : '';
    if (!key || seen.has(key)) continue;
    const column = known.get(key);
    if (!column) continue;
    const visible = column.locked
      ? true
      : typeof item.visible === 'boolean'
        ? item.visible
        : column.defaultVisible;
    normalized.push({ key, visible });
    seen.add(key);
  }

  for (const column of registry) {
    if (seen.has(column.key)) continue;
    normalized.push({
      key: column.key,
      visible: column.locked ? true : column.defaultVisible,
    });
    seen.add(column.key);
  }

  return normalized;
}

export function normalizeSymbolsView(value: unknown): SymbolsViewColumnPreferences {
  const input = isRecord(value) ? value : {};
  return {
    crypto: normalizeScopeColumns(input.crypto, SYMBOLS_VIEW_COLUMN_REGISTRY.crypto),
    aShares: normalizeScopeColumns(input.aShares, SYMBOLS_VIEW_COLUMN_REGISTRY.aShares),
  };
}

@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(UserPreferenceEntity)
    private readonly repo: Repository<UserPreferenceEntity>,
  ) {}

  async getSymbolsView(userId: string): Promise<SymbolsViewColumnPreferences> {
    const row = await this.repo.findOneBy({ userId, key: SYMBOLS_VIEW_PREFERENCES_KEY });
    return normalizeSymbolsView(row?.value ?? DEFAULT_SYMBOLS_VIEW_COLUMNS);
  }

  async saveSymbolsView(userId: string, value: unknown): Promise<{ ok: true }> {
    const normalized = normalizeSymbolsView(value);
    const existing = await this.repo.findOneBy({ userId, key: SYMBOLS_VIEW_PREFERENCES_KEY });
    if (existing) {
      existing.value = normalized;
      await this.repo.save(existing);
      return { ok: true };
    }

    await this.repo.save(
      this.repo.create({
        id: newId(),
        userId,
        key: SYMBOLS_VIEW_PREFERENCES_KEY,
        value: normalized,
      }),
    );

    return { ok: true };
  }
}
