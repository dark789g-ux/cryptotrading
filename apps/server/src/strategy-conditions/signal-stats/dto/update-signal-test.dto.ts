/**
 * update-signal-test.dto.ts
 *
 * 更新信号前向统计方案的请求 DTO。
 * 所有字段均可选；service 层对传入的字段做与 create 相同的 fail-fast 校验。
 */
import { StrategyConditionItem } from '../../../entities/strategy/strategy-condition.entity';
import { SignalTestUniverse } from '../../../entities/strategy/signal-test.entity';

export interface UpdateSignalTestDto {
  name?: string;
  buyConditions?: StrategyConditionItem[];
  exitMode?: 'fixed_n' | 'strategy';
  horizonN?: number;
  exitConditions?: StrategyConditionItem[];
  maxHold?: number;
  universe?: SignalTestUniverse;
  dateStart?: string;
  dateEnd?: string;
}
