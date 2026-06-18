/**
 * CryptoSymbolsPanel：聚焦 KlineChart recalcIndicators 回调接入。
 *  - 打开图表后修改 KDJ 参数 → POST /api/klines/:symbol/:interval/recalc。
 *  - 成功后替换 klineData；失败后 message.error 并继续抛错，让 KlineChart 回滚参数。
 * 其余组合逻辑（表格、筛选、列偏好等）通过 mock 隔离。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import { createPinia, setActivePinia } from 'pinia'

import CryptoSymbolsPanel from './CryptoSymbolsPanel.vue'
import { klinesApi, symbolApi } from '@/api'

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

const KlineChartStub = defineComponent({
  name: 'KlineChart',
  props: {
    data: { type: Array, default: () => [] },
    range: { type: Array, default: null },
    recalcIndicators: { type: Function, default: null },
  },
  emits: ['update:range'],
  setup(props) {
    return () => h('div', { class: 'kline-stub', 'data-len': (props.data as unknown[]).length })
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
        KlineChart: KlineChartStub,
        NumericConditionFilter: defineComponent({ setup: () => () => h('div') }),
        ColumnSettingsDrawer: defineComponent({ setup: () => () => h('div') }),
        NCard: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
        NDataTable: defineComponent({ setup: () => () => h('div') }),
        NDrawer: defineComponent({ setup: (_, { slots }) => () => h('div', { style: 'display:none' }, slots.default?.()) }),
        NDrawerContent: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(symbolApi, 'query').mockResolvedValue({ items: [], total: 0 } as never)
  vi.spyOn(symbolApi, 'getKlineColumns').mockResolvedValue([])
  vi.spyOn(klinesApi, 'getKlines').mockResolvedValue([{ open_time: '2026-01-01' } as never])
})

describe('CryptoSymbolsPanel recalcIndicators', () => {
  it('KDJ 参数变更成功后替换 klineData', async () => {
    const recalcSpy = vi.spyOn(klinesApi, 'recalcKlines').mockResolvedValue([
      { open_time: '2026-01-02' } as never,
    ])

    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const panel = wrapper.findComponent({ name: 'CryptoSymbolsPanel' })
    const vm = panel.vm as unknown as {
      openChart: (symbol: string) => Promise<void>
      recalcKdjIndicators: (params?: { KDJ?: { n: number; m1: number; m2: number } }) => Promise<void>
    }

    await vm.openChart('BTCUSDT')
    await flushPromises()
    await nextTick()

    expect(vi.mocked(klinesApi.getKlines)).toHaveBeenLastCalledWith('BTCUSDT', '1h')

    await vm.recalcKdjIndicators({ KDJ: { n: 5, m1: 3, m2: 2 } })
    await flushPromises()
    await nextTick()

    expect(recalcSpy).toHaveBeenLastCalledWith('BTCUSDT', '1h', {
      kdjParams: { n: 5, m1: 3, m2: 2 },
    })

    const kline = wrapper.findComponent({ name: 'KlineChart' })
    expect((kline.vm as unknown as { data: unknown[] }).data).toHaveLength(1)
    expect((kline.vm as unknown as { data: Array<{ open_time: string }> }).data[0].open_time).toBe('2026-01-02')

    recalcSpy.mockRestore()
  })

  it('KDJ 参数变更失败时 message.error 并继续抛错', async () => {
    const recalcSpy = vi.spyOn(klinesApi, 'recalcKlines').mockRejectedValue(new Error('recalc failed'))

    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()

    const panel = wrapper.findComponent({ name: 'CryptoSymbolsPanel' })
    const vm = panel.vm as unknown as {
      openChart: (symbol: string) => Promise<void>
      recalcKdjIndicators: (params?: { KDJ?: { n: number; m1: number; m2: number } }) => Promise<void>
    }

    await vm.openChart('BTCUSDT')
    await flushPromises()
    await nextTick()

    await expect(vm.recalcKdjIndicators({ KDJ: { n: 5, m1: 3, m2: 2 } })).rejects.toThrow('recalc failed')
    expect(recalcSpy).toHaveBeenCalledTimes(1)

    recalcSpy.mockRestore()
  })
})
