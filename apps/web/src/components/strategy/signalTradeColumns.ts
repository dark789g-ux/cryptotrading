import { h } from 'vue'
import { NButton } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { SignalTestTrade } from '../../api/modules/strategy/signalStats'
import { fmtTradeDate, fmtRetPct, exitReasonLabel, retColor } from './signalStatsFormatters'

export function buildTradeColumns(opts: {
  onViewDetail: (row: SignalTestTrade) => void
}): DataTableColumns<SignalTestTrade> {
  return [
    {
      title: '标的',
      key: 'tsCode',
      width: 100,
      sorter: true,
    },
    {
      title: '名称',
      key: 'name',
      width: 96,
      ellipsis: { lineClamp: 3, tooltip: true },
      render: (row) => row.name ?? '—',
    },
    {
      title: '信号日',
      key: 'signalDate',
      sorter: true,
      render: (row) => fmtTradeDate(row.signalDate),
    },
    {
      title: '买入日',
      key: 'buyDate',
      sorter: true,
      render: (row) => fmtTradeDate(row.buyDate),
    },
    {
      title: '出场日',
      key: 'exitDate',
      sorter: true,
      render: (row) => fmtTradeDate(row.exitDate),
    },
    {
      title: '买入价',
      key: 'buyPrice',
      sorter: true,
      render: (row) => Number(row.buyPrice).toFixed(3),
    },
    {
      title: '出场价',
      key: 'exitPrice',
      sorter: true,
      render: (row) => Number(row.exitPrice).toFixed(3),
    },
    {
      title: '收益率',
      key: 'ret',
      sorter: true,
      render: (row) =>
        h('span', { style: { color: retColor(row.ret) } }, fmtRetPct(row.ret)),
    },
    {
      title: '持仓天数',
      key: 'holdDays',
      sorter: true,
    },
    {
      title: '出场原因',
      key: 'exitReason',
      minWidth: 110,
      sorter: true,
      ellipsis: { lineClamp: 3, tooltip: true },
      render: (row) => exitReasonLabel(row.exitReason),
    },
    {
      title: '操作',
      key: 'actions',
      width: 70,
      fixed: 'right',
      render: (row) =>
        h(
          NButton,
          { size: 'small', onClick: () => opts.onViewDetail(row) },
          { default: () => '详情' },
        ),
    },
  ]
}
