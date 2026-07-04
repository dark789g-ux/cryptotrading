export interface CreateRegimeBacktestDto {
  regimeConfigId: string;
  name: string;
  note?: string;
  capital: {
    initialCapital: number;
    cost: Record<string, number>;
    positionRatio: number;
    maxPositions: number | null;
    sizing?: Record<string, unknown>;
    circuitBreaker?: Record<string, unknown>;
    anchorMode?: boolean;
  };
  dateStart: string;
  dateEnd: string;
}
