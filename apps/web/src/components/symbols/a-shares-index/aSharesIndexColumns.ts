import { h } from 'vue'
import type { SymbolColumnDef } from '../columnTypes'
import type { IndexCategory, IndexLatestRow } from './types'
import {
  formatAmount,
  formatMarketCap,
  formatNumber,
  formatPercent,
  formatTradeDate,
  trendClass,
} from '../a-shares/aSharesFormatters'
import { colors } from '../../../styles/tokens'

const CATEGORY_LABEL: Record<IndexCategory, string> = {
  market: '大盘',
  industry: '行业',
  concept: '概念',
}

/**
 * aSharesFormatters 的格式器签名是 `string | null`（面向后端字符串字段）；
 * 行情表数值字段是 `number | null`，统一转 string 复用同一格式逻辑，避免重复实现换算。
 */
function toStr(value: number | null): string | null {
  return value == null ? null : String(value)
}

function pctColor(value: number | null): string | undefined {
  if (value == null) return undefined
  if (value > 0) return colors.success.DEFAULT
  if (value < 0) return colors.error.DEFAULT
  return undefined
}

/**
 * A 股指数行情表列定义。
 *
 * 列 key 设计：可排序列的 key **直接等于后端 sort 白名单**
 * （apps/server/.../index-daily/dto/latest.dto.ts IndexLatestSortField：
 * pct_change / vol / amount / total_mv_wan / tradeDate），
 * 这样 n-data-table 表头排序事件 handleSort 拿到的 columnKey 可直发后端，无需中转映射。
 * render 内再取 row 的驼峰字段。
 *
 * 单位（与后端契约一致，表头标注）：vol=手、amount=千元、totalMvWan=万元。
 */
export function createASharesIndexColumnDefs(): SymbolColumnDef<IndexLatestRow>[] {
  return [
    {
      title: '代码',
      key: 'tsCode',
      width: 130,
      fixed: 'left',
      defaultVisible: true,
      locked: true,
      render: (row) => row.tsCode,
    },
    {
      title: '名称',
      key: 'name',
      width: 120,
      fixed: 'left',
      defaultVisible: true,
      render: (row) => row.name,
    },
    {
      title: '类型',
      key: 'category',
      width: 80,
      defaultVisible: true,
      render: (row) => CATEGORY_LABEL[row.category] ?? row.category,
    },
    {
      title: '收盘',
      key: 'close',
      width: 100,
      defaultVisible: true,
      render: (row) => formatNumber(toStr(row.close), 2),
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
      title: '成交量(手)',
      key: 'vol',
      width: 120,
      sorter: true,
      defaultVisible: true,
      render: (row) => formatNumber(toStr(row.vol), 0),
    },
    {
      title: '成交额',
      key: 'amount',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.amount)),
    },
    {
      title: '总市值',
      key: 'total_mv_wan',
      width: 130,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatMarketCap(row.totalMvWan),
    },
    {
      title: '交易日',
      key: 'tradeDate',
      width: 110,
      sorter: true,
      defaultVisible: true,
      render: (row) => formatTradeDate(row.tradeDate),
    },
  ]
}
