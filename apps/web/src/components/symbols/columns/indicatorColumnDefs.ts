import { h } from 'vue'
import { NTag } from 'naive-ui'
import { colors } from '../../../styles/tokens'
import type { SymbolColumnDef } from './columnTypes'

/**
 * 指标列「定义」的单一事实源（descriptor 驱动 + 泛型 builder）。
 *
 * A股 / 自选股 / 回测表三处此前各自重复声明同一批指标列（MA/KDJ/MACD/风控…），
 * 这里抽成一份 descriptor + 一个 builder，消除重复、保证零行为漂移。
 *
 * 渲染契约与 watchlistColumnDefs.ts 的 formatFixed（:32-36）/ stopLossPct（:262）逐 bit 等价：
 *   - number：v == null || !isFinite(Number(v)) → '-'；否则 Number(v).toFixed(decimals) + (suffix ?? '')
 *   - signal（布尔，brickXg）：v == null → '-'；否则 tag(v ? '真' : '假')
 *
 * 分组不进 descriptor —— 由 columnGroupMeta.COLUMN_KEY_GROUP 按 key 统一解析（单一事实源）。
 */
export interface IndicatorDescriptor {
  /** canonical key，必须与 AShareRow 字段 / SELECT 别名 / watchlist 列 key 一致 */
  key: string
  /** 列头与选择器显示名 */
  title: string
  /** 默认 'number'；'signal' 为布尔（brickXg），渲染 tag(真/假) */
  kind?: 'number' | 'signal'
  /** 小数位（kind='signal' 时忽略） */
  decimals: number
  /** 后缀，如 '%'（stopLossPct） */
  suffix?: string
  /** 渲染前缩放因子（如 obv 千元→亿 ÷100000）。不设则原值直出 */
  divisor?: number
  /** 按原始值正负着色（正绿负红，0/null 无色），如 obv */
  colorBySign?: boolean
  /** FieldHelpTip conceptId（见 components/common/fieldDescriptions.ts），缺则无 ? 说明 */
  descKey?: string
}

/**
 * 31 条指标 descriptor（spec 散文写「24/前 18」是 off-by-one，逐键枚举表实为 31，以表为准）。
 * 前 22 条逐列对齐 A股/自选股/回测表共享字段（去重零漂移）；
 * 6 条 brick/amv + 3 条 obv 为后续新增。
 */
export const INDICATOR_DESCRIPTORS: IndicatorDescriptor[] = [
  { key: 'ma5', title: 'MA5', decimals: 4 },
  { key: 'ma30', title: 'MA30', decimals: 4 },
  { key: 'ma60', title: 'MA60', decimals: 4 },
  { key: 'ma120', title: 'MA120', decimals: 4 },
  { key: 'ma240', title: 'MA240', decimals: 4 },
  { key: 'bbi', title: 'BBI', decimals: 4, descKey: 'bbi' },
  { key: 'kdjJ', title: 'KDJ.J', decimals: 2, descKey: 'kdj_j' },
  { key: 'kdjK', title: 'KDJ.K', decimals: 2, descKey: 'kdj_k' },
  { key: 'kdjD', title: 'KDJ.D', decimals: 2, descKey: 'kdj_d' },
  { key: 'dif', title: 'DIF', decimals: 4, descKey: 'macd_dif' },
  { key: 'dea', title: 'DEA', decimals: 4, descKey: 'macd_dea' },
  { key: 'macd', title: 'MACD', decimals: 4, descKey: 'macd_hist' },
  { key: 'quoteVolume10', title: '10日成交额', decimals: 2 },
  { key: 'atr14', title: 'ATR14', decimals: 4, descKey: 'atr14' },
  { key: 'roc10', title: 'ROC10', decimals: 2, suffix: '%', descKey: 'roc' },
  { key: 'roc20', title: 'ROC20', decimals: 2, suffix: '%', descKey: 'roc' },
  { key: 'roc60', title: 'ROC60', decimals: 2, suffix: '%', descKey: 'roc' },
  { key: 'lossAtr14', title: 'Loss ATR14', decimals: 4, descKey: 'loss_atr14' },
  { key: 'low9', title: 'Low9', decimals: 4 },
  { key: 'high9', title: 'High9', decimals: 4 },
  { key: 'riskRewardRatio', title: 'RR', decimals: 2, descKey: 'profit_loss_ratio' },
  { key: 'stopLossPct', title: 'Stop %', decimals: 2, suffix: '%', descKey: 'stop_loss_pct' },
  // 本期新增
  { key: 'brick', title: '砖块', decimals: 4, descKey: 'brick' },
  { key: 'brickDelta', title: '砖块Δ', decimals: 4, descKey: 'brick_delta' },
  { key: 'brickXg', title: '砖块信号', kind: 'signal', decimals: 0, descKey: 'brick_xg' },
  { key: 'amvDif', title: 'AMV.DIF', decimals: 4, descKey: 'amv_dif' },
  { key: 'amvDea', title: 'AMV.DEA', decimals: 4, descKey: 'amv_dea' },
  { key: 'amvMacd', title: 'AMV.MACD', decimals: 4, descKey: 'amv_macd' },
  { key: 'obv5d', title: 'OBV5D', decimals: 2, divisor: 100000, suffix: ' 亿', colorBySign: true, descKey: 'obv5d' },
  { key: 'obv10d', title: 'OBV10D', decimals: 2, divisor: 100000, suffix: ' 亿', colorBySign: true, descKey: 'obv10d' },
  { key: 'obv20d', title: 'OBV20D', decimals: 2, divisor: 100000, suffix: ' 亿', colorBySign: true, descKey: 'obv20d' },
]

