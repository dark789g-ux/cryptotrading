import { h, type Ref } from 'vue'
import { NButton, NIcon, NSpace, NTag, NTooltip } from 'naive-ui'
import { TrendingUpOutline } from '@vicons/ionicons5'
import type { WatchlistQuoteRow } from '@/api'
import type { SymbolColumnDef } from '../symbols/columnTypes'
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

function formatFixed(value: number | string | null | undefined, digits: number) {
  if (value == null) return '-'
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(digits) : '-'
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
      title: '行业',
      key: 'industry',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => {
        const v = dashForCrypto(row.symbol, row.industry)
        return typeof v === 'string' ? v : (row.industry ?? '-')
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
    { title: 'MA5', key: 'ma5', width: 110, sorter: true, defaultVisible: true, render: (row) => formatFixed(row.ma5, 4) },
    { title: 'MA30', key: 'ma30', width: 110, sorter: true, defaultVisible: true, render: (row) => formatFixed(row.ma30, 4) },
    { title: 'MA60', key: 'ma60', width: 110, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.ma60, 4) },
    { title: 'MA120', key: 'ma120', width: 110, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.ma120, 4) },
    { title: 'MA240', key: 'ma240', width: 110, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.ma240, 4) },
    { title: 'KDJ.J', key: 'kdjJ', descKey: 'kdj_j', width: 90, sorter: true, defaultVisible: true, render: (row) => formatFixed(row.kdjJ, 2) },
    { title: 'KDJ.K', key: 'kdjK', descKey: 'kdj_k', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.kdjK, 2) },
    { title: 'KDJ.D', key: 'kdjD', descKey: 'kdj_d', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.kdjD, 2) },
    { title: 'DIF', key: 'dif', descKey: 'macd_dif', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.dif, 4) },
    { title: 'DEA', key: 'dea', descKey: 'macd_dea', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.dea, 4) },
    { title: 'MACD', key: 'macd', descKey: 'macd_hist', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.macd, 4) },
    { title: 'BBI', key: 'bbi', descKey: 'bbi', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.bbi, 4) },
    { title: '10日成交额', key: 'quoteVolume10', width: 120, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.quoteVolume10, 2) },
    { title: 'ATR14', key: 'atr14', descKey: 'atr14', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.atr14, 4) },
    { title: 'Loss ATR14', key: 'lossAtr14', descKey: 'loss_atr14', width: 110, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.lossAtr14, 4) },
    { title: 'Low9', key: 'low9', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.low9, 4) },
    { title: 'High9', key: 'high9', width: 90, sorter: true, defaultVisible: false, render: (row) => formatFixed(row.high9, 4) },
    { title: 'RR', key: 'riskRewardRatio', descKey: 'profit_loss_ratio', width: 90, sorter: true, defaultVisible: true, render: (row) => formatFixed(row.riskRewardRatio, 2) },
    {
      title: 'Stop %',
      key: 'stopLossPct',
      descKey: 'stop_loss_pct',
      width: 90,
      sorter: true,
      defaultVisible: false,
      render: (row) => (row.stopLossPct == null ? '-' : `${Number(row.stopLossPct).toFixed(2)}%`),
    },
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
