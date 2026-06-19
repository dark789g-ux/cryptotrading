/**
 * CryptoSymbolDetailPanel：row/interval 变化触发 K 线重拉，recalcIndicators 回调接入。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import CryptoSymbolDetailPanel from './CryptoSymbolDetailPanel.vue'
import { klinesApi } from '@/api'

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

function mountPanel(initialProps: {
  row: { symbol: string; name?: string }
  interval: '1h' | '4h' | '1d'
}) {
  const row = ref(initialProps.row)
  const interval = ref(initialProps.interval)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () =>
                h(CryptoSymbolDetailPanel, { row: row.value, interval: interval.value }),
            }),
        })
    },
  })
  const wrapper = mount(Wrapper, {
    attachTo: document.body,
    global: { stubs: { KlineChart: KlineChartStub } },
  })
  return { wrapper, row, interval }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(klinesApi, 'getKlines').mockResolvedValue([{ open_time: '2026-01-01' } as never])
})

describe('CryptoSymbolDetailPanel data loading', () => {
  it('row.symbol 变化时重拉 K 线', async () => {
    const { row } = mountPanel({ row: { symbol: 'BTCUSDT', name: 'Bitcoin' }, interval: '1h' })
    await flushPromises()
    await nextTick()
    expect(klinesApi.getKlines).toHaveBeenLastCalledWith('BTCUSDT', '1h')

    row.value = { symbol: 'ETHUSDT', name: 'Ethereum' }
    await flushPromises()
    await nextTick()
    expect(klinesApi.getKlines).toHaveBeenLastCalledWith('ETHUSDT', '1h')
  })

  it('interval 变化时重拉 K 线', async () => {
    const { interval } = mountPanel({ row: { symbol: 'BTCUSDT', name: 'Bitcoin' }, interval: '1h' })
    await flushPromises()
    await nextTick()
    expect(klinesApi.getKlines).toHaveBeenLastCalledWith('BTCUSDT', '1h')

    interval.value = '4h'
    await flushPromises()
    await nextTick()
    expect(klinesApi.getKlines).toHaveBeenLastCalledWith('BTCUSDT', '4h')
  })
})

describe('CryptoSymbolDetailPanel recalcIndicators', () => {
  it('KDJ 参数变更成功后替换 klineData', async () => {
    const recalcSpy = vi.spyOn(klinesApi, 'recalcKlines').mockResolvedValue([
      { open_time: '2026-01-02' } as never,
    ])

    const { wrapper } = mountPanel({ row: { symbol: 'BTCUSDT', name: 'Bitcoin' }, interval: '1h' })
    await flushPromises()
    await nextTick()

    const kline = wrapper.findComponent({ name: 'KlineChart' })
    const recalc = (kline.vm as unknown as { recalcIndicators?: (params?: unknown) => Promise<void> }).recalcIndicators
    expect(recalc).toBeTypeOf('function')

    await recalc?.({ KDJ: { n: 5, m1: 3, m2: 2 } })
    await flushPromises()
    await nextTick()

    expect(recalcSpy).toHaveBeenLastCalledWith('BTCUSDT', '1h', {
      kdjParams: { n: 5, m1: 3, m2: 2 },
    })
    expect((kline.vm as unknown as { data: unknown[] }).data).toHaveLength(1)
    expect(
      (kline.vm as unknown as { data: Array<{ open_time: string }> }).data[0].open_time,
    ).toBe('2026-01-02')

    recalcSpy.mockRestore()
  })

  it('KDJ 参数变更失败时抛错', async () => {
    const recalcSpy = vi.spyOn(klinesApi, 'recalcKlines').mockRejectedValue(new Error('recalc failed'))

    const { wrapper } = mountPanel({ row: { symbol: 'BTCUSDT', name: 'Bitcoin' }, interval: '1h' })
    await flushPromises()
    await nextTick()

    const kline = wrapper.findComponent({ name: 'KlineChart' })
    const recalc = (kline.vm as unknown as { recalcIndicators?: (params?: unknown) => Promise<void> }).recalcIndicators

    await expect(recalc?.({ KDJ: { n: 5, m1: 3, m2: 2 } })).rejects.toThrow('recalc failed')
    expect(recalcSpy).toHaveBeenCalledTimes(1)

    recalcSpy.mockRestore()
  })
})
