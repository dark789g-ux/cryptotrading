/**
 * UsStocksFilters：列设置按钮 emit 测试。
 *  - 点击「列设置」按钮触发 update:showColumnSettings(true)。
 *
 * 仅聚焦本任务契约（filters 单向 emit 通知 Panel 打开 ColumnSettingsDrawer），
 * 其余 props/emits 对齐测试由各功能模块自己的覆盖。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { NButton } from 'naive-ui'

import UsStocksFilters from './UsStocksFilters.vue'

const NumericConditionFilterStub = defineComponent({
  name: 'NumericConditionFilter',
  setup() {
    return () => h('div', { class: 'numeric-condition-filter-stub' })
  },
})

const baseProps = {
  searchQuery: '',
  selectedTheme: null,
  selectedStockType: null,
  priceMode: 'qfq' as const,
  pctChangeMin: null,
  advancedConditions: [],
  themeOptions: [],
  stockTypeOptions: [],
}

function mountFilters() {
  return mount(UsStocksFilters, {
    props: baseProps,
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

describe('UsStocksFilters 列设置按钮', () => {
  it('点击 列设置 按钮触发 update:showColumnSettings(true)', async () => {
    const wrapper = mountFilters()

    const buttons = wrapper.findAllComponents(NButton)
    const columnSettingsButton = buttons.find(btn => btn.text() === '列设置')
    expect(columnSettingsButton).toBeDefined()
    await columnSettingsButton!.vm.$emit('click')

    expect(wrapper.emitted('update:showColumnSettings')).toHaveLength(1)
    expect(wrapper.emitted('update:showColumnSettings')![0]).toEqual([true])
  })
})
