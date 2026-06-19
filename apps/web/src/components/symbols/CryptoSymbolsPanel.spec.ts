/**
 * CryptoSymbolsPanel：验证套入 SymbolsPanelLayout 后的行为。
 * - title 已删除
 * - split 模式下分栏表格列由 splitColumns 驱动
 * - 精简表格行点击更新 selectedDetailRow
 * - table 模式行点击不再打开 drawer
 * - interval 选择器仍在 header 右侧
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { createPinia, setActivePinia } from 'pinia'

import CryptoSymbolsPanel from './CryptoSymbolsPanel.vue'
import { symbolApi, type SymbolRow } from '@/api'

const VIEW_MODE_KEY = 'symbols_panel_view_mode_crypto'

vi.mock('@/composables/symbols/useSymbolColumnPreferences', () => ({
  useSymbolColumnPreferences: vi.fn(() => ({
    loading: ref(false),
    saving: ref(false),
    scopePreferences: ref([]),
    tableColumns: computed(() => [
      { key: 'symbol', title: '代码' },
      { key: 'name', title: '名称' },
      { key: 'close', title: '现价' },
    ]),
    splitColumns: computed(() => [
      { key: 'symbol', title: '代码' },
      { key: 'name', title: '名称' },
      { key: 'close', title: '现价' },
    ]),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@/composables/symbols/usePanelViewMode', () => ({
  usePanelViewMode: vi.fn((scope: string) => {
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

vi.mock('@/composables/symbols/useWatchlistTagFilter', () => ({
  useWatchlistTagFilter: vi.fn(() => ({
    selectedWatchlistIds: ref([]),
    watchlistOptions: computed(() => []),
    watchlistIds: computed(() => undefined),
    resetWatchlistFilter: vi.fn(),
    ensureWatchlistsLoaded: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@/stores/strategyConditions', () => ({
  useStrategyConditionsStore: vi.fn(() => ({
    conditions: [],
    runStatuses: new Map(),
    fetchConditions: vi.fn().mockResolvedValue(undefined),
    fetchLastRunStatus: vi.fn().mockResolvedValue(undefined),
  })),
}))

const ResizableSplitPaneStub = defineComponent({
  name: 'ResizableSplitPane',
  props: ['leftWidth', 'minWidthPx', 'maxRatio'],
  setup(_, { slots }) {
    return () =>
      h('div', { class: 'resizable-split-pane-stub' }, [
        h('div', { class: 'rsp-left-stub' }, slots.left?.()),
        h('div', { class: 'rsp-right-stub' }, slots.right?.()),
      ])
  },
})

const DataTableStub = defineComponent({
  name: 'DataTableStub',
  props: ['columns', 'data', 'rowProps', 'loading', 'pagination', 'remote'],
  setup(props, { attrs }) {
    return () =>
      h(
        'div',
        { class: 'n-data-table-stub', 'data-testid': attrs['data-testid'] },
        props.data?.map((row: SymbolRow, idx: number) => {
          const rp = props.rowProps ? props.rowProps(row, idx) : {}
          return h('div', { class: 'data-row', 'data-symbol': row.symbol, ...rp }, row.symbol)
        }),
      )
  },
})

const SelectStub = defineComponent({
  name: 'SelectStub',
  props: ['value', 'options'],
  setup(props) {
    return () =>
      h(
        'div',
        {
          class: 'n-select-stub',
          'data-testid': 'interval-select',
          'data-options': JSON.stringify(props.options),
        },
        props.value,
      )
  },
})

function mountPanel() {
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(CryptoSymbolsPanel),
            }),
        })
    },
  })
  return mount(Wrapper, {
    attachTo: document.body,
    global: {
      stubs: {
        CryptoSymbolsFilters: defineComponent({ setup: () => () => h('div', { 'data-testid': 'filters-stub' }) }),
        CryptoSymbolDetailPanel: defineComponent({
          name: 'CryptoSymbolDetailPanel',
          props: ['row', 'interval'],
          setup: () => () => h('div', { class: 'crypto-detail-panel-stub' }),
        }),
        ColumnSettingsDrawer: defineComponent({ setup: () => () => h('div') }),
        ResizableSplitPane: ResizableSplitPaneStub,
        DataTable: DataTableStub,
        Select: SelectStub,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  localStorage.clear()
  vi.spyOn(symbolApi, 'query').mockResolvedValue({ items: [], total: 0 } as never)
  vi.spyOn(symbolApi, 'getKlineColumns').mockResolvedValue([])
})

describe('CryptoSymbolsPanel layout integration', () => {
  it('不再渲染 "加密货币" title', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).not.toContain('加密货币')
  })

  it('使用 scope="crypto" 的 SymbolsPanelLayout', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const layout = wrapper.findComponent({ name: 'SymbolsPanelLayout' })
    expect(layout.exists()).toBe(true)
    expect(layout.props('scope')).toBe('crypto')
  })

  it('header 右侧仍保留 interval 选择器', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const select = wrapper.find('[data-testid="interval-select"]')
    expect(select.exists()).toBe(true)
    expect(JSON.parse(select.attributes('data-options')!)).toEqual([
      { label: '1h', value: '1h' },
      { label: '4h', value: '4h' },
      { label: '1d', value: '1d' },
    ])
  })

  it('split 模式下分栏表格列由 splitColumns 驱动', async () => {
    localStorage.setItem(VIEW_MODE_KEY, 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const splitTable = wrapper
      .findAllComponents({ name: 'DataTableStub' })
      .find(c => c.attributes('data-testid') === 'split-table')

    expect(splitTable).toBeDefined()
    expect(splitTable!.props('columns')).toHaveLength(3)
    expect(splitTable!.props('columns').map((col: { key: string }) => col.key)).toEqual([
      'symbol',
      'name',
      'close',
    ])
  })

  it('split 模式下点击精简表格行更新 selectedDetailRow', async () => {
    localStorage.setItem(VIEW_MODE_KEY, 'split')
    const row: SymbolRow = { symbol: 'BTCUSDT', name: 'Bitcoin', close: 60000 }
    vi.spyOn(symbolApi, 'query').mockResolvedValue({ items: [row], total: 1 } as never)

    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const splitTable = wrapper
      .findAllComponents({ name: 'DataTableStub' })
      .find(c => c.attributes('data-testid') === 'split-table')

    expect(splitTable).toBeDefined()
    const dataRow = splitTable!.find('[data-symbol="BTCUSDT"]')
    expect(dataRow.exists()).toBe(true)

    await dataRow.trigger('click')
    await nextTick()

    const panel = wrapper.findComponent({ name: 'CryptoSymbolsPanel' })
    expect((panel.vm as unknown as { selectedDetailRow: SymbolRow | null }).selectedDetailRow).toEqual(row)

    const detailPanel = wrapper.findComponent({ name: 'CryptoSymbolDetailPanel' })
    expect(detailPanel.props('row')).toEqual(row)
    expect(detailPanel.props('interval')).toBe('1h')
  })

  it('未选中行时 split 模式显示占位提示', async () => {
    localStorage.setItem(VIEW_MODE_KEY, 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const empty = wrapper.find('.empty-detail-placeholder')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('点击左侧股票查看详情')
  })

  it('table 模式下不再渲染详情 drawer', async () => {
    localStorage.setItem(VIEW_MODE_KEY, 'table')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.findComponent({ name: 'CryptoSymbolDetailDrawer' }).exists()).toBe(false)
  })
})
