import { h } from 'vue'
import { NButton, NIcon, NTooltip, type DataTableColumns } from 'naive-ui'
import { TrendingUpOutline } from '@vicons/ionicons5'
import SymbolStarButton from '../common/SymbolStarButton.vue'
import type { SymbolRow } from '@/api'
import type { SymbolColumnDef } from './columnTypes'

interface CryptoColumnsOptions {
  onViewChart: (symbol: string) => void | Promise<void>
}

const formatFixed = (value: number | null | undefined, digits: number) =>
  value == null ? '-' : value.toFixed(digits)

export function createCryptoColumnDefs(options: CryptoColumnsOptions): SymbolColumnDef<SymbolRow>[] {
  return [
    {
      title: 'Symbol',
      key: 'symbol',
      width: 140,
      fixed: 'left',
      sorter: true,
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          h(SymbolStarButton, { symbol: row.symbol }),
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, row.symbol),
        ]),
    },
    {
      title: 'Close',
      key: 'close',
      width: 110,
      sorter: true,
      render: (row) => (row.close == null ? '-' : Number(row.close).toPrecision(6)),
    },
    { title: 'MA5', key: 'ma5', width: 110, sorter: true, render: (row) => formatFixed(row.ma5 as number | null | undefined, 4) },
    { title: 'MA30', key: 'ma30', width: 110, sorter: true, render: (row) => formatFixed(row.ma30 as number | null | undefined, 4) },
    { title: 'MA60', key: 'ma60', width: 110, sorter: true, render: (row) => formatFixed(row.ma60 as number | null | undefined, 4) },
    { title: 'KDJ.J', key: 'kdjJ', width: 90, sorter: true, render: (row) => formatFixed(row.kdjJ as number | null | undefined, 2) },
    {
      title: 'RR',
      key: 'riskRewardRatio',
      width: 90,
      sorter: true,
      render: (row) => formatFixed(row.riskRewardRatio as number | null | undefined, 2),
    },
    {
      title: 'Stop %',
      key: 'stopLossPct',
      width: 90,
      sorter: true,
      render: (row) => (row.stopLossPct == null ? '-' : `${Number(row.stopLossPct).toFixed(2)}%`),
    },
    {
      title: 'Updated',
      key: 'openTime',
      width: 110,
      sorter: true,
      render: (row) => (row.openTime ? new Date(String(row.openTime)).toISOString().slice(0, 10) : '-'),
    },
    {
      title: 'Action',
      key: 'actions',
      width: 70,
      fixed: 'right',
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h(NTooltip, null, {
          trigger: () =>
            h(
              NButton,
              { size: 'small', onClick: () => options.onViewChart(row.symbol) },
              { icon: () => h(NIcon, null, () => h(TrendingUpOutline)) },
            ),
          default: () => 'Open chart',
        }),
    },
  ]
}

export function createCryptoColumns(options: CryptoColumnsOptions): DataTableColumns<SymbolRow> {
  return createCryptoColumnDefs(options) as DataTableColumns<SymbolRow>
}
