/**
 * UsStockDetailDrawer：KlineChart 工具栏 update:range 接入（B 类服务端重查）。
 *  - 打开 → 默认窗口（limit=360，无 range）。
 *  - 选区间 → 以 start/end 重查，limit 放大到 1000。
 *  - 清空 → 回默认窗口（limit=360，无 range）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import UsStockDetailDrawer from './UsStockDetailDrawer.vue'

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

const ROW = { ticker: 'AVGO', name: 'Broadcom', theme: '半导体', stockType: '普通股', tradeDate: '20260101' }

function mountDrawer() {
  const show = ref(false)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () =>
                h(UsStockDetailDrawer, { show: show.value, row: ROW as never, priceMode: 'qfq' }),
            }),
        })
    },
  })
  const wrapper = mount(Wrapper, {
    attachTo: document.body,
    global: { stubs: { KlineChart: KlineChartStub } },
  })
  return { wrapper, show }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchKlineMock.mockResolvedValue([{ open_time: '2026-01-01' }])
})

describe('UsStockDetailDrawer update:range（B 类）', () => {
  it('打开 → 360 无 range；选区 → 1000 + start/end；清空 → 回默认', async () => {
    const { wrapper, show } = mountDrawer()

    show.value = true
    await wrapper.setProps({})
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('AVGO', 360, 'qfq', undefined)

    // loadDetail 重查前会清空 klineRows → KlineChart 短暂 unmount/remount，故每次 emit 前重新 findComponent。
    wrapper
      .findComponent({ name: 'KlineChart' })
      .vm.$emit('update:range', [new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('AVGO', 1000, 'qfq', {
      startDate: '20240105',
      endDate: '20240110',
    })

    wrapper.findComponent({ name: 'KlineChart' }).vm.$emit('update:range', null)
    await flushPromises()
    await nextTick()
    expect(fetchKlineMock).toHaveBeenLastCalledWith('AVGO', 360, 'qfq', undefined)
  })
})
