/**
 * CryptoSymbolsFilters：props / emits 对齐测试。
 *  - 各 v-model 字段（searchQuery、selectedWatchlistIds、selectedStrategyIds、conditions）正确回传。
 *  - Apply / Reset 事件正确触发。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { NButton, NInput, NSelect, NTag } from 'naive-ui'

import CryptoSymbolsFilters from './CryptoSymbolsFilters.vue'
import type { NumericCondition } from '../../common/numericConditionFilterTypes'

const NumericConditionFilterStub = defineComponent({
  name: 'NumericConditionFilter',
  props: {
    conditions: { type: Array, default: () => [] },
    fieldOptions: { type: Array, default: () => [] },
    title: { type: String, default: '' },
    buttonLabel: { type: String, default: '' },
    description: { type: String, default: '' },
    emptyDescription: { type: String, default: '' },
  },
  emits: ['update:conditions'],
  setup(props, { emit }) {
    return () =>
      h('div', {
        class: 'numeric-condition-filter-stub',
        'data-conditions': JSON.stringify(props.conditions),
        onClick: () => {
          const next = [...(props.conditions as NumericCondition[]), {
            field: 'close',
            op: 'gt',
            valueType: 'number',
            value: 100,
          } as NumericCondition]
          emit('update:conditions', next)
        },
      })
  },
})

const baseProps = {
  searchQuery: '',
  selectedWatchlistIds: [] as string[],
  selectedStrategyIds: [] as string[],
  conditions: [] as NumericCondition[],
  watchlistOptions: [
    { label: '自选1', value: 'wl-1' },
    { label: '自选2', value: 'wl-2' },
  ],
  strategyOptions: [
    { label: '策略A', value: 'st-1' },
    { label: '策略B', value: 'st-2' },
  ],
  fieldOptions: [{ label: '收盘价', value: 'close' }],
}

function mountFilters(propsOverrides: Partial<typeof baseProps> = {}) {
  return mount(CryptoSymbolsFilters, {
    props: { ...baseProps, ...propsOverrides },
    global: {
      stubs: {
        NumericConditionFilter: NumericConditionFilterStub,
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CryptoSymbolsFilters props / emits', () => {
  it('渲染传入的搜索词', async () => {
    const wrapper = mountFilters({ searchQuery: 'BTC' })
    await nextTick()

    const input = wrapper.find('input')
    expect(input.element.value).toBe('BTC')
  })

  it('搜索输入触发 update:searchQuery，回车触发 apply', async () => {
    const wrapper = mountFilters()

    const input = wrapper.findComponent(NInput)
    await input.vm.$emit('update:value', 'ETH')

    expect(wrapper.emitted('update:searchQuery')).toHaveLength(1)
    expect(wrapper.emitted('update:searchQuery')![0]).toEqual(['ETH'])
    expect(wrapper.emitted('apply')).toBeUndefined()

    await input.vm.$emit('keyup', { key: 'Enter' })
    expect(wrapper.emitted('apply')).toHaveLength(1)
  })

  it('watchlist 变更只触发 update:selectedWatchlistIds，不自动 apply', async () => {
    const wrapper = mountFilters()

    const selects = wrapper.findAllComponents(NSelect)
    await selects[0].vm.$emit('update:value', ['wl-1'])

    expect(wrapper.emitted('update:selectedWatchlistIds')).toHaveLength(1)
    expect(wrapper.emitted('update:selectedWatchlistIds')![0]).toEqual([['wl-1']])
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('strategy 变更只触发 update:selectedStrategyIds，不自动 apply', async () => {
    const wrapper = mountFilters()

    const selects = wrapper.findAllComponents(NSelect)
    await selects[1].vm.$emit('update:value', ['st-2'])

    expect(wrapper.emitted('update:selectedStrategyIds')).toHaveLength(1)
    expect(wrapper.emitted('update:selectedStrategyIds')![0]).toEqual([['st-2']])
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('NumericConditionFilter 变更触发 update:conditions', async () => {
    const wrapper = mountFilters()

    const stub = wrapper.findComponent(NumericConditionFilterStub)
    await stub.trigger('click')

    expect(wrapper.emitted('update:conditions')).toHaveLength(1)
    expect(wrapper.emitted('update:conditions')![0]).toEqual([
      [{ field: 'close', op: 'gt', valueType: 'number', value: 100 }],
    ])
  })

  it('条件 tag 渲染并可关闭，关闭时只更新 conditions，不自动 apply', async () => {
    const wrapper = mountFilters({
      conditions: [
        { field: 'close', op: 'gt', valueType: 'number', value: 100 },
        { field: 'volume', op: 'gte', valueType: 'number', value: 1000 },
      ],
    })
    await nextTick()

    const tags = wrapper.findAllComponents(NTag)
    expect(tags).toHaveLength(2)

    await tags[0].vm.$emit('close')

    expect(wrapper.emitted('update:conditions')).toHaveLength(1)
    expect(wrapper.emitted('update:conditions')![0]).toEqual([
      [{ field: 'volume', op: 'gte', valueType: 'number', value: 1000 }],
    ])
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('Apply 按钮触发 apply 事件', async () => {
    const wrapper = mountFilters()

    const buttons = wrapper.findAllComponents(NButton)
    const applyButton = buttons.find(btn => btn.text() === 'Apply')
    expect(applyButton).toBeDefined()
    await applyButton!.vm.$emit('click')

    expect(wrapper.emitted('apply')).toHaveLength(1)
  })

  it('Reset 按钮触发 reset 事件', async () => {
    const wrapper = mountFilters()

    const buttons = wrapper.findAllComponents(NButton)
    const resetButton = buttons.find(btn => btn.text() === 'Reset')
    expect(resetButton).toBeDefined()
    await resetButton!.vm.$emit('click')

    expect(wrapper.emitted('reset')).toHaveLength(1)
  })
})
