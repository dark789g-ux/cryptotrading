import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

import AStockInfoFields from './AStockInfoFields.vue'
import type { AShareRow } from '@/api'

function makeRow(overrides: Partial<AShareRow> = {}): AShareRow {
  return {
    tsCode: '000001.SZ',
    symbol: '000001',
    name: '平安银行',
    market: '主板',
    industry: '银行',
    close: '10.52',
    change: '0.20',
    pctChg: '1.94',
    amount: '123456.78',
    turnoverRate: '1.23',
    volumeRatio: '1.5',
    pe: '5.67',
    peTtm: '5.43',
    pb: '0.62',
    totalMv: '204560000', // 万元 → 20456 亿
    circMv: '204560000',
    tradeDate: '20260618',
    ma5: null, ma30: null, ma60: null, ma120: null, ma240: null,
    bbi: null,
    kdjJ: null, kdjK: null, kdjD: null,
    dif: null, dea: null, macd: null,
    atr14: null, lossAtr14: null, low9: null, high9: null,
    riskRewardRatio: null, stopLossPct: null,
    quoteVolume10: null,
    brick: null, brickDelta: null, brickXg: null,
    amvDif: null, amvDea: null, amvMacd: null,
    ...overrides,
  } as AShareRow
}

function mountFields(row: AShareRow | null) {
  return mount(AStockInfoFields, { props: { row } })
}

describe('AStockInfoFields', () => {
  it('渲染全部 9 个字段行', () => {
    const wrapper = mountFields(makeRow())
    const rows = wrapper.findAllComponents({ name: 'InfoRow' })
    expect(rows.length).toBe(9)
  })

  it('label 含单位', () => {
    const wrapper = mountFields(makeRow())
    const labels = wrapper.findAll('.info-row__label').map((el) => el.text())
    expect(labels).toEqual([
      '市场板块',
      '行业',
      '流通市值(亿)',
      '总市值(亿)',
      '市盈率TTM(倍)',
      '市盈率(倍)',
      '市净率(倍)',
      '换手率(%)',
      '量比(倍)',
    ])
  })

  it('市值走 formatMarketCap（万元 → 万亿/亿）', () => {
    // totalMv=204560000 万 ≥ 1e8 万 → 万亿；circMv=20456 万 ≥ 1e4 万 → 亿
    const wrapper = mountFields(makeRow({ totalMv: '204560000', circMv: '20456' }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    expect(values[2]).toBe('2.05 亿') // circMv=20456 万 → 亿
    expect(values[3]).toBe('2.05 万亿') // totalMv=204560000 万 → 万亿
  })

  it('小市值走 formatMarketCap 显示"亿"', () => {
    const wrapper = mountFields(makeRow({ totalMv: '50000', circMv: '50000' }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    // 50000 万 = 5 亿（toFixed(2)）
    expect(values[2]).toBe('5.00 亿')
  })

  it('PE 走 formatNumber 保留 2 位', () => {
    const wrapper = mountFields(makeRow({ peTtm: '5.431', pe: '5.674' }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    expect(values[4]).toBe('5.43')
    expect(values[5]).toBe('5.67')
  })

  it('量比走 formatVolumeRatio 带"倍"后缀', () => {
    const wrapper = mountFields(makeRow({ volumeRatio: '1.5' }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    expect(values[8]).toBe('1.50倍')
  })

  it('row null → 显示未选择标的空状态', () => {
    const wrapper = mountFields(null)
    expect(wrapper.find('.a-stock-info-fields').exists()).toBe(false)
    expect(wrapper.text()).toContain('未选择标的')
  })

  it('单字段 null → 显示 "-"', () => {
    const wrapper = mountFields(makeRow({ peTtm: null }))
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    expect(values[4]).toBe('-')
  })

  it('totalMv 为 undefined → 显示 "-"（验证 ?? null 规整）', () => {
    const row = makeRow()
    delete (row as Partial<AShareRow>).totalMv
    const wrapper = mountFields(row)
    const values = wrapper.findAll('.info-row__value').map((el) => el.text())
    expect(values[3]).toBe('-')
  })
})
