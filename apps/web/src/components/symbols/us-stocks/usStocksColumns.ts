import { h } from 'vue'
import { NButton, NIcon, NTooltip, type DataTableColumns } from 'naive-ui'
import { OpenOutline } from '@vicons/ionicons5'
import SymbolStarButton from '../../common/SymbolStarButton.vue'
import type { UsStockRow } from '@/api'
import { colors } from '../../../styles/tokens'
import { formatNumber, formatPercent, formatTradeDate, trendClass } from '../a-shares/aSharesFormatters'
import type { SymbolColumnDef } from '../columns/columnTypes'
import { INDICATOR_DESCRIPTORS, buildIndicatorColumns, type IndicatorDescriptor } from '../columns/indicatorColumnDefs'

interface UsStocksColumnsOptions {
  onViewDetail?: (row: UsStockRow) => void
  priceMode: 'qfq' | 'raw'
}

/**
 * 美股适用的指标 descriptor 子集：与后端 raw.us_daily_indicator 实算的 17 个指标严格对齐
 * （MA5/30/60/120/240、BBI、KDJ.K/D/J、DIF/DEA/MACD、ATR14、Low9/High9、RR、Stop%）。
 * 用显式 allow-list 而非 deny-list：美股不算 10日成交额(quoteVolume10)、Loss ATR14，
 * 以及 A 股专属的 brick 与 amv 系列，这些 key 若留在选择器里会渲染空列。
 */
const US_INDICATOR_KEYS = new Set<string>([
  'ma5', 'ma30', 'ma60', 'ma120', 'ma240',
  'bbi', 'kdjJ', 'kdjK', 'kdjD',
  'dif', 'dea', 'macd',
  'atr14', 'low9', 'high9',
  'riskRewardRatio', 'stopLossPct',
])
const US_INDICATOR_DESCRIPTORS: IndicatorDescriptor[] = INDICATOR_DESCRIPTORS.filter(
  (d) => US_INDICATOR_KEYS.has(d.key),
)

function getPctChangeColor(value: string | null) {
  const num = value == null ? 0 : Number(value)
  if (num > 0) return colors.success.DEFAULT
  if (num < 0) return colors.error.DEFAULT
  return undefined
}

function formatVolume(value: string | null) {
  if (value == null) return '-'
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  if (Math.abs(num) >= 1_0000_0000) return `${(num / 1_0000_0000).toFixed(2)} 亿`
  if (Math.abs(num) >= 1_0000) return `${(num / 1_0000).toFixed(2)} 万`
  return num.toFixed(0)
}

export function createUsStocksColumnDefs(options: UsStocksColumnsOptions): SymbolColumnDef<UsStockRow>[] {
  const priceSuffix = options.priceMode === 'raw' ? '原始' : '前复权'
  return [
    {
      title: '代码',
      key: 'ticker',
      width: 140,
      fixed: 'left',
      sorter: true,
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          h(SymbolStarButton, { symbol: row.ticker }),
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, row.ticker),
        ]),
    },
    { title: '名称', key: 'name', width: 160, fixed: 'left', sorter: true, defaultVisible: true, render: (row) => row.name },
    { title: '主题', key: 'theme', width: 150, sorter: true, defaultVisible: true, render: (row) => row.theme ?? '-' },
    { title: '类型', key: 'stockType', width: 120, sorter: true, defaultVisible: true, render: (row) => row.stockType ?? '-' },
    {
      title: `最新价(${priceSuffix})`,
      key: 'close',
      width: 130,
      sorter: true,
      defaultVisible: true,
      render: (row) => formatNumber(row.close, 2),
    },
    {
      title: `涨跌幅(${priceSuffix})`,
      key: 'pctChg',
      width: 130,
      sorter: true,
      defaultVisible: true,
      render: (row) => {
        const color = getPctChangeColor(row.pctChg)
        return h(
          'span',
          { class: trendClass(row.pctChg), style: color ? { color } : undefined },
          formatPercent(row.pctChg),
        )
      },
    },
    { title: '成交量', key: 'volume', width: 120, sorter: true, defaultVisible: true, render: (row) => formatVolume(row.volume) },
    { title: '交易日', key: 'tradeDate', width: 110, sorter: true, defaultVisible: true, render: (row) => formatTradeDate(row.tradeDate) },
    // 共享技术指标列（descriptor 驱动，美股子集）。全部默认隐藏，不撑默认表宽；
    // sorter:true（builder 默认）→ remote 表点表头触发后端排序。
    ...buildIndicatorColumns<UsStockRow>(US_INDICATOR_DESCRIPTORS, { defaultVisible: false }),
    ...(options.onViewDetail
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 70,
            fixed: 'right' as const,
            defaultVisible: true,
            locked: true,
            render: (row: UsStockRow) =>
              h(NTooltip, null, {
                trigger: () =>
                  h(
                    NButton,
                    { size: 'small', onClick: () => options.onViewDetail!(row) },
                    { icon: () => h(NIcon, null, () => h(OpenOutline)) },
                  ),
                default: () => '查看K线详情',
              }),
          },
        ]
      : []),
  ]
}

export { US_INDICATOR_DESCRIPTORS }

export function createUsStocksColumns(options: UsStocksColumnsOptions): DataTableColumns<UsStockRow> {
  return createUsStocksColumnDefs(options) as DataTableColumns<UsStockRow>
}
