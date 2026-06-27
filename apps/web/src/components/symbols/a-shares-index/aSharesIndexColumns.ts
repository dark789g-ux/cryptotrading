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
import { List } from '@vicons/ionicons5'
import { NButton, NIcon } from 'naive-ui'

const CATEGORY_LABEL: Record<IndexCategory, string> = {
  market: '大盘',
  industry: '行业',
  concept: '概念',
  sw: '申万',
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
 * pct_change / vol / amount / total_mv_wan / tradeDate / pe / pb / count /
 * net_amount / buy_lg_amount / buy_md_amount / buy_sm_amount /
 * net_amount_5d / net_amount_10d / net_amount_20d），
 * 这样 n-data-table 表头排序事件 handleSort 拿到的 columnKey 可直发后端，无需中转映射。
 * render 内再取 row 的驼峰字段。
 *
 * 单位（与后端契约一致，表头标注）：vol=手、amount=千元、totalMvWan=万元。
 *
 * @param showValuation 是否包含 pe/pb 估值列（仅申万区 true；同花顺区 false 剔除）
 * @param onJumpToMembers 点击"成分股"按钮的回调
 */
export function createASharesIndexColumnDefs({
  showValuation = false,
  onJumpToMembers,
}: {
  showValuation?: boolean
  onJumpToMembers?: (row: IndexLatestRow) => void
} = {}): SymbolColumnDef<IndexLatestRow>[] {
  const base: SymbolColumnDef<IndexLatestRow>[] = [
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
      title: '10日净流入',
      key: 'net_amount_10d',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.netAmount10d)),
    },
    {
      title: '20日净流入',
      key: 'net_amount_20d',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.netAmount20d)),
    },
    {
      title: '大单净流入',
      key: 'buy_lg_amount',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.buyLgAmount)),
    },
    {
      title: '中单净流入',
      key: 'buy_md_amount',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.buyMdAmount)),
    },
    {
      title: '小单净流入',
      key: 'buy_sm_amount',
      width: 120,
      sorter: true,
      defaultVisible: false,
      render: (row) => formatAmount(toStr(row.buySmAmount)),
    },
    {
      title: '个股数',
      key: 'count',
      width: 90,
      sorter: true,
      defaultVisible: true,
      render: (row) => (row.count == null ? '-' : String(row.count)),
    },
  ]

  if (showValuation) {
    // pe/pb 插在交易日列之前（估值列归组，便于申万区一眼定位）
    base.push(
      {
        title: 'PE',
        key: 'pe',
        width: 90,
        sorter: true,
        defaultVisible: true,
        render: (row) => (row.pe == null ? '' : formatNumber(toStr(row.pe), 2)),
      },
      {
        title: 'PB',
        key: 'pb',
        width: 90,
        sorter: true,
        defaultVisible: true,
        render: (row) => (row.pb == null ? '' : formatNumber(toStr(row.pb), 2)),
      },
    )
  }

  base.push({
    title: '交易日',
    key: 'tradeDate',
    width: 110,
    sorter: true,
    defaultVisible: true,
    render: (row) => formatTradeDate(row.tradeDate),
  })

  if (onJumpToMembers) {
    base.push({
      title: '操作',
      key: 'action',
      width: 90,
      fixed: 'right',
      defaultVisible: true,
      locked: true,
      render: (row) => {
        const supported = row.tsCode.endsWith('.TI') || row.tsCode.endsWith('.SI')
        return h(
          NButton,
          {
            size: 'small',
            disabled: !supported,
            title: supported ? '跳转至成分股' : '仅 .TI/.SI 后缀指数支持查看成分股',
            onClick: () => onJumpToMembers(row),
          },
          {
            icon: () => h(NIcon, null, () => h(List)),
            default: () => '成分股',
          },
        )
      },
    })
  }

  return base
}
