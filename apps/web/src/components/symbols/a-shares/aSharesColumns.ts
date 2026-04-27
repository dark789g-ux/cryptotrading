import { h } from 'vue'
import { NButton, NIcon, NTooltip, type DataTableColumns } from 'naive-ui'
import { OpenOutline } from '@vicons/ionicons5'
import type { AShareRow } from '../../../composables/useApi'
import { colors } from '../../../styles/tokens'
import { formatAmount, formatNumber, formatPercent, formatTradeDate, trendClass } from './aSharesFormatters'

interface ASharesColumnsOptions {
  onViewDetail: (row: AShareRow) => void
  priceMode: 'qfq' | 'raw'
}

function getPctChangeColor(value: string | null) {
  const num = value == null ? 0 : Number(value)
  if (num > 0) return colors.success.DEFAULT
  if (num < 0) return colors.error.DEFAULT
  return undefined
}

export function createASharesColumns(options: ASharesColumnsOptions): DataTableColumns<AShareRow> {
  const priceSuffix = options.priceMode === 'raw' ? '原始' : '前复权'
  return [
    { title: '代码', key: 'tsCode', width: 110, fixed: 'left', sorter: true },
    { title: '名称', key: 'name', width: 120, fixed: 'left', sorter: true },
    { title: '市场', key: 'market', width: 100, sorter: true, render: (row) => row.market ?? '-' },
    { title: '行业', key: 'industry', width: 120, sorter: true, render: (row) => row.industry ?? '-' },
    { title: `最新价(${priceSuffix})`, key: 'close', width: 130, sorter: true, render: (row) => formatNumber(row.close, 2) },
    {
      title: `涨跌幅(${priceSuffix})`,
      key: 'pctChg',
      width: 130,
      sorter: true,
      render: (row) => {
        const color = getPctChangeColor(row.pctChg)
        return h(
          'span',
          { class: trendClass(row.pctChg), style: color ? { color } : undefined },
          formatPercent(row.pctChg),
        )
      },
    },
    { title: '成交额', key: 'amount', width: 120, sorter: true, render: (row) => formatAmount(row.amount) },
    { title: '换手率', key: 'turnoverRate', width: 110, sorter: true, render: (row) => formatPercent(row.turnoverRate) },
    { title: 'PE', key: 'pe', width: 90, sorter: true, render: (row) => formatNumber(row.pe, 2) },
    { title: 'PB', key: 'pb', width: 90, sorter: true, render: (row) => formatNumber(row.pb, 2) },
    { title: '交易日', key: 'tradeDate', width: 110, sorter: true, render: (row) => formatTradeDate(row.tradeDate) },
    {
      title: '操作',
      key: 'actions',
      width: 70,
      fixed: 'right',
      render: (row) =>
        h(NTooltip, null, {
          trigger: () =>
            h(
              NButton,
              { size: 'small', onClick: () => options.onViewDetail(row) },
              { icon: () => h(NIcon, null, () => h(OpenOutline)) },
            ),
          default: () => '查看K线详情',
        }),
    },
  ]
}
