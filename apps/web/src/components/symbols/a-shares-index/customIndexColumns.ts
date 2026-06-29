import { h } from 'vue'
import type { SymbolColumnDef } from '../columns/columnTypes'
import type { CustomIndexLatestRow, CustomIndexStatus } from '@/api/modules/market/customIndex'
import {
  formatAmount,
  formatNumber,
  formatPercent,
  formatTradeDate,
  trendClass,
} from '../a-shares/aSharesFormatters'
import { colors } from '../../../styles/tokens'
import { CreateOutline, List, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NProgress, NTooltip } from 'naive-ui'

const INDEX_TYPE_LABEL = {
  price: '价格指数',
  total_return: '全收益',
} as const

const STATUS_LABEL: Record<CustomIndexStatus, string> = {
  pending: '待计算',
  computing: '计算中',
  ready: '就绪',
  failed: '失败',
}

function toStr(value: number | null | undefined): string | null {
  return value == null ? null : String(value)
}

function pctColor(value: number | null): string | undefined {
  if (value == null) return undefined
  if (value > 0) return colors.success.DEFAULT
  if (value < 0) return colors.error.DEFAULT
  return undefined
}

export interface CustomIndexColumnHandlers {
  onJumpToMembers?: (row: CustomIndexLatestRow) => void
  onEdit?: (row: CustomIndexLatestRow) => void
  onDelete?: (row: CustomIndexLatestRow) => void
  onRecompute?: (row: CustomIndexLatestRow) => void
}

export function createCustomIndexColumnDefs(
  handlers: CustomIndexColumnHandlers = {},
): SymbolColumnDef<CustomIndexLatestRow>[] {
  const { onJumpToMembers, onEdit, onDelete, onRecompute } = handlers

  return [
    {
      title: '代码',
      key: 'tsCode',
      width: 140,
      fixed: 'left',
      defaultVisible: true,
      locked: true,
      render: (row) => row.tsCode,
    },
    {
      title: '名称',
      key: 'name',
      width: 140,
      fixed: 'left',
      defaultVisible: true,
      render: (row) => row.name,
    },
    {
      title: '收盘',
      key: 'close',
      width: 100,
      sorter: true,
      defaultVisible: true,
      render: (row) => (row.close == null ? '—' : formatNumber(toStr(row.close), 2)),
    },
    {
      title: '涨跌幅',
      key: 'pct_change',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => {
        const color = pctColor(row.pctChange)
        return h(
          'span',
          { class: trendClass(toStr(row.pctChange)), style: color ? { color } : undefined },
          formatPercent(toStr(row.pctChange)),
        )
      },
    },
    {
      title: '成分数',
      key: 'count',
      width: 90,
      sorter: true,
      defaultVisible: true,
      render: (row) => (row.count == null ? '—' : String(row.count)),
    },
    {
      title: '指数类型',
      key: 'indexType',
      width: 100,
      defaultVisible: true,
      render: (row) => INDEX_TYPE_LABEL[row.indexType] ?? row.indexType,
    },
    {
      title: '状态',
      key: 'status',
      width: 140,
      defaultVisible: true,
      render: (row) => {
        if (row.status === 'computing') {
          return h(NProgress, {
            type: 'line',
            percentage: row.computeProgress ?? 0,
            indicatorPlacement: 'inside',
            height: 18,
            processing: true,
          })
        }
        if (row.status === 'failed') {
          const tip = row.lastError?.trim() || '计算失败'
          return h(
            NTooltip,
            { trigger: 'hover' },
            {
              trigger: () =>
                h('span', { style: { color: colors.error.DEFAULT } }, STATUS_LABEL.failed),
              default: () => tip,
            },
          )
        }
        return STATUS_LABEL[row.status] ?? row.status
      },
    },
    {
      title: '净流入',
      key: 'net_amount',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.netAmount)),
    },
    {
      title: '5日净流入',
      key: 'net_amount_5d',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.netAmount5d)),
    },
    {
      title: '交易日',
      key: 'tradeDate',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => (row.tradeDate ? formatTradeDate(row.tradeDate) : '—'),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      fixed: 'right',
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, [
          onJumpToMembers
            ? h(
                NButton,
                {
                  size: 'small',
                  disabled: row.status !== 'ready',
                  onClick: (e: Event) => {
                    e.stopPropagation()
                    onJumpToMembers(row)
                  },
                },
                {
                  icon: () => h(NIcon, null, () => h(List)),
                  default: () => '成分股',
                },
              )
            : null,
          onEdit
            ? h(
                NButton,
                {
                  size: 'small',
                  disabled: row.status === 'computing',
                  onClick: (e: Event) => {
                    e.stopPropagation()
                    onEdit(row)
                  },
                },
                {
                  icon: () => h(NIcon, null, () => h(CreateOutline)),
                  default: () => '编辑',
                },
              )
            : null,
          row.status === 'failed' && onRecompute
            ? h(
                NButton,
                {
                  size: 'small',
                  type: 'warning',
                  onClick: (e: Event) => {
                    e.stopPropagation()
                    onRecompute(row)
                  },
                },
                {
                  icon: () => h(NIcon, null, () => h(RefreshOutline)),
                  default: () => '重试',
                },
              )
            : null,
          onDelete
            ? h(
                NButton,
                {
                  size: 'small',
                  type: 'error',
                  disabled: row.status === 'computing',
                  onClick: (e: Event) => {
                    e.stopPropagation()
                    onDelete(row)
                  },
                },
                {
                  icon: () => h(NIcon, null, () => h(TrashOutline)),
                  default: () => '删除',
                },
              )
            : null,
        ]),
    },
  ]
}
