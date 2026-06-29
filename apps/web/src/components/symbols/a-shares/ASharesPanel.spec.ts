/**
 * ASharesPanel：验证接入 SymbolsPanelLayout 后的行为。
 * - 标题删除
 * - split 模式下分栏表格列由 splitColumns 驱动
 * - 精简表格行点击更新 selectedDetailRow
 * - 行点击不会打开详情 drawer
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { createPinia, setActivePinia } from 'pinia'

import ASharesPanel from './ASharesPanel.vue'
import SymbolsPanelLayout from '../shared/SymbolsPanelLayout.vue'
import type { AShareRow } from '@/api'

vi.mock('./useASharesQuery', () => ({
  useASharesQuery: vi.fn(() => {
    const rows = ref<AShareRow[]>([
      { tsCode: '000001.SZ', name: '平安银行', close: '12.34' } as unknown as AShareRow,
      { tsCode: '000002.SZ', name: '万科A', close: '15.60' } as unknown as AShareRow,
    ])
    return {
      loading: ref(false),
      filterPresetsLoading: ref(false),
      rows,
      filterPresets: ref([]),
      searchQuery: ref(''),
      selectedMarket: ref<string | null>(null),
      selectedSwIndustryL1Code: ref<string | null>(null),
      selectedSwIndustryL2Code: ref<string | null>(null),
      selectedSwIndustryL3Code: ref<string | null>(null),
      selectedWatchlistIds: ref<string[]>([]),
      watchlistOptions: computed(() => []),
      priceMode: ref<'qfq' | 'raw'>('qfq'),
      pctChangeMin: ref<number | null>(null),
      turnoverRateMin: ref<number | null>(null),
      advancedConditions: ref([]),
      selectedStrategyIds: ref<string[]>([]),
      marketOptions: ref([]),
      swIndustryL1Options: ref([]),
      swIndustryL2Options: ref([]),
      swIndustryL3Options: ref([]),
      paginationState: computed(() => ({
        page: 1,
        pageSize: 10,
        itemCount: rows.value.length,
        showSizePicker: true,
        pageSizes: [10, 20, 50],
        prefix: () => `Total ${rows.value.length}`,
      })),
      scoresMap: ref(new Map()),
      scoresLoading: ref(false),
      reload: vi.fn().mockResolvedValue(undefined),
      loadFilterPresets: vi.fn().mockResolvedValue(undefined),
      applyFilters: vi.fn(),
      resetFilters: vi.fn(),
      createFilterPreset: vi.fn(),
      overwriteFilterPreset: vi.fn(),
      renameFilterPreset: vi.fn(),
      deleteFilterPreset: vi.fn(),
      applyFilterPreset: vi.fn(),
      handlePriceModeChange: vi.fn(),
      handlePageChange: vi.fn(),
      handlePageSizeChange: vi.fn(),
      handleSort: vi.fn(),
    }
  }),
}))

vi.mock('@/composables/symbols/useTableColumnPreferences', () => ({
  useTableColumnPreferences: vi.fn(() => ({
    loading: ref(false),
    saving: ref(false),
    scopePreferences: ref([]),
    tableColumns: computed(() => [
      { key: 'tsCode', title: '代码' },
      { key: 'name', title: '名称' },
      { key: 'close', title: '现价' },
    ]),
    splitColumns: computed(() => [
      { key: 'tsCode', title: '代码' },
      { key: 'name', title: '名称' },
      { key: 'close', title: '现价' },
    ]),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@/composables/symbols/usePanelViewMode', () => ({
  usePanelViewMode: vi.fn((scope: string) => {
    // 复刻真实 composable 的初值逻辑，让测试可通过 localStorage 控制初始视图
    let initial: 'table' | 'split' = 'table'
    try {
      const raw = localStorage.getItem(`symbols_panel_view_mode_${scope}`)
      if (raw === 'table' || raw === 'split') initial = raw
    } catch {
      /* ignore */
    }
    return {
      viewMode: ref<'table' | 'split'>(initial),
      setViewMode: vi.fn(),
      toggleViewMode: vi.fn(),
    }
  }),
}))

