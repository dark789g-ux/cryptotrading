import { precomputeBrickChart } from '../backtest/engine/bt-indicators';

export interface BrickChartSourceBar {
  high: number;
  low: number;
  close: number;
}

export interface BrickChartPoint {
  brick: number;
  delta: number;
  xg: boolean;
}

export function calcBrickChartPoints(
  rows: BrickChartSourceBar[],
  deltaMin = 0,
): BrickChartPoint[] {
  const bars = precomputeBrickChart(
    rows.map((row, index) => ({
      open_time: String(index),
      open: row.close,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: 0,
      DIF: 0,
      DEA: 0,
      MACD: 0,
      'KDJ.K': 0,
      'KDJ.D': 0,
      'KDJ.J': 0,
      MA5: 0,
      MA30: 0,
      MA60: 0,
      MA120: 0,
      MA240: 0,
    })),
  );

  return bars.map((bar, index) => {
    const aa = index >= 1 && bar.brick > bars[index - 1].brick;
    const aaPrev = index >= 2 && bars[index - 1].brick > bars[index - 2].brick;
    const deltaPassed = deltaMin <= 0 || bar.delta >= deltaMin;
    return {
      brick: bar.brick,
      delta: bar.delta,
      xg: index >= 2 && !aaPrev && aa && deltaPassed,
    };
  });
}
