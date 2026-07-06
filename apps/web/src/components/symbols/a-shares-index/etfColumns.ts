import { h } from 'vue'
import type { SymbolColumnDef } from '../columns/columnTypes'
import type { EtfLatestRow } from './etf.types'
import {
  formatAmount,
  formatNumber,
  formatObv,
  formatPercent,
  formatTradeDate,
  trendClass,
} from '../a-shares/aSharesFormatters'
import { colors } from '../../../styles/tokens'

function toStr(value: number | boolean | null | undefined): string | null {
  return value == null ? null : String(value)
}

function pctColor(value: number | null): string | undefined {
  if (value == null) return undefined
  if (value > 0) return colors.success.DEFAULT
  if (value < 0) return colors.error.DEFAULT
  return undefined
}

/**
 * OBV 单元格：按正负着色（正绿负红，0/null 无色）+ 千元→亿格式化。
 * obv 字段单位为千元，用 formatObv 统一显示亿（不用 formatAmount 的万分支）。
 */
function renderObvCell(value: number | null) {
  const color = pctColor(value)
  return h('span', { style: color ? { color } : undefined }, formatObv(toStr(value)))
}

/**
 * ETF 列表列定义。
 *
 * 列 key 直接等于后端 EtfLatestSortField（snake_case），
 * 这样 n-data-table 表头排序事件 handleSort 拿到的 columnKey 可直发后端。
 * render 内取 row 的驼峰字段。
 *
 * @param onJumpToMembers 点击"成分股"按钮的回调
 */
export function createEtfColumnDefs({
  onJumpToMembers,
}: {
  onJumpToMembers?: (row: EtfLatestRow) => void
} = {}): SymbolColumnDef<EtfLatestRow>[] {
  const base: SymbolColumnDef<EtfLatestRow>[] = [
    {
      title: '代码',
      key: 'ts_code',
      width: 130,
      fixed: 'left',
      defaultVisible: true,
      locked: true,
      render: (row) => row.tsCode,
    },
    {
      title: '名称',
      key: 'name',
      width: 130,
      fixed: 'left',
      defaultVisible: true,
      render: (row) => row.name,
    },
    {
      title: '跟踪指数',
      key: 'index_code',
      width: 120,
      defaultVisible: true,
      render: (row) => row.indexCode ?? '-',
    },
    {
      title: '管理人',
      key: 'manager',
      width: 100,
      defaultVisible: false,
      render: (row) => row.manager,
    },
    {
      title: '类型',
      key: 'fund_type',
      width: 90,
      defaultVisible: true,
      render: (row) => row.fundType ?? '-',
    },
    {
      title: '收盘',
      key: 'close',
      width: 100,
      defaultVisible: true,
      render: (row) => formatNumber(toStr(row.close), 4),
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
      title: 'MA30',
      key: 'ma30',
      width: 100,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatNumber(toStr(row.ma30), 4),
    },
    {
      title: 'DIF',
      key: 'dif',
      width: 100,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatNumber(toStr(row.dif), 4),
    },
    {
      title: 'DEA',
      key: 'dea',
      width: 100,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatNumber(toStr(row.dea), 4),
    },
    {
      title: 'MACD',
      key: 'macd',
      width: 100,
      sorter: true,
      defaultVisible: true,
      render: (row) => {
        const value = row.macd
        if (value == null) return '-'
        const color = pctColor(value)
        return h('span', { style: color ? { color } : undefined }, value.toFixed(4))
      },
    },
    {
      title: 'KDJ-K',
      key: 'kdj_k',
      width: 90,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatNumber(toStr(row.kdjK), 2),
    },
    {
      title: 'KDJ-D',
      key: 'kdj_d',
      width: 90,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatNumber(toStr(row.kdjD), 2),
    },
    {
      title: 'KDJ-J',
      key: 'kdj_j',
      width: 90,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatNumber(toStr(row.kdjJ), 2),
    },
    {
      title: 'OBV5日',
      key: 'obv5d',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => renderObvCell(row.obv5d),
    },
    {
      title: 'OBV10日',
      key: 'obv10d',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => renderObvCell(row.obv10d),
    },
    {
      title: 'OBV20日',
      key: 'obv20d',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => renderObvCell(row.obv20d),
    },
    {
      title: '公布IOPV',
      key: 'publish_iopv',
      width: 100,
      defaultVisible: true,
      render: (row) => (row.publishIopv ? '是' : '否'),
    },
    {
      title: '最小申赎单位',
      key: 'creation_unit',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) =>
        row.creationUnit == null ? '-' : `${(row.creationUnit / 10000).toFixed(0)}万`,
    },
    {
      title: '现金替代上限',
      key: 'max_cash_ratio',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) =>
        row.maxCashRatio == null ? '-' : `${row.maxCashRatio.toFixed(1)}%`,
    },
    {
      title: '成分股数',
      key: 'component_count',
      width: 100,
      sorter: true,
      defaultVisible: true,
      render: (row) =>
        row.componentCount == null ? '-' : String(row.componentCount),
    },
    {
      title: '交易日',
      key: 'trade_date',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => formatTradeDate(row.tradeDate),
    },
  ]

  return base
}
