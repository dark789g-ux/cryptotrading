import type { SelectOption } from 'naive-ui';
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions';

/**
 * 策略条件字段元数据。
 *
 * StrategyConditionItem.value 始终是 DB/Tushare 原始量纲；后端 ASHARE_FIELD_COL_MAP 直接 SQL 比较，
 * 不可在前端 payload 里改成「亿」。UI 展示/输入用「亿」仅为编辑体验，valueToStorageFactor 负责换算。
 *
 * @see apps/server/src/strategy-conditions/strategy-conditions.types.ts ASHARE_FIELD_COL_MAP
 * @see apps/web/src/components/symbols/a-shares/aSharesFormatters.ts formatMarketCap / formatAmount
 *
 * Factor 依据（勿与 formatAmount 混用）：
 * - total_mv / circ_mv：daily_basic 万元 → UI 亿，×10000（例 circ_mv lte 207641 ≈ UI 20.7641 亿）
 * - amount：daily_quote 千元 → UI 亿，×100000（100000 千元 = 1 亿）
 */
export type FieldOption = Omit<SelectOption, 'label' | 'value'> & {
  label: string;
  value: string;
  /** 是否支持上穿/下穿（仅单表指标字段可用） */
  supportsCross?: boolean;
  /** UI 展示单位（下拉 label 后缀） */
  valueUnit?: string;
  /** 用户输入（UI）→ StrategyConditionItem.value（DB 原始量纲）的乘数；无则透传 */
  valueToStorageFactor?: number;
  /** 是否为 KDJ 字段（kdj_j/kdj_k/kdj_d）；A 股可行内配置 N/M1/M2 参数 */
  isKdj?: boolean;
};

export function formatFieldSelectLabel(f: FieldOption): string {
  return f.valueUnit ? `${f.label}（${f.valueUnit}）` : f.label;
}

