/**
 * AShareDetailDrawer：KlineChart 工具栏 update:range 接入（B 类服务端重查）。
 *  - 打开 → 默认窗口（limit=360，无 range）。
 *  - 选区间 → 以 start/end 重查，limit 放大到 1000。
 *  - 清空 → 回默认窗口（limit=360，无 range）。
 * fetcher 模块整体 mock；KlineChart stub 记录 :data + 再 emit update:range 驱动父 handler。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import AShareDetailDrawer from './AShareDetailDrawer.vue'

const { fetchDetailMock, fetchKlineOnlyMock } = vi.hoisted(() => ({
  fetchDetailMock: vi.fn(),
  fetchKlineOnlyMock: vi.fn(),
}))
vi.mock('./aShareDetailFetcher', () => ({
  fetchAShareDetail: fetchDetailMock,
  fetchAShareKlineOnly: fetchKlineOnlyMock,
}))

const KlineChartStub = defineComponent({
  name: 'KlineChart',
  props: { data: { type: Array, default: () => [] }, range: { type: Array, default: null } },
  emits: ['update:range'],
  setup(props) {
    return () => h('div', { class: 'kline-stub', 'data-len': (props.data as unknown[]).length })
  },
})

const ROW = { tsCode: '000001.SZ', name: '平安银行', market: '主板', industry: '银行', tradeDate: '20260101' }

function mountDrawer() {
  const show = ref(false)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () =>
                h(AShareDetailDrawer, { show: show.value, row: ROW as never, priceMode: 'qfq' }),
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
  fetchDetailMock.mockResolvedValue({ kline: [{ open_time: '2026-01-01' }], flowRows: [], amvRows: [] })
})

describe('AShareDetailDrawer update:range（B 类）', () => {
  it('打开 → 默认窗口 limit=360 无 range；选区 → limit=1000 + start/end；清空 → 回默认', async () => {
    const { wrapper, show } = mountDrawer()

    // 打开
    show.value = true
    await wrapper.setProps({})
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000001.SZ', 360, 'qfq', undefined)

    // 选区间 [2024-01-05, 2024-01-10]。注意：loadDetail 重查前会清空 klineRows → KlineChart
    // 短暂 unmount/remount，故每次 emit 前都重新 findComponent，避免落到已卸载的旧实例上。
    wrapper
      .findComponent({ name: 'KlineChart' })
      .vm.$emit('update:range', [new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000001.SZ', 1000, 'qfq', {
      startDate: '20240105',
      endDate: '20240110',
    })

    // 清空 → 回默认窗口
    wrapper.findComponent({ name: 'KlineChart' }).vm.$emit('update:range', null)
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000001.SZ', 360, 'qfq', undefined)
  })
})
