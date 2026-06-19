/**
 * InfoRow：单行展示组件单测（K 线右侧信息面板字段渲染）。
 * - 渲染 label + value
 * - trend 着色映射：up → trend-up，down → trend-down，未传 / '' → 无 trend class
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

import InfoRow from './InfoRow.vue'

describe('InfoRow', () => {
  it('渲染 label 与 value', () => {
    const wrapper = mount(InfoRow, {
      props: { label: '流通市值(亿)', value: '1234.56' },
    })

    expect(wrapper.find('.info-row__label').text()).toBe('流通市值(亿)')
    expect(wrapper.find('.info-row__value').text()).toBe('1234.56')
  })

  it('trend="trend-up" → value span 带 trend-up class', () => {
    const wrapper = mount(InfoRow, {
      props: { label: '涨跌幅', value: '+3.21%', trend: 'trend-up' },
    })

    const value = wrapper.find('.info-row__value')
    expect(value.classes()).toContain('trend-up')
    expect(value.classes()).not.toContain('trend-down')
  })

  it('trend="trend-down" → value span 带 trend-down class', () => {
    const wrapper = mount(InfoRow, {
      props: { label: '涨跌幅', value: '-1.08%', trend: 'trend-down' },
    })

    const value = wrapper.find('.info-row__value')
    expect(value.classes()).toContain('trend-down')
    expect(value.classes()).not.toContain('trend-up')
  })

  it('trend 未传 → value span 无 trend class', () => {
    const wrapper = mount(InfoRow, {
      props: { label: '总股本', value: '5.2亿' },
    })

    const value = wrapper.find('.info-row__value')
    expect(value.classes()).not.toContain('trend-up')
    expect(value.classes()).not.toContain('trend-down')
  })

  it('trend="" → value span 无 trend class', () => {
    const wrapper = mount(InfoRow, {
      props: { label: '换手率', value: '0.85%', trend: '' },
    })

    const value = wrapper.find('.info-row__value')
    expect(value.classes()).not.toContain('trend-up')
    expect(value.classes()).not.toContain('trend-down')
  })
})
