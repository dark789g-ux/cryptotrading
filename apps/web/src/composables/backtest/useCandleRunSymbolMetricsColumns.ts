import { h } from 'vue'
import { NButton, NTag as NTagComponent } from 'naive-ui'
import type { RunSymbolMetricRow } from '@/api'
import type { SymbolColumnDef } from '@/components/symbols/columns/columnTypes'
import { INDICATOR_DESCRIPTORS, buildIndicatorColumns } from '@/components/symbols/columns/indicatorColumnDefs'

export type ColSortOrder = false | 'ascend' | 'descend'

/** 这 6 个 key 是 RunSymbolMetricRow 实有的指标字段（number 型），复用共享指标目录渲染 */
export const BACKTEST_METRIC_KEYS = new Set([
  'ma5',
  'ma30',
  'ma60',
  'kdjJ',
  'riskRewardRatio',
  'stopLossPct',
])

export const fmtNum = (value: number | null | undefined, digits = 4) =>
  value === null || value === undefined || Number.isNaN(Number(value)) ? '-' : Number(value).toFixed(digits)

export const renderStatusTags = (row: RunSymbolMetricRow) => {
  if (!row.buyOnBar && !row.sellOnBar && !row.holdAtClose) return '—'

  const nodes: Array<ReturnType<typeof h>> = []
  if (row.buyOnBar) {
    nodes.push(h(NTagComponent, { type: 'info', size: 'small' }, { default: () => '本根买入' }))
  }
  if (row.sellOnBar) {
    nodes.push(h(NTagComponent, { type: 'warning', size: 'small' }, { default: () => '本根卖出' }))
  }
  if (row.holdAtClose) {
    nodes.push(h(NTagComponent, { type: 'success', size: 'small' }, { default: () => '本根持有' }))
  }

  return h('div', { class: 'metric-row-status-tags' }, nodes)
}

interface CreateBacktestMetricsColumnDefsOptions {
  onOpenKline: (symbol: string) => void
}

/**
 * 纯 defs 工厂：返回 SymbolColumnDef<RunSymbolMetricRow>[]，供共享列偏好底座
 * （normalizeScopePreferences / buildColumnsFromPreference）与 ColumnSettingsDrawer 消费。
 *
 * 受控远程排序的 sortOrder 不在此注入——共享 buildColumnsFromPreference 产物不含 sortOrder，
 * 由 host（CandleRunSymbolMetrics.vue）在 columnsBase 上 post-map 注入 headerOrder(key)。
 *
 * 6 个指标列复用 INDICATOR_DESCRIPTORS + buildIndicatorColumns，并用 blankWhen 守卫
 * dataStatus==='missing' 时渲染 '-'（与原表逐列等价）。
 */
export const createBacktestMetricsColumnDefs = ({
  onOpenKline,
}: CreateBacktestMetricsColumnDefsOptions): SymbolColumnDef<RunSymbolMetricRow>[] => [
  {
    key: 'symbol',
    title: '标的',
    width: 120,
    fixed: 'left',
    locked: true,
    defaultVisible: true,
    sorter: true,
    render: (row) => row.symbol,
  },
  {
    key: 'dataStatus',
    title: '数据',
    width: 88,
    defaultVisible: true,
    sorter: true,
    render: (row) =>
      row.dataStatus === 'missing'
        ? h(NTagComponent, { type: 'warning', size: 'small' }, { default: () => '缺数据' })
        : h(NTagComponent, { type: 'success', size: 'small', bordered: false }, { default: () => '正常' }),
  },
  {
    key: 'barStatus',
    title: '状态',
    width: 200,
    defaultVisible: true,
    render: renderStatusTags,
  },
  {
    key: 'close',
    title: '收盘价',
    width: 110,
    defaultVisible: true,
    sorter: true,
    render: (row) => (row.dataStatus === 'missing' ? '-' : fmtNum(row.close, 6)),
  },
  // —— 指标子集复用共享目录 + blankWhen 守卫（默认全可见，维持现状）——
  ...buildIndicatorColumns<RunSymbolMetricRow>(
    INDICATOR_DESCRIPTORS.filter((d) => BACKTEST_METRIC_KEYS.has(d.key)),
    { blankWhen: (row) => row.dataStatus === 'missing', defaultVisible: true, width: 100 },
  ),
  {
    key: 'actions',
    title: '操作',
    width: 96,
    fixed: 'right',
    locked: true,
    defaultVisible: true,
    render: (row) =>
      h(
        NButton,
        {
          size: 'small',
          type: 'primary',
          quaternary: true,
          onClick: () => onOpenKline(row.symbol),
        },
        { default: () => 'K线' },
      ),
  },
]
