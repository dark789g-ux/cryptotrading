import { RegimeConfigMap } from '../../../../entities/strategy/regime-strategy-config.entity';

export interface CreateRegimeBacktestDto {
  name: string;
  note?: string;
  /** 必填：内联 Regime 规则快照，不再从 regimeConfigId 加载 */
  config: RegimeConfigMap;
  /** 可选，仅溯源；不用于加载规则 */
  regimeConfigId?: string;
  capital: {
    initialCapital: number;
    cost: Record<string, number>;
    /** @deprecated 若传入则忽略并 warn */
    positionRatio?: number;
    /** @deprecated 若传入则忽略并 warn */
    maxPositions?: number | null;
    sizing?: Record<string, unknown>;
    kelly?: Record<string, unknown>;
    circuitBreaker?: Record<string, unknown>;
    anchorMode?: boolean;
    requireAllPositionsProfitable?: boolean;
  };
  dateStart: string;
  dateEnd: string;
}
