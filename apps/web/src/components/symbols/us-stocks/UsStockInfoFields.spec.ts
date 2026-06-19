import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

import UsStockInfoFields from './UsStockInfoFields.vue'
import type { UsStockRow } from '@/api'

function makeRow(overrides: Partial<UsStockRow> = {}): UsStockRow {
  return {
    ticker: 'AAPL',
    name: 'Apple Inc',
    theme: '半导体',
    stockType: '成长股',
    close: '150.25',
    change: '3.45',
    pctChg: '2.35',
    volume: '56000000',
    amount: '8414000000',
    tradeDate: '20260618',
    ma5: null, ma30: null, ma60: null, ma120: null, ma240: null,
    bbi: null,
    kdjJ: null, kdjK: null, kdjD: null,
    dif: null, dea: null, macd: null,
    quoteVolume10: null,
    atr14: null, lossAtr14: null, low9: null, high9: null,
    riskRewardRatio: null, stopLossPct: null,
    ...overrides,
  } as UsStockRow
}

function mountFields(row: UsStockRow | null) {
  return mount(UsStockInfoFields, { props: { row } })
}

describe('UsStockInfoFields', () => {
  it('渲染全部 6 个字段行', () => {
    const wrapper = mountFields(makeRow())
    const rows = wrapper.findAllComponents({ name: 'InfoRow' })
    expect(rows.length).toBe(6)
  })

  it('label 含单位', () => {
    const wrapper = mountFields(makeRow())
    const labels = wrapper.findAll('.info-row__label').map((el) => el.text())
    expect(labels).toEqual([
      '主题',
      '类型',
      '现价(美元)',
      '涨跌幅(%)',
      '成交量',
      '成交额',
    ])
  })

  it('成交量走 fmtCompact（万/亿缩写）', () => {
    const wrapper = mountFields(makeRow({ volume: '56000000' }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    // 56000000 → 5600 万
    expect(values[4]).toBe('5600.00万')
  })

  it('成交额走 formatAmount', () => {
    const wrapper = mountFields(makeRow({ amount: '8414000000' }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    expect(values[5]).toContain('亿')
  })

  it('涨跌幅走 formatPercent + trendClass 着色', () => {
    const wrapper = mountFields(makeRow({ pctChg: '2.35' }))
    const valueEls = wrapper.findAll('.info-row__value')
    expect(valueEls[3].text()).toBe('2.35%')
    expect(valueEls[3].classes()).toContain('trend-up')
  })

  it('涨跌幅为负 → trend-down', () => {
    const wrapper = mountFields(makeRow({ pctChg: '-1.5' }))
    const valueEls = wrapper.findAll('.info-row__value')
    expect(valueEls[3].classes()).toContain('trend-down')
  })

  it('row null → 显示未选择标的空状态', () => {
    const wrapper = mountFields(null)
    expect(wrapper.find('.us-stock-info-fields').exists()).toBe(false)
    expect(wrapper.text()).toContain('未选择标的')
  })

  it('单字段 null → 显示 "-"', () => {
    const wrapper = mountFields(makeRow({ close: null }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    expect(values[2]).toBe('-')
  })
})
