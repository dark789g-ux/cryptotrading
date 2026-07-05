import type { QuadrantEntry, RegimeConfigMap } from '../../entities/strategy/regime-strategy-config.entity';

/**
 * 0AMV 四象限默认预设（与研究结论一致）。
 *
 * 分桶规则：DIF >0 / ≤0 × MACD >0 / ≤0，边界一律归负侧。
 * Q1/Q3 为 trade，Q2/Q4 为 flat。
 *
 * entryConditions / exitMode / exitParams 仅作占位示例，实际策略需按研究结论填写。
 */
export const DEFAULT_0AMV_QUADRANTS: QuadrantEntry[] = [
  {
    key: 'Q1',
    label: '强多头',
    action: 'trade',
    match: [
      { field: 'oamv_dif', operator: 'gt', value: 0 },
      { field: 'oamv_macd', operator: 'gt', value: 0 },
    ],
    entryConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
    exitMode: 'fixed_n',
    exitParams: { N: 5 },
  },
  {
    key: 'Q2',
    label: '多头回调',
    action: 'flat',
    match: [
      { field: 'oamv_dif', operator: 'gt', value: 0 },
      { field: 'oamv_macd', operator: 'lte', value: 0 },
    ],
  },
  {
    key: 'Q3',
    label: '反弹筑底',
    action: 'trade',
    match: [
      { field: 'oamv_dif', operator: 'lte', value: 0 },
      { field: 'oamv_macd', operator: 'gt', value: 0 },
    ],
    entryConditions: [{ field: 'kdj_j', operator: 'lt', value: 0 }],
    exitMode: 'fixed_n',
    exitParams: { N: 5 },
  },
  {
    key: 'Q4',
    label: '空头',
    action: 'flat',
    match: [
      { field: 'oamv_dif', operator: 'lte', value: 0 },
      { field: 'oamv_macd', operator: 'lte', value: 0 },
    ],
  },
];

export const DEFAULT_0AMV_MARKET_INDEX = '000001.SH';

export function get0amvQuadrantPreset(): RegimeConfigMap {
  return {
    marketIndex: DEFAULT_0AMV_MARKET_INDEX,
    quadrants: DEFAULT_0AMV_QUADRANTS,
  };
}