export const A_SHARE_FIELDS: FieldOption[] = [
  { label: 'KDJ_J', value: 'kdj_j', supportsCross: true, isKdj: true },
  { label: 'KDJ_K', value: 'kdj_k', supportsCross: true, isKdj: true },
  { label: 'KDJ_D', value: 'kdj_d', supportsCross: true, isKdj: true },
  { label: 'MACD_DIF', value: 'macd_dif', supportsCross: true },
  { label: 'MACD_DEA', value: 'macd_dea', supportsCross: true },
  { label: 'MACD_HIST', value: 'macd_hist', supportsCross: true },
  { label: 'BBI', value: 'bbi', supportsCross: true },
  { label: 'MA5', value: 'ma5', supportsCross: true },
  { label: 'MA30', value: 'ma30', supportsCross: true },
  { label: 'MA60', value: 'ma60', supportsCross: true },
  { label: 'MA120', value: 'ma120', supportsCross: true },
  { label: 'MA240', value: 'ma240', supportsCross: true },
  { label: 'ATR14', value: 'atr14', supportsCross: true },
  { label: '动量10日', value: 'roc10', supportsCross: true, valueUnit: '%' },
  { label: '动量20日', value: 'roc20', supportsCross: true, valueUnit: '%' },
  { label: '动量60日', value: 'roc60', supportsCross: true, valueUnit: '%' },
  { label: '盈亏比', value: 'profit_loss_ratio', supportsCross: true },
  { label: '砖形图', value: 'brick', supportsCross: true },
  { label: '砖形图变动', value: 'brick_delta', supportsCross: true },
  { label: '砖形图信号', value: 'brick_xg' },
  { label: '换手率', value: 'turnover_rate', valueUnit: '%' },
  { label: '量比', value: 'volume_ratio', valueUnit: '倍' },
  { label: 'PE', value: 'pe' },
  { label: 'PE_TTM', value: 'pe_ttm' },
  { label: 'PB', value: 'pb' },
  { label: '总市值', value: 'total_mv', valueUnit: '亿', valueToStorageFactor: 10_000 },
  { label: '流通市值', value: 'circ_mv', valueUnit: '亿', valueToStorageFactor: 10_000 },
  { label: '上市时长(天)', value: 'list_days' },
  { label: '收盘价', value: 'close' },
  { label: '开盘价', value: 'open' },
  { label: '最高价', value: 'high' },
  { label: '最低价', value: 'low' },
  { label: '成交量', value: 'volume', valueUnit: '手' },
  { label: '成交额', value: 'amount', valueUnit: '亿', valueToStorageFactor: 100_000 },
  { label: '涨跌幅', value: 'pct_chg', valueUnit: '%' },
  { label: 'AMV-MACD-DIF', value: 'amv_dif', supportsCross: false },
  { label: 'AMV-MACD-DEA', value: 'amv_dea', supportsCross: false },
  { label: 'AMV-MACD-MACD', value: 'amv_macd', supportsCross: false },
  { label: '行业AMV-MACD-DIF', value: 'ind_amv_dif', supportsCross: false },
  { label: '行业AMV-MACD-DEA', value: 'ind_amv_dea', supportsCross: false },
  { label: '行业AMV-MACD-MACD', value: 'ind_amv_macd', supportsCross: false },
  { label: '大盘0AMV-MACD-DIF', value: 'oamv_dif', supportsCross: false },
  { label: '大盘0AMV-MACD-DEA', value: 'oamv_dea', supportsCross: false },
  { label: '大盘0AMV-MACD-MACD', value: 'oamv_macd', supportsCross: false },
  { label: '大盘0AMV-收盘', value: 'oamv_close', supportsCross: false },
  { label: '大盘0AMV-MA240', value: 'oamv_ma240', supportsCross: false },
  { label: '120日区间位置', value: 'pos_120', supportsCross: false, valueUnit: '0~1' },
  { label: '60日区间位置', value: 'pos_60', supportsCross: false, valueUnit: '0~1' },
  { label: '收盘/MA60', value: 'close_ma60_ratio', supportsCross: false, valueUnit: '倍' },
  { label: '量比(60日均量)', value: 'vol_ratio_60', supportsCross: false, valueUnit: '倍' },
  { label: '量比(120日均量)', value: 'vol_ratio_120', supportsCross: false, valueUnit: '倍' },
];

export const CRYPTO_FIELDS: FieldOption[] = [
  { label: 'KDJ_J', value: 'kdj_j', supportsCross: true, isKdj: true },
  { label: 'KDJ_K', value: 'kdj_k', supportsCross: true, isKdj: true },
  { label: 'KDJ_D', value: 'kdj_d', supportsCross: true, isKdj: true },
  { label: 'MACD_DIF', value: 'macd_dif', supportsCross: true },
  { label: 'MACD_DEA', value: 'macd_dea', supportsCross: true },
  { label: 'MACD_HIST', value: 'macd_hist', supportsCross: true },
  { label: 'BBI', value: 'bbi', supportsCross: true },
  { label: 'MA5', value: 'ma5', supportsCross: true },
  { label: 'MA30', value: 'ma30', supportsCross: true },
  { label: 'MA60', value: 'ma60', supportsCross: true },
  { label: 'MA120', value: 'ma120', supportsCross: true },
  { label: 'MA240', value: 'ma240', supportsCross: true },
  { label: 'ATR14', value: 'atr14', supportsCross: true },
  { label: '动量10日', value: 'roc10', supportsCross: true, valueUnit: '%' },
  { label: '动量20日', value: 'roc20', supportsCross: true, valueUnit: '%' },
  { label: '动量60日', value: 'roc60', supportsCross: true, valueUnit: '%' },
  { label: '盈亏比', value: 'profit_loss_ratio', supportsCross: true },
  { label: '收盘价', value: 'close', supportsCross: true },
  { label: '开盘价', value: 'open', supportsCross: true },
  { label: '最高价', value: 'high', supportsCross: true },
  { label: '最低价', value: 'low', supportsCross: true },
  { label: '成交量', value: 'volume', supportsCross: true, valueUnit: '个' },
  { label: '成交额', value: 'amount', supportsCross: true, valueUnit: 'USDT' },
];

