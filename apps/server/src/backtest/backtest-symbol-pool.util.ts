import type { Repository } from 'typeorm';
import type { BacktestRunEntity } from '../entities/backtest-run.entity';
import type { StrategyEntity } from '../entities/strategy.entity';

export async function resolveRunSymbolPool(
  run: BacktestRunEntity,
  strategyRepo: Repository<StrategyEntity>,
): Promise<string[]> {
  let list: unknown = run.symbols;
  let arr: unknown[] = Array.isArray(list) ? list : [];
  if (!arr.length) {
    const strategy = await strategyRepo.findOneBy({ id: run.strategyId });
    list = strategy?.symbols;
    arr = Array.isArray(list) ? list : [];
  }
  const out = new Set<string>();
  for (const s of arr) {
    if (typeof s === 'string' && s.trim()) {
      out.add(s.trim());
    }
  }
  return [...out];
}