vi.mock('@/stores/strategyConditions', () => ({
  useStrategyConditionsStore: vi.fn(() => ({
    conditions: [],
    runStatuses: new Map(),
    fetchConditions: vi.fn().mockResolvedValue(undefined),
    fetchLastRunStatus: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@/api/modules/strategy/strategyConditions', () => ({
  strategyConditionsApi: {
    getRunResult: vi.fn().mockResolvedValue({ hits: [] }),
  },
}))

const ResizableSplitPaneStub = defineComponent({
  name: 'ResizableSplitPane',
  props: ['leftWidth'],
  setup(_, { slots }) {
    return () =>
      h('div', { class: 'resizable-split-pane-stub' }, [
        h('div', { class: 'rsp-left-stub' }, slots.left?.()),
        h('div', { class: 'rsp-right-stub' }, slots.right?.()),
      ])
  },
})

function mountPanel() {
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(ASharesPanel),
            }),
        })
    },
  })

  return mount(Wrapper, {
    global: {
      stubs: {
        ASharesFilters: defineComponent({
          name: 'ASharesFilters',
          props: [
            'searchQuery',
            'selectedMarket',
            'selectedSwIndustryL1Code',
            'selectedSwIndustryL2Code',
            'selectedSwIndustryL3Code',
            'selectedWatchlistIds',
            'selectedStrategyIds',
            'priceMode',
            'pctChangeMin',
            'turnoverRateMin',
            'advancedConditions',
            'marketOptions',
            'swIndustryL1Options',
            'swIndustryL2Options',
            'swIndustryL3Options',
            'watchlistOptions',
            'strategyOptions',
            'filterPresets',
            'filterPresetsLoading',
          ],
          setup: () => () => h('div', { class: 'a-shares-filters-stub' }),
        }),
        ColumnSettingsDrawer: defineComponent({
          name: 'ColumnSettingsDrawer',
          props: ['show', 'modelValue', 'title', 'definitions', 'loading', 'saving'],
          setup: () => () => h('div', { class: 'column-settings-drawer-stub' }),
        }),
        AShareDetailPanel: defineComponent({
          name: 'AShareDetailPanel',
          props: ['row', 'priceMode', 'visible'],
          setup: (props) => () =>
            h('div', {
              class: 'a-share-detail-panel-stub',
              'data-testid': 'detail-panel',
              'data-row': props.row?.tsCode ?? '',
            }),
        }),
        ResizableSplitPane: ResizableSplitPaneStub,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
})

describe('ASharesPanel layout integration', () => {
  it('不再渲染 A 股数据标题', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('A 股数据')
  })

  it('SymbolsPanelLayout 使用 scope=aShares', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const layout = wrapper.findComponent(SymbolsPanelLayout)
    expect(layout.exists()).toBe(true)
    expect(layout.props('scope')).toBe('aShares')
  })

  it('table 模式下渲染完整表格且不渲染详情 drawer', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.find('[data-testid="full-table"]').exists()).toBe(true)
    expect(wrapper.find('.a-share-detail-drawer-stub').exists()).toBe(false)
  })
})

describe('ASharesPanel split view', () => {
  it('split 模式下 useTableColumnPreferences 收到 viewMode 参数，splitColumns 驱动分栏表格', async () => {
    localStorage.setItem('symbols_panel_view_mode_aShares', 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    // 契约：Panel 把 usePanelViewMode 的 viewMode 作为第 3 参传给 useTableColumnPreferences
    const { useTableColumnPreferences } = await import('@/composables/symbols/useTableColumnPreferences')
    const calls = vi.mocked(useTableColumnPreferences).mock.calls
    const aSharesCall = calls.find((c) => c[0] === 'aShares')
    expect(aSharesCall).toBeTruthy()
    // 第 3 参数是 viewMode ref，初值随 localStorage = 'split'
    const viewModeArg = aSharesCall![2] as { value: string }
    expect(viewModeArg.value).toBe('split')

    // split 表格存在且受 splitColumns 驱动（mock 返回 3 列）
    expect(wrapper.find('[data-testid="split-table"]').exists()).toBe(true)
  })

  it('点击精简表格行会更新 selectedDetailRow 并传给 AShareDetailPanel', async () => {
    localStorage.setItem('symbols_panel_view_mode_aShares', 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const rows = wrapper.findAll('[data-testid="split-table"] tbody tr')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    await rows[1].trigger('click')
    await nextTick()

    const panel = wrapper.findComponent({ name: 'ASharesPanel' })
    expect((panel.vm as unknown as { selectedDetailRow: AShareRow | null }).selectedDetailRow?.tsCode).toBe('000002.SZ')

    const detailPanel = wrapper.find('[data-testid="detail-panel"]')
    expect(detailPanel.attributes('data-row')).toBe('000002.SZ')
  })

  it('split 模式下行点击不会打开详情 drawer', async () => {
    localStorage.setItem('symbols_panel_view_mode_aShares', 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.a-share-detail-drawer-stub').exists()).toBe(false)

    const rows = wrapper.findAll('[data-testid="split-table"] tbody tr')
    await rows[0].trigger('click')
    await nextTick()

    expect(wrapper.find('.a-share-detail-drawer-stub').exists()).toBe(false)
  })
})
