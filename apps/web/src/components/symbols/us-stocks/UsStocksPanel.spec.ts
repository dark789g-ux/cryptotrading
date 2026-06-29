/**
 * UsStocksPanel：接入 SymbolsPanelLayout 后的单测。
 * - 删除美股 title
 * - split 模式下 viewMode 传给 useTableColumnPreferences，splitColumns 驱动分栏表格
 * - split 模式下点击精简表格行更新 selectedDetailRow
 * - table 模式下不再打开详情 drawer
 * - 同步 / 标的管理按钮仍在 header 右侧
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import UsStocksPanel from './UsStocksPanel.vue'
import type { UsStockRow } from '@/api'

const reloadMock = vi.fn()
const applyFiltersMock = vi.fn()
const resetFiltersMock = vi.fn()
const handlePriceModeChangeMock = vi.fn()
const handlePageChangeMock = vi.fn()
const handlePageSizeChangeMock = vi.fn()
const handleSortMock = vi.fn()

const mockRows = ref<UsStockRow[]>([
  { ticker: 'AAPL', name: 'Apple', close: '150.00', theme: '科技', stockType: '普通股', tradeDate: '20260101' } as UsStockRow,
  { ticker: 'NVDA', name: 'NVIDIA', close: '300.00', theme: '半导体', stockType: '普通股', tradeDate: '20260101' } as UsStockRow,
])
const mockLoading = ref(false)
const mockPriceMode = ref<'qfq' | 'raw'>('qfq')

vi.mock('@/components/symbols/us-stocks/useUsStocksQuery', () => ({
  useUsStocksQuery: vi.fn(() => ({
    loading: mockLoading,
    rows: mockRows,
    searchQuery: ref(''),
    selectedTheme: ref(null),
    selectedStockType: ref(null),
    priceMode: mockPriceMode,
    pctChangeMin: ref(null),
    advancedConditions: ref([]),
    themeOptions: ref([]),
    stockTypeOptions: ref([]),
    paginationState: computed(() => ({
      page: 1,
      pageSize: 10,
      itemCount: mockRows.value.length,
      showSizePicker: true,
      pageSizes: [10, 20, 50],
      prefix: () => `Total ${mockRows.value.length}`,
    })),
    reload: reloadMock,
    applyFilters: applyFiltersMock,
    resetFilters: resetFiltersMock,
    handlePriceModeChange: handlePriceModeChangeMock,
    handlePageChange: handlePageChangeMock,
    handlePageSizeChange: handlePageSizeChangeMock,
    handleSort: handleSortMock,
  })),
}))

vi.mock('@/composables/symbols/useTableColumnPreferences', () => ({
  useTableColumnPreferences: vi.fn(() => ({
    loading: ref(false),
    saving: ref(false),
    scopePreferences: ref([]),
    tableColumns: computed(() => [
      { title: '代码', key: 'ticker', render: (row: UsStockRow) => row.ticker },
      { title: '名称', key: 'name', render: (row: UsStockRow) => row.name },
      { title: '主题', key: 'theme', render: (row: UsStockRow) => row.theme },
    ]),
    splitColumns: computed(() => [
      { title: '代码', key: 'ticker', render: (row: UsStockRow) => row.ticker },
      { title: '名称', key: 'name', render: (row: UsStockRow) => row.name },
      { title: '主题', key: 'theme', render: (row: UsStockRow) => row.theme },
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

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api')
  return {
    ...actual,
    usStocksApi: {
      ...actual.usStocksApi,
      sync: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
    },
  }
})

const ResizableSplitPaneStub = defineComponent({
  name: 'ResizableSplitPane',
  props: ['leftWidth', 'minWidthPx', 'maxRatio'],
  emits: ['update:leftWidth'],
  render() {
    return h('div', { class: 'resizable-split-pane-stub' }, [
      h('div', { class: 'rsp-left-stub' }, this.$slots.left?.()),
      h('div', { class: 'rsp-right-stub' }, this.$slots.right?.()),
    ])
  },
})

const UsStockDetailPanelStub = defineComponent({
  name: 'UsStockDetailPanel',
  props: ['row', 'priceMode'],
  setup: () => () => h('div', { class: 'us-stock-detail-panel-stub' }, 'detail-panel'),
})

const UsStocksFiltersStub = defineComponent({
  name: 'UsStocksFilters',
  setup: () => () => h('div', { class: 'us-stocks-filters-stub' }, 'filters'),
})

const ColumnSettingsDrawerStub = defineComponent({
  name: 'ColumnSettingsDrawer',
  props: ['show', 'modelValue', 'title', 'definitions', 'loading', 'saving'],
  emits: ['update:show', 'update:modelValue', 'save'],
  setup: () => () => h('div', { class: 'column-settings-drawer-stub' }, 'column-settings'),
})

const UsSymbolManageModalStub = defineComponent({
  name: 'UsSymbolManageModal',
  props: ['show'],
  emits: ['update:show', 'saved'],
  setup: () => () => h('div', { class: 'us-symbol-manage-modal-stub' }, 'symbol-manage'),
})

const UsSyncProgressModalStub = defineComponent({
  name: 'UsSyncProgressModal',
  props: ['show', 'jobId'],
  emits: ['update:show', 'done'],
  setup: () => () => h('div', { class: 'us-sync-progress-modal-stub' }, 'sync-progress'),
})

function mountPanel() {
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(UsStocksPanel),
            }),
        })
    },
  })
  return mount(Wrapper, {
    attachTo: document.body,
    global: {
      stubs: {
        ResizableSplitPane: ResizableSplitPaneStub,
        UsStockDetailPanel: UsStockDetailPanelStub,
        UsStocksFilters: UsStocksFiltersStub,
        ColumnSettingsDrawer: ColumnSettingsDrawerStub,
        UsSymbolManageModal: UsSymbolManageModalStub,
        UsSyncProgressModal: UsSyncProgressModalStub,
      },
    },
  })
}

const VIEW_MODE_KEY = 'symbols_panel_view_mode_usStocks'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mockRows.value = [
    { ticker: 'AAPL', name: 'Apple', close: '150.00', theme: '科技', stockType: '普通股', tradeDate: '20260101' } as UsStockRow,
    { ticker: 'NVDA', name: 'NVIDIA', close: '300.00', theme: '半导体', stockType: '普通股', tradeDate: '20260101' } as UsStockRow,
  ]
  mockLoading.value = false
  mockPriceMode.value = 'qfq'
})

describe('UsStocksPanel', () => {
  it('不渲染美股 title', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('美股')
  })

  it('table 模式下渲染完整表格，不渲染详情面板', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.us-stocks-filters-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid="full-table"]').exists()).toBe(true)
    expect(wrapper.findComponent(UsStockDetailPanelStub).exists()).toBe(false)
  })

  it('split 模式下 useTableColumnPreferences 收到 viewMode，splitColumns 驱动分栏表格', async () => {
    localStorage.setItem(VIEW_MODE_KEY, 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    // 契约：Panel 把 usePanelViewMode 的 viewMode 作为第 3 参传给 useTableColumnPreferences
    const { useTableColumnPreferences } = await import('@/composables/symbols/useTableColumnPreferences')
    const calls = vi.mocked(useTableColumnPreferences).mock.calls
    const usCall = calls.find((c) => c[0] === 'usStocks')
    expect(usCall).toBeTruthy()
    const viewModeArg = usCall![2] as { value: string }
    expect(viewModeArg.value).toBe('split')

    expect(wrapper.find('[data-testid="split-table"]').exists()).toBe(true)
  })

  it('split 模式下未选中股票时渲染 empty-detail slot', async () => {
    localStorage.setItem(VIEW_MODE_KEY, 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.rsp-right-stub').text()).toContain('点击左侧股票查看详情')
    expect(wrapper.findComponent(UsStockDetailPanelStub).exists()).toBe(false)
  })

  it('split 模式下点击精简表格行更新 selectedDetailRow 并渲染详情面板', async () => {
    localStorage.setItem(VIEW_MODE_KEY, 'split')
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const rows = wrapper.findAll('[data-testid="split-table"] .n-data-table-tbody .n-data-table-tr')
    expect(rows.length).toBeGreaterThanOrEqual(2)

    await rows[1].trigger('click')
    await nextTick()

    const detailPanel = wrapper.findComponent(UsStockDetailPanelStub)
    expect(detailPanel.exists()).toBe(true)
    expect(detailPanel.props('row')).toEqual(expect.objectContaining({ ticker: 'NVDA', name: 'NVIDIA' }))
    expect(detailPanel.props('priceMode')).toBe('qfq')
  })

  it('table 模式下点击完整表格行不更新 selectedDetailRow，不渲染详情面板', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const aaplRow = wrapper.find('[data-testid="full-table"] .n-data-table-tbody .n-data-table-tr')
    expect(aaplRow.exists()).toBe(true)

    await aaplRow.trigger('click')
    await nextTick()

    expect(wrapper.findComponent(UsStockDetailPanelStub).exists()).toBe(false)
  })

  it('同步和标的管理按钮在 header 右侧', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const headerActions = wrapper.find('.header-actions')
    expect(headerActions.exists()).toBe(true)
    expect(headerActions.text()).toContain('同步')
    expect(headerActions.text()).toContain('标的管理')
  })

  it('SymbolsPanelLayout 收到 scope="usStocks"', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const layout = wrapper.findComponent({ name: 'SymbolsPanelLayout' })
    expect(layout.exists()).toBe(true)
    expect(layout.props('scope')).toBe('usStocks')
  })
})
