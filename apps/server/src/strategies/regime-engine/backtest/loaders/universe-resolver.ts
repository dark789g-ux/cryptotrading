import { DataSource } from 'typeorm';
import { RegimeUniverse } from '../../../../entities/strategy/regime-strategy-config.entity';
import { SignalTestUniverse } from '../../../../strategy-conditions/strategy-conditions.enumerator';

export function normalizeRegimeUniverse(universe?: RegimeUniverse | null): RegimeUniverse {
  if (!universe || universe.mode === 'all') {
    return { mode: 'all' };
  }
  return universe;
}

export async function resolveSignalTestUniverse(
  dataSource: DataSource,
  universe?: RegimeUniverse | null,
): Promise<SignalTestUniverse> {
  const u = normalizeRegimeUniverse(universe);

  if (u.mode === 'all') {
    return { type: 'all' };
  }

  if (u.mode === 'symbols') {
    const codes = (u.symbols ?? []).filter(
      (s) => typeof s === 'string' && s.trim() !== '',
    );
    return { type: 'list', tsCodes: codes };
  }

  if (u.mode === 'watchlist') {
    const id = u.watchlistId?.trim();
    if (!id) {
      return { type: 'list', tsCodes: [] };
    }
    const rows = await dataSource.query<Array<{ symbol: string }>>(
      `SELECT symbol FROM watchlist_items WHERE watchlist_id = $1`,
      [id],
    );
    return { type: 'list', tsCodes: rows.map((r) => r.symbol) };
  }

  return { type: 'all' };
}
