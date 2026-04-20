/**
 * 初始化内置策略类型（MA+KDJ 趋势策略）
 * 在 AppModule 的 onModuleInit 中调用。
 */

import { DataSource } from 'typeorm';
import { StrategyTypeEntity } from '../entities/strategy/strategy-type.entity';
import { DEFAULT_CONFIG } from '../backtest/engine/models';

export async function seedStrategyTypes(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository(StrategyTypeEntity);

  const existing = await repo.findOneBy({ id: 'ma_kdj' });
  if (existing) return;

  await repo.save(
    repo.create({
      id: 'ma_kdj',
      name: 'MA + KDJ 趋势策略',
      description:
        '均线多头排列（MA30 > MA60 > MA120，close > MA240 > MA60）配合 KDJ 超卖区间入场，' +
        '以近期低点为止损基准，近期高点为阶段止盈触发价，MA5 破线出场。',
      paramSchema: DEFAULT_CONFIG as unknown as object,
    }),
  );
}
