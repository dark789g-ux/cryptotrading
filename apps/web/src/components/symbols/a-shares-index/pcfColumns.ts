import type { SymbolColumnDef } from '../columns/columnTypes'
import type { EtfPcfRow } from './etf.types'
import { formatNumber } from '../a-shares/aSharesFormatters'

/** 后端 quantity 为 numeric::text（字符串），统一转字符串供 formatNumber 解析。 */
function toStr(value: number | string | null | undefined): string | null {
  return value == null ? null : String(value)
}

/**
 * PCF 成分股明细列定义（ETF 独有）。
 */
export function createPcfColumnDefs(): SymbolColumnDef<EtfPcfRow>[] {
  return [
    {
      title: '成分股代码',
      key: 'conCode',
      width: 130,
      defaultVisible: true,
      render: (row) => row.conCode,
    },
    {
      title: '名称',
      key: 'conName',
      width: 120,
      defaultVisible: true,
      render: (row) => row.conName,
    },
    {
      title: '数量',
      key: 'quantity',
      width: 120,
      defaultVisible: true,
      render: (row) => formatNumber(toStr(row.quantity), 0),
    },
    {
      title: '现金替代',
      key: 'substFlag',
      width: 100,
      defaultVisible: true,
      render: (row) => row.substFlag,
    },
    {
      title: '申购溢价%',
      key: 'premiumRate',
      width: 120,
      defaultVisible: true,
      render: (row) =>
        row.premiumRate == null ? '-' : `${row.premiumRate.toFixed(2)}%`,
    },
    {
      title: '赎回折价%',
      key: 'discountRate',
      width: 120,
      defaultVisible: false,
      render: (row) =>
        row.discountRate == null ? '-' : `${row.discountRate.toFixed(2)}%`,
    },
  ]
}