export interface BuildIndicatorColumnsOptions<Row> {
  /** 取值器，默认按 key 读 row 的同名属性（即使 Row 类型缺该字段也能编译、无值渲染 '-'） */
  accessor?: (row: Row, key: string) => unknown
  /** 命中则该单元渲染 '-'（如回测表 dataStatus 守卫） */
  blankWhen?: (row: Row) => boolean
  /** 默认可见：boolean 统一控制，或按 key 逐列决定 */
  defaultVisible?: boolean | ((key: string) => boolean)
  /** 是否可排序，默认 true */
  sortable?: boolean
  /** 列宽，默认 110 */
  width?: number
}

function defaultAccessor(row: unknown, key: string): unknown {
  return (row as Record<string, unknown>)[key]
}

/**
 * 由 descriptor 批量构造列定义。
 * 每列产物：{ key, title, width, sorter, defaultVisible, descKey, render }。
 */
export function buildIndicatorColumns<Row>(
  descriptors: IndicatorDescriptor[],
  opts: BuildIndicatorColumnsOptions<Row> = {},
): SymbolColumnDef<Row>[] {
  const accessor = opts.accessor ?? defaultAccessor
  const sortable = opts.sortable ?? true
  const width = opts.width ?? 110

  return descriptors.map((d) => {
    const defaultVisible =
      typeof opts.defaultVisible === 'function'
        ? opts.defaultVisible(d.key)
        : opts.defaultVisible

    const render = (row: Row) => {
      if (opts.blankWhen?.(row)) return '-'
      const v = accessor(row, d.key)
      if (d.kind === 'signal') {
        if (v == null) return '-'
        return h(NTag, { size: 'small' }, { default: () => (v ? '真' : '假') })
      }
      if (v == null) return '-'
      const n = Number(v)
      if (!Number.isFinite(n)) return '-'
      const scaled = d.divisor ? n / d.divisor : n
      const text = scaled.toFixed(d.decimals) + (d.suffix ?? '')
      if (d.colorBySign) {
        const color = n > 0 ? colors.success.DEFAULT : n < 0 ? colors.error.DEFAULT : undefined
        return color ? h('span', { style: { color } }, text) : text
      }
      return text
    }

    return {
      key: d.key,
      title: d.title,
      width,
      sorter: sortable,
      defaultVisible,
      descKey: d.descKey,
      render,
    }
  })
}
