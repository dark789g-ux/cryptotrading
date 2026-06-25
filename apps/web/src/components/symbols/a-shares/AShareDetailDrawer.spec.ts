/**
 * AShareDetailDrawer：KlineChart 工具栏 update:range 接入（B 类服务端重查）
 * 与 recalcIndicators 回调接入。
 *  - 打开 → 默认窗口（limit=360，无 range）。
 *  - 选区间 → 以 start/end 重查，limit 放大到 1000。
 *  - 清空 → 回默认窗口（limit=360，无 range）。
 *  - KDJ 参数变更 → POST /a-shares/:tsCode/klines/recalc，成功后替换 klineRows，失败后抛错。
 * fetcher 模块整体 mock；KlineChart stub 记录 :data + 再 emit update:range / recalcIndicators 驱动父 handler。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import AShareDetailDrawer from './AShareDetailDrawer.vue'
import { aSharesApi } from '@/api'

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

const ROW = { tsCode: '000001.SZ', name: '平安银行', market: '主板', swIndustryL1Code: '801780.SI', swIndustryL2Code: '801782.SI', swIndustryL3Code: '801783.SI', swIndustryL1Name: '银行', swIndustryL2Name: '商业银行', swIndustryL3Name: '城商行', tradeDate: '20260101' }

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

describe('AShareDetailDrawer recalcIndicators', () => {
  it('KDJ 参数变更成功后替换 klineRows，并带上当前选区与 priceMode', async () => {
    const recalcSpy = vi.spyOn(aSharesApi, 'recalcKlines').mockResolvedValue([
      { open_time: '2026-01-02', close: '11' } as never,
    ])

    const { wrapper, show } = mountDrawer()
    show.value = true
    await wrapper.setProps({})
    await flushPromises()
    await nextTick()

    wrapper
      .findComponent({ name: 'KlineChart' })
      .vm.$emit('update:range', [new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    await flushPromises()
    await nextTick()

    const kline = wrapper.findComponent({ name: 'KlineChart' })
    const recalc = (kline.vm as unknown as { recalcIndicators?: (params?: unknown) => Promise<void> }).recalcIndicators
    expect(recalc).toBeTypeOf('function')

    await recalc?.({ KDJ: { n: 5, m1: 3, m2: 2 } })
    await flushPromises()
    await nextTick()

    expect(recalcSpy).toHaveBeenLastCalledWith(
      '000001.SZ',
      1000,
      'qfq',
      { startDate: '20240105', endDate: '20240110' },
      { kdjParams: { n: 5, m1: 3, m2: 2 } },
    )
    expect((kline.vm as unknown as { data: unknown[] }).data).toHaveLength(1)

    recalcSpy.mockRestore()
  })

  it('KDJ 参数变更失败时抛错，让 KlineChart 回滚参数', async () => {
    const recalcSpy = vi.spyOn(aSharesApi, 'recalcKlines').mockRejectedValue(new Error('recalc failed'))

    const { wrapper, show } = mountDrawer()
    show.value = true
    await wrapper.setProps({})
    await flushPromises()
    await nextTick()

    const kline = wrapper.findComponent({ name: 'KlineChart' })
    const recalc = (kline.vm as unknown as { recalcIndicators?: (params?: unknown) => Promise<void> }).recalcIndicators

    await expect(recalc?.({ KDJ: { n: 5, m1: 3, m2: 2 } })).rejects.toThrow('recalc failed')
    expect(recalcSpy).toHaveBeenCalledTimes(1)

    recalcSpy.mockRestore()
  })
})