export const BASE_OPERATOR_OPTIONS = [
  { label: '大于', value: 'gt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于', value: 'lt' },
  { label: '小于等于', value: 'lte' },
  { label: '等于', value: 'eq' },
  { label: '不等于', value: 'neq' },
  { label: '上穿', value: 'cross_above' },
  { label: '下穿', value: 'cross_below' },
];

export function getFieldDef(
  field: string,
  targetType: 'a-share' | 'crypto',
): FieldOption | undefined {
  const fields = targetType === 'a-share' ? A_SHARE_FIELDS : CRYPTO_FIELDS;
  return fields.find((f) => f.value === field);
}

/** KDJ 字段集合（kdj_j/kdj_k/kdj_d），按 key 判定，与 FieldOption.isKdj 等价 */
export const KDJ_FIELD_VALUES = new Set(['kdj_j', 'kdj_k', 'kdj_d']);

/** KDJ 默认参数 N/M1/M2；缺省视为 9/3/3，等于默认时不持久化 kdjParams */
export const DEFAULT_KDJ_PARAMS = { n: 9, m1: 3, m2: 3 } as const;

/** 是否为 KDJ 字段（供行内参数框 / 比较约束复用，避免散落魔法字符串） */
export function isKdjField(field: string): boolean {
  return KDJ_FIELD_VALUES.has(field);
}

export function getFieldLabel(field: string, targetType: 'a-share' | 'crypto'): string {
  return getFieldDef(field, targetType)?.label ?? field;
}

export function getFieldValueToStorageFactor(
  field: string,
  targetType: 'a-share' | 'crypto',
): number | undefined {
  return getFieldDef(field, targetType)?.valueToStorageFactor;
}

/** DB 原始量纲 → UI 展示值；无 valueToStorageFactor 时透传 */
export function fieldValueToDisplay(
  field: string,
  targetType: 'a-share' | 'crypto',
  storage?: number,
): number | undefined {
  if (storage == null) return undefined;
  const factor = getFieldValueToStorageFactor(field, targetType);
  if (factor == null) return storage;
  return storage / factor;
}

/** UI 展示值 → DB 原始量纲；无 valueToStorageFactor 时透传 */
export function fieldValueToStorage(
  field: string,
  targetType: 'a-share' | 'crypto',
  display?: number | null,
): number | undefined {
  if (display == null) return undefined;
  const factor = getFieldValueToStorageFactor(field, targetType);
  if (factor == null) return display;
  return display * factor;
}

export function formatConditionDisplayValue(
  field: string,
  targetType: 'a-share' | 'crypto',
  storage?: number,
): string {
  if (storage == null) return '';
  const display = fieldValueToDisplay(field, targetType, storage);
  if (display == null) return String(storage);
  const rounded = Number(display.toPrecision(10));
  return String(rounded);
}

export function getOperatorLabel(operator: string): string {
  return BASE_OPERATOR_OPTIONS.find((o) => o.value === operator)?.label ?? operator;
}

export function formatConditionItem(
  c: StrategyConditionItem,
  targetType: 'a-share' | 'crypto',
): string {
  const fieldLabel = getFieldLabel(c.field, targetType);
  const opLabel = getOperatorLabel(c.operator);

  if (c.operator === 'cross_above' || c.operator === 'cross_below') {
    return `${fieldLabel} ${opLabel}`;
  }

  if (c.compareMode === 'field' && c.compareField) {
    const compareLabel = getFieldLabel(c.compareField, targetType);
    return `${fieldLabel} ${opLabel} ${compareLabel}`;
  }

  const value = formatConditionDisplayValue(c.field, targetType, c.value);
  return `${fieldLabel} ${opLabel} ${value}`;
}
