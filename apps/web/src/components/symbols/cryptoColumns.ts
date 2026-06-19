import { h } from 'vue'
import { NButton, NIcon, NTag, NTooltip, type DataTableColumns } from 'naive-ui'
import { TrendingUpOutline } from '@vicons/ionicons5'
import SymbolStarButton from '../common/SymbolStarButton.vue'
import type { SymbolRow } from '@/api'
import type { SymbolColumnDef } from './columnTypes'

interface CryptoColumnsOptions {
  onViewChart?: (row: SymbolRow) => void | Promise<void>
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
    { title: 'KDJ.J', key: 'kdjJ', descKey: 'kdj_j', width: 90, sorter: true, render: (row) => formatFixed(row.kdjJ as number | null | undefined, 2) },
    {
      title: 'RR',
      key: 'riskRewardRatio',
      descKey: 'profit_loss_ratio',
      width: 90,
      sorter: true,
      render: (row) => formatFixed(row.riskRewardRatio as number | null | undefined, 2),
    },
    {
      title: 'Stop %',
      key: 'stopLossPct',
      descKey: 'stop_loss_pct',
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
      title: 'Tags',
      key: 'tags',
      width: 180,
      render: (row) => {
        const tags = row.tags as { id: string; name: string }[] | undefined
        if (!tags || tags.length === 0) return h('span', { style: 'color: var(--color-text-secondary)' }, '—')
        return h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
          tags.map((tag) => h(NTag, { size: 'small', bordered: false, round: true }, { default: () => tag.name })),
        )
      },
    },
    ...(options.onViewChart
      ? [
          {
            title: 'Action',
            key: 'actions',
            width: 70,
            fixed: 'right' as const,
            defaultVisible: true,
            locked: true,
            render: (row: SymbolRow) =>
              h(NTooltip, null, {
                trigger: () =>
                  h(
                    NButton,
                    { size: 'small', onClick: () => options.onViewChart!(row) },
                    { icon: () => h(NIcon, null, () => h(TrendingUpOutline)) },
                  ),
                default: () => 'Open chart',
              }),
          },
        ]
      : []),
  ]
}

export function createCryptoColumns(options: CryptoColumnsOptions): DataTableColumns<SymbolRow> {
  return createCryptoColumnDefs(options) as DataTableColumns<SymbolRow>
}
