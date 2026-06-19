import { h, type Ref } from 'vue'
import { NButton, NIcon, NTag, NTooltip, type DataTableColumns } from 'naive-ui'
import { OpenOutline } from '@vicons/ionicons5'
import SymbolStarButton from '../../common/SymbolStarButton.vue'
import type { AShareRow } from '@/api'
import { colors } from '../../../styles/tokens'
import { formatAmount, formatMarketCap, formatNumber, formatPercent, formatTradeDate, trendClass } from './aSharesFormatters'
import type { SymbolColumnDef } from '../columnTypes'
import { INDICATOR_DESCRIPTORS, buildIndicatorColumns } from '../indicatorColumnDefs'

interface ASharesColumnsOptions {
  onViewDetail?: (row: AShareRow) => void
  priceMode: 'qfq' | 'raw'
  /** 评分映射 tsCode → score；传 ref 本身（不解包），render 内读 .value 建立渲染层依赖 */
  scoresMap: Ref<Map<string, number>>
  scoresLoading: Ref<boolean>
}

function getPctChangeColor(value: string | null) {
  const num = value == null ? 0 : Number(value)
  if (num > 0) return colors.success.DEFAULT
  if (num < 0) return colors.error.DEFAULT
  return undefined
}

export function createASharesColumnDefs(options: ASharesColumnsOptions): SymbolColumnDef<AShareRow>[] {
  const priceSuffix = options.priceMode === 'raw' ? '原始' : '前复权'
  return [
    {
      title: '代码',
      key: 'tsCode',
      width: 140,
      fixed: 'left',
      sorter: true,
      defaultVisible: true,
      locked: true,
      render: (row) =>
        h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
          h(SymbolStarButton, { symbol: row.tsCode }),
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, row.tsCode),
        ]),
    },
    { title: '名称', key: 'name', width: 120, fixed: 'left', sorter: true, defaultVisible: true, render: (row) => row.name },
    { title: '市场', key: 'market', width: 100, sorter: true, defaultVisible: true, render: (row) => row.market ?? '-' },
    { title: '行业', key: 'industry', width: 120, sorter: true, defaultVisible: true, render: (row) => row.industry ?? '-' },
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
    { title: '成交额', key: 'amount', width: 120, sorter: true, defaultVisible: true, render: (row) => formatAmount(row.amount) },
    { title: '换手率', key: 'turnoverRate', descKey: 'turnover_rate', width: 110, sorter: true, defaultVisible: true, render: (row) => formatPercent(row.turnoverRate) },
    { title: 'PE', key: 'pe', descKey: 'pe', width: 90, sorter: true, defaultVisible: true, render: (row) => formatNumber(row.pe, 2) },
    { title: 'PE(TTM)', key: 'peTtm', descKey: 'pe_ttm', width: 110, sorter: true, defaultVisible: true, render: (row) => formatNumber(row.peTtm, 2) },
    { title: 'PB', key: 'pb', descKey: 'pb', width: 90, sorter: true, defaultVisible: true, render: (row) => formatNumber(row.pb, 2) },
    { title: '总市值', key: 'totalMv', descKey: 'total_mv', width: 120, sorter: true, defaultVisible: false, render: (row) => formatMarketCap(row.totalMv) },
    { title: '流通市值', key: 'circMv', descKey: 'circ_mv', width: 120, sorter: true, defaultVisible: false, render: (row) => formatMarketCap(row.circMv) },
    { title: '交易日', key: 'tradeDate', width: 110, sorter: true, defaultVisible: true, render: (row) => formatTradeDate(row.tradeDate) },
    {
      title: '评分',
      key: 'modelScore',
      width: 110,
      defaultVisible: true,
      // 表头排序：服务端按当日 prod 评分 JOIN 排序（同一快照日内评分可比）。
      // 未评分行 NULLS LAST 恒置末尾。点击触发 remote 重新查询 + 评分重新回填。
      sorter: true,
      render: (row) => {
        if (options.scoresLoading.value) {
          return h('span', { style: 'color: var(--color-text-secondary)' }, '…')
        }
        const v = options.scoresMap.value.get(row.tsCode)
        if (v == null || !Number.isFinite(v)) {
          // 缺失留空，禁止回填 0 / 历史值
          return h('span', { style: 'color: var(--color-text-secondary)' }, '—')
        }
        // 右对齐 + 4 位小数；不阈值着色、不涨跌箭头（评分是 ordinal 原始分）
        return h('div', { style: 'text-align: right; font-variant-numeric: tabular-nums' }, v.toFixed(4))
      },
    },
    {
      title: '标签',
      key: 'tags',
      width: 180,
      defaultVisible: true,
      render: (row) => {
        const tags = row.tags as { id: string; name: string }[] | undefined
        if (!tags || tags.length === 0) return h('span', { style: 'color: var(--color-text-secondary)' }, '—')
        return h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
          tags.map((tag) => h(NTag, { size: 'small', bordered: false, round: true }, { default: () => tag.name })),
        )
      },
    },
    // 共享技术指标列（descriptor 驱动）。A股 全部默认隐藏，不撑默认表宽；
    // sorter:true（builder 默认）→ remote 表点表头触发 T1 后端排序。
    ...buildIndicatorColumns<AShareRow>(INDICATOR_DESCRIPTORS, { defaultVisible: false }),
    ...(options.onViewDetail
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 70,
            fixed: 'right' as const,
            defaultVisible: true,
            locked: true,
            render: (row: AShareRow) =>
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

export function createASharesColumns(options: ASharesColumnsOptions): DataTableColumns<AShareRow> {
  return createASharesColumnDefs(options) as DataTableColumns<AShareRow>
}
