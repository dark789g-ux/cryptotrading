export const COLUMN_GROUPS = [
  { key: 'basic', label: '基础' },
  { key: 'quote', label: '行情' },
  { key: 'valuation', label: '估值' },
  { key: 'ma', label: '均线' },
  { key: 'momentum', label: '动量' },
  { key: 'kdjMacd', label: 'KDJ / MACD' },
  { key: 'risk', label: '风控 / 波动' },
  { key: 'amv', label: '活跃市值' },
  { key: 'moneyFlow', label: '资金流' },
  { key: 'brick', label: '砖块图' },
  { key: 'signal', label: '策略 / 信号' },
  { key: 'fixed', label: '固定' },
  { key: 'meta', label: '其它' },
] as const

export type ColumnGroupKey = (typeof COLUMN_GROUPS)[number]['key']

export const COLUMN_KEY_GROUP: Record<string, ColumnGroupKey> = {
  // 基础
  symbol: 'basic',
  tsCode: 'basic',
  ticker: 'basic',
  name: 'basic',
  market: 'basic',
  swIndustryL1Code: 'basic',
  swIndustryL2Code: 'basic',
  swIndustryL3Code: 'basic',

  // 行情
  close: 'quote',
  pctChg: 'quote',
  amount: 'quote',
  volume: 'quote',
  turnoverRate: 'quote',
  tradeDate: 'quote',
  openTime: 'quote',
  quoteVolume10: 'quote',

  // 估值
  pe: 'valuation',
  peTtm: 'valuation',
  pb: 'valuation',
  circMv: 'valuation',
  totalMv: 'valuation',

  // 均线
  ma5: 'ma',
  ma30: 'ma',
  ma60: 'ma',
  ma120: 'ma',
  ma240: 'ma',
  bbi: 'ma',

  // 动量
  roc10: 'momentum',
  roc20: 'momentum',
  roc60: 'momentum',

  // KDJ / MACD
  kdjJ: 'kdjMacd',
  kdjK: 'kdjMacd',
  kdjD: 'kdjMacd',
  dif: 'kdjMacd',
  dea: 'kdjMacd',
  macd: 'kdjMacd',

  // 风控 / 波动
  riskRewardRatio: 'risk',
  stopLossPct: 'risk',
  atr14: 'risk',
  lossAtr14: 'risk',
  low9: 'risk',
  high9: 'risk',

  // 活跃市值
  amvDif: 'amv',
  amvDea: 'amv',
  amvMacd: 'amv',

  // 资金流
  netInflow: 'moneyFlow',
  netInflow5d: 'moneyFlow',
  netInflow10d: 'moneyFlow',
  netInflow20d: 'moneyFlow',

  // 砖块图
  brick: 'brick',
  brickDelta: 'brick',
  brickXg: 'brick',

  // 策略 / 信号
  modelScore: 'signal',
  buySignal: 'signal',
  tags: 'signal',

  // 固定
  actions: 'fixed',
}

export const DEFAULT_EXPANDED_GROUPS: ColumnGroupKey[] = ['basic', 'quote']

export function resolveColumnGroup(key: string): ColumnGroupKey {
  return COLUMN_KEY_GROUP[key] ?? 'meta'
}

export function getColumnGroupLabel(groupKey: ColumnGroupKey): string {
  return COLUMN_GROUPS.find((group) => group.key === groupKey)?.label ?? groupKey
}
