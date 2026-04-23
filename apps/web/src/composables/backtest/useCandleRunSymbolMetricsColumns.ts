import { computed, h } from 'vue'
import { NButton, NTag as NTagComponent, type DataTableColumns } from 'naive-ui'
import type { RunSymbolMetricRow } from '../useApi'

export type ColSortOrder = false | 'ascend' | 'descend'

interface UseCandleRunSymbolMetricsColumnsOptions {
  headerOrder: (key: string) => ColSortOrder
  onOpenKline: (symbol: string) => void
}

const fmtNum = (value: number | null | undefined, digits = 4) =>
  value === null || value === undefined || Number.isNaN(Number(value)) ? '-' : Number(value).toFixed(digits)

const renderStatusTags = (row: RunSymbolMetricRow) => {
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

export const useCandleRunSymbolMetricsColumns = ({
  headerOrder,
  onOpenKline,
}: UseCandleRunSymbolMetricsColumnsOptions) => {
  const columns = computed<DataTableColumns<RunSymbolMetricRow>>(() => [
    {
      title: '标的',
      key: 'symbol',
      width: 120,
      fixed: 'left',
      sortOrder: headerOrder('symbol'),
      sorter: true,
    },
    {
      title: '数据',
      key: 'dataStatus',
      width: 88,
      sortOrder: headerOrder('dataStatus'),
      sorter: true,
      render: (row) =>
        row.dataStatus === 'missing'
          ? h(NTagComponent, { type: 'warning', size: 'small' }, { default: () => '缺数据' })
          : h(NTagComponent, { type: 'success', size: 'small', bordered: false }, { default: () => '正常' }),
    },
    {
      title: '状态',
      key: 'barStatus',
      width: 200,
      render: renderStatusTags,
    },
    {
      title: '收盘价',
      key: 'close',
      width: 110,
      sortOrder: headerOrder('close'),
      sorter: true,
      render: (row) => (row.dataStatus === 'missing' ? '-' : fmtNum(row.close, 6)),
    },
    {
      title: 'MA5',
      key: 'ma5',
      width: 100,
      sortOrder: headerOrder('ma5'),
      sorter: true,
      render: (row) => (row.dataStatus === 'missing' ? '-' : fmtNum(row.ma5)),
    },
    {
      title: 'MA30',
      key: 'ma30',
      width: 100,
      sortOrder: headerOrder('ma30'),
      sorter: true,
      render: (row) => (row.dataStatus === 'missing' ? '-' : fmtNum(row.ma30)),
    },
    {
      title: 'MA60',
      key: 'ma60',
      width: 100,
      sortOrder: headerOrder('ma60'),
      sorter: true,
      render: (row) => (row.dataStatus === 'missing' ? '-' : fmtNum(row.ma60)),
    },
    {
      title: 'KDJ.J',
      key: 'kdjJ',
      width: 90,
      sortOrder: headerOrder('kdjJ'),
      sorter: true,
      render: (row) => (row.dataStatus === 'missing' ? '-' : fmtNum(row.kdjJ, 2)),
    },
    {
      title: '盈亏比',
      key: 'riskRewardRatio',
      width: 90,
      sortOrder: headerOrder('riskRewardRatio'),
      sorter: true,
      render: (row) => (row.dataStatus === 'missing' ? '-' : fmtNum(row.riskRewardRatio, 2)),
    },
    {
      title: '止损%',
      key: 'stopLossPct',
      width: 90,
      sortOrder: headerOrder('stopLossPct'),
      sorter: true,
      render: (row) =>
        row.dataStatus === 'missing' || row.stopLossPct == null ? '-' : `${fmtNum(row.stopLossPct, 2)}%`,
    },
    {
      title: '操作',
      key: 'actions',
      width: 96,
      fixed: 'right',
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
  ])

  return {
    columns,
  }
}
