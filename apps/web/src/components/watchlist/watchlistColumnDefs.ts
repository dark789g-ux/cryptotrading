import { h, type Ref } from 'vue'
import { NButton, NIcon, NSpace, NTag, NTooltip } from 'naive-ui'
import { TrendingUpOutline } from '@vicons/ionicons5'
import type { WatchlistQuoteRow } from '@/api'
import type { SymbolColumnDef } from '../symbols/columnTypes'
import { INDICATOR_DESCRIPTORS, buildIndicatorColumns } from '../symbols/indicatorColumnDefs'
import {
  formatAmount,
  formatMarketCap,
  formatNumber,
  formatPercent,
  formatTradeDate,
  trendClass,
} from '../symbols/a-shares/aSharesFormatters'

const ASHARE_SYMBOL_RE = /^\d{6}\.(SZ|SH|BJ)$/

export function isWatchlistAShare(symbol: string) {
  return ASHARE_SYMBOL_RE.test(symbol)
}

function dashForCrypto(symbol: string, value: unknown) {
  if (!isWatchlistAShare(symbol)) return '—'
  if (value == null || value === '') return '—'
  return value
}

function toStr(value: string | number | null | undefined): string | null {
  if (value == null) return null
  return String(value)
}

function formatUTCDate(input: string | number | Date | null | undefined): string {
  if (input == null) return '-'
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return '-'
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getPctChangeColor(value: string | number | null | undefined) {
  const num = value == null ? 0 : Number(value)
  if (num > 0) return 'var(--color-success, #18a058)'
  if (num < 0) return 'var(--color-error, #d03050)'
  return undefined
}

export interface WatchlistColumnDefsOptions {
  scoresMap: Ref<Map<string, number>>
  scoresLoading: Ref<boolean>
  hitLookup: Ref<Map<string, Set<string>>>
  onViewChart: (symbol: string) => void
  onRemove: (symbol: string) => void
}

export function createWatchlistColumnDefs(
  options: WatchlistColumnDefsOptions,
): SymbolColumnDef<WatchlistQuoteRow>[] {
  return [
    {
      title: '代码',
      key: 'symbol',
      width: 160,
      fixed: 'left',
      sorter: true,
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h('span', {
          style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        }, row.symbol),
    },
    {
      title: '名称',
      key: 'name',
      width: 120,
      fixed: 'left',
      sorter: true,
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h('span', {
          style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        }, row.name ?? '-'),
    },
    {
      title: '市场',
      key: 'market',
      width: 100,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        const v = dashForCrypto(row.symbol, row.market)
        return typeof v === 'string' ? v : (row.market ?? '-')
      },
    },
    {
      title: '申万一级',
      key: 'swIndustryL1Code',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        const v = dashForCrypto(row.symbol, row.swIndustryL1Code)
        return typeof v === 'string' ? v : (row.swIndustryL1Code ?? '-')
      },
    },
    {
      title: '申万二级',
      key: 'swIndustryL2Code',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        const v = dashForCrypto(row.symbol, row.swIndustryL2Code)
        return typeof v === 'string' ? v : (row.swIndustryL2Code ?? '-')
      },
    },
    {
      title: '申万三级',
      key: 'swIndustryL3Code',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        const v = dashForCrypto(row.symbol, row.swIndustryL3Code)
        return typeof v === 'string' ? v : (row.swIndustryL3Code ?? '-')
      },
    },
    {
      title: '最新价',
      key: 'close',
      width: 120,
      sorter: true,
      defaultVisible: true,
      render: (row) => (row.close == null ? '-' : Number(row.close).toPrecision(6)),
    },
    {
      title: '涨跌幅',
      key: 'pctChg',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        const color = getPctChangeColor(row.pctChg)
        return h(
          'span',
          { class: trendClass(toStr(row.pctChg)), style: color ? { color } : undefined },
          formatPercent(toStr(row.pctChg)),
        )
      },
    },
    {
      title: '成交额',
      key: 'amount',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        return formatAmount(toStr(row.amount))
      },
    },
    {
      title: '换手率',
      key: 'turnoverRate',
      descKey: 'turnover_rate',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        return formatPercent(toStr(row.turnoverRate))
      },
    },
    {
      title: 'PE',
      key: 'pe',
      descKey: 'pe',
      width: 90,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        return formatNumber(toStr(row.pe), 2)
      },
    },
    {
      title: 'PE(TTM)',
      key: 'peTtm',
      descKey: 'pe_ttm',
      width: 110,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        return formatNumber(toStr(row.peTtm), 2)
      },
    },
    {
      title: 'PB',
      key: 'pb',
      descKey: 'pb',
      width: 90,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        return formatNumber(toStr(row.pb), 2)
      },
    },
    {
      title: '流通市值',
      key: 'circMv',
      descKey: 'circ_mv',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        return formatMarketCap(toStr(row.circMv))
      },
    },
    {
      title: '交易日',
      key: 'tradeDate',
      width: 110,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        return formatTradeDate(row.tradeDate ?? null)
      },
    },
    {
      title: '标签',
      key: 'tags',
      width: 180,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        const tags = row.tags
        if (!tags || tags.length === 0) {
          return h('span', { style: 'color: var(--color-text-secondary)' }, '—')
        }
        return h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
          tags.map((tag) => h(NTag, { size: 'small', bordered: false, round: true }, { default: () => tag.name })),
        )
      },
    },
    // 指标列复用共享目录（descriptor 驱动），消除与 A股/回测表的重复声明。
    // 保留自选股原有默认可见集；共享目录多出的 brick/amv 6 列无字段 → 渲染 '-' 且默认隐藏，对自选股无害。
    ...buildIndicatorColumns<WatchlistQuoteRow>(INDICATOR_DESCRIPTORS, {
      defaultVisible: (k) => new Set(['ma5', 'ma30', 'kdjJ', 'riskRewardRatio']).has(k),
    }),
    {
      title: 'Updated',
      key: 'openTime',
      width: 110,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatUTCDate(row.openTime),
    },
    {
      title: '评分',
      key: 'modelScore',
      width: 110,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        if (options.scoresLoading.value) {
          return h('span', { style: 'color: var(--color-text-secondary)' }, '…')
        }
        const v = options.scoresMap.value.get(row.symbol)
        if (v == null || !Number.isFinite(v)) {
          return h('span', { style: 'color: var(--color-text-secondary)' }, '—')
        }
        return h('div', { style: 'text-align: right; font-variant-numeric: tabular-nums' }, v.toFixed(4))
      },
    },
    {
      title: '买入信号',
      key: 'buySignal',
      width: 200,
      defaultVisible: false,
      render: (row) => {
        if (!isWatchlistAShare(row.symbol)) return '—'
        const matchedNames = options.hitLookup.value.get(row.symbol)
        if (!matchedNames || matchedNames.size === 0) return '—'
        return h(NSpace, { size: 4 }, {
          default: () => [...matchedNames].map((name) =>
            h(NTag, { type: 'success', size: 'small' }, { default: () => name })),
        })
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      fixed: 'right',
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h('div', { style: 'display:flex;gap:8px;align-items:center' }, [
          h(NTooltip, null, {
            trigger: () =>
              h(NButton, {
                size: 'small',
                tertiary: true,
                onClick: () => options.onViewChart(row.symbol),
              }, {
                icon: () => h(NIcon, null, { default: () => h(TrendingUpOutline) }),
                default: () => '查看K线',
              }),
            default: () => '查看K线详情',
          }),
          h(NButton, {
            size: 'small',
            type: 'error',
            ghost: true,
            onClick: () => options.onRemove(row.symbol),
          }, {
            default: () => '移除',
          }),
        ]),
    },
  ]
}
