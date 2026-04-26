import { h } from 'vue'
import { NButton, NIcon, NTooltip, type DataTableColumns } from 'naive-ui'
import { OpenOutline } from '@vicons/ionicons5'
import type { AShareRow } from '../../../composables/useApi'
import { formatAmount, formatNumber, formatPercent, formatTradeDate, trendClass } from './aSharesFormatters'

interface ASharesColumnsOptions {
  onViewDetail: (row: AShareRow) => void
}

export function createASharesColumns(options: ASharesColumnsOptions): DataTableColumns<AShareRow> {
  return [
    { title: '代码', key: 'tsCode', width: 110, fixed: 'left', sorter: true },
    { title: '名称', key: 'name', width: 120, fixed: 'left', sorter: true },
    { title: '市场', key: 'market', width: 100, sorter: true, render: (row) => row.market ?? '-' },
    { title: '行业', key: 'industry', width: 120, sorter: true, render: (row) => row.industry ?? '-' },
    { title: '最新价', key: 'close', width: 110, sorter: true, render: (row) => formatNumber(row.close, 2) },
    {
      title: '涨跌幅',
      key: 'pctChg',
      width: 110,
      sorter: true,
      render: (row) => h('span', { class: trendClass(row.pctChg) }, formatPercent(row.pctChg)),
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
