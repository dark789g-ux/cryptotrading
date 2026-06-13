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
  exitMode?: 'fixed_n' | 'strategy' | 'trailing_lock' | 'phase_lock';
  horizonN?: number;
  exitConditions?: StrategyConditionItem[];
  maxHold?: number;
  // 波段跟踪止损专属参数（仅 trailing_lock）；语义见 create-signal-test.dto.ts。
  stopRatio?: number;
  floorRatio?: number;
  floorEnabled?: boolean;
  ma5RequireDown?: boolean;
  // 阶段锁定专属参数（仅 phase_lock）；语义见 create-signal-test.dto.ts。
  initFactor?: number;
  lockFactor?: number;
  lookback?: number;
  universe?: SignalTestUniverse;
  dateStart?: string;
  dateEnd?: string;
}
