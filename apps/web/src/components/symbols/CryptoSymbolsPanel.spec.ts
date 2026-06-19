/**
 * CryptoSymbolsPanel：聚焦 openChart 行为。
 * 详情 drawer 已抽出到 CryptoSymbolDetailDrawer/CryptoSymbolDetailPanel，本文件只覆盖父面板状态切换。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { createPinia, setActivePinia } from 'pinia'

import CryptoSymbolsPanel from './CryptoSymbolsPanel.vue'
import { symbolApi, type SymbolRow } from '@/api'

vi.mock('@/composables/symbols/useSymbolColumnPreferences', () => ({
  useSymbolColumnPreferences: vi.fn(() => ({
    loading: ref(false),
    saving: ref(false),
    scopePreferences: ref([]),
    columns: computed(() => []),
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  })),
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
        CryptoSymbolsFilters: defineComponent({ setup: () => () => h('div') }),
        CryptoSymbolDetailDrawer: defineComponent({
          name: 'CryptoSymbolDetailDrawer',
          props: ['show', 'row', 'interval'],
          setup: () => () => h('div', { class: 'crypto-detail-drawer-stub' }),
        }),
        ColumnSettingsDrawer: defineComponent({ setup: () => () => h('div') }),
        NCard: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
        NDataTable: defineComponent({ setup: () => () => h('div') }),
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(symbolApi, 'query').mockResolvedValue({ items: [], total: 0 } as never)
  vi.spyOn(symbolApi, 'getKlineColumns').mockResolvedValue([])
})

describe('CryptoSymbolsPanel openChart', () => {
  it('传入 row 后打开 drawer 并传递 row 与 interval', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const panel = wrapper.findComponent({ name: 'CryptoSymbolsPanel' })
    const vm = panel.vm as unknown as { openChart: (row: SymbolRow) => void }
    const row: SymbolRow = { symbol: 'BTCUSDT', name: 'Bitcoin' }
    vm.openChart(row)
    await nextTick()

    const drawer = wrapper.findComponent({ name: 'CryptoSymbolDetailDrawer' })
    expect(drawer.props('show')).toBe(true)
    expect(drawer.props('row')).toEqual(row)
    expect(drawer.props('interval')).toBe('1h')
  })
})
