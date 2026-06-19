/**
 * UsStockDetailPanel：可独立使用的美股详情面板。
 *  - row 变化 → 清空选区并以默认窗口重拉 K 线。
 *  - priceMode 变化 → 沿用当前选区重拉 K 线。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import UsStockDetailPanel from './UsStockDetailPanel.vue'

const { fetchKlineMock } = vi.hoisted(() => ({ fetchKlineMock: vi.fn() }))
vi.mock('./usStockDetailFetcher', () => ({ fetchUsStockKline: fetchKlineMock }))

const KlineChartStub = defineComponent({
  name: 'KlineChart',
  props: { data: { type: Array, default: () => [] }, range: { type: Array, default: null } },
  emits: ['update:range'],
  setup(props) {
    return () => h('div', { class: 'kline-stub', 'data-len': (props.data as unknown[]).length })
  },
})

const ROW_A = { ticker: 'AVGO', name: 'Broadcom', theme: '半导体', stockType: '普通股', tradeDate: '20260101' }
const ROW_B = { ticker: 'NVDA', name: 'NVIDIA', theme: '半导体', stockType: '普通股', tradeDate: '20260102' }

function mountPanel(initialRow = ROW_A, initialPriceMode: 'qfq' | 'raw' = 'qfq') {
  const row = ref(initialRow)
  const priceMode = ref(initialPriceMode)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () =>
                h(UsStockDetailPanel, { row: row.value as never, priceMode: priceMode.value }),
            }),
        })
    },
  })
  const wrapper = mount(Wrapper, {
    attachTo: document.body,
    global: { stubs: { KlineChart: KlineChartStub } },
  })
  return { wrapper, row, priceMode }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchKlineMock.mockResolvedValue([{ open_time: '2026-01-01' }])
})

describe('UsStockDetailPanel 数据加载', () => {
  it('初始 row 存在时以默认窗口拉取 K 线', async () => {
    mountPanel(ROW_A, 'qfq')
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenCalledWith('AVGO', 360, 'qfq', undefined)
  })

  it('row 变化时触发默认窗口重拉', async () => {
    const { row } = mountPanel(ROW_A, 'qfq')
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('AVGO', 360, 'qfq', undefined)

    row.value = ROW_B as never
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('NVDA', 360, 'qfq', undefined)
  })

  it('priceMode 变化时触发重拉（沿用当前选区）', async () => {
    const { wrapper, priceMode } = mountPanel(ROW_A, 'qfq')
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('AVGO', 360, 'qfq', undefined)

    // 先选一个区间
    wrapper
      .findComponent({ name: 'KlineChart' })
      .vm.$emit('update:range', [new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('AVGO', 1000, 'qfq', {
      startDate: '20240105',
      endDate: '20240110',
    })

    priceMode.value = 'raw'
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('AVGO', 1000, 'raw', {
      startDate: '20240105',
      endDate: '20240110',
    })
  })
})
