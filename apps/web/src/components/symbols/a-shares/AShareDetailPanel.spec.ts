/**
 * AShareDetailPanel：A 股详情内容面板。
 *  - 切换 row → 重拉详情（limit=360，无 range）。
 *  - priceMode 切换 → 仅重拉 K 线（fetchKlineOnly），复用缓存资金流 / AMV。
 *  - 渲染 0AMV 合规标注。
 *  - visible=false → 清空数据与选区；visible=true → 重新加载。
 * fetcher 模块整体 mock；KlineChart stub 记录 :data 并 emit update:range / recalcIndicators 驱动 handler。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import AShareDetailPanel from './AShareDetailPanel.vue'
import { aSharesApi, type AShareRow } from '@/api'

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

const ROW_A = { tsCode: '000001.SZ', name: '平安银行', market: '主板', swIndustryL1Code: '801780.SI', swIndustryL2Code: '801782.SI', swIndustryL3Code: '801783.SI', swIndustryL1Name: '银行', swIndustryL2Name: '商业银行', swIndustryL3Name: '城商行', tradeDate: '20260101' } as AShareRow
const ROW_B = { tsCode: '000002.SZ', name: '万科A', market: '主板', swIndustryL1Code: '801180.SI', swIndustryL2Code: '801182.SI', swIndustryL3Code: '801183.SI', swIndustryL1Name: '房地产', swIndustryL2Name: '房地产开发', swIndustryL3Name: '住宅开发', tradeDate: '20260102' } as AShareRow

function mountPanel(initial: { row?: AShareRow; priceMode?: 'qfq' | 'raw'; visible?: boolean } = {}) {
  const row = ref(initial.row ?? null)
  const priceMode = ref(initial.priceMode ?? 'qfq')
  const visible = ref(initial.visible ?? true)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () =>
                h(AShareDetailPanel, {
                  row: row.value,
                  priceMode: priceMode.value,
                  visible: visible.value,
                }),
            }),
        })
    },
  })
  const wrapper = mount(Wrapper, {
    attachTo: document.body,
    global: { stubs: { KlineChart: KlineChartStub } },
  })
  return { wrapper, row, priceMode, visible }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchDetailMock.mockResolvedValue({ kline: [{ open_time: '2026-01-01' }], flowRows: [], amvRows: [] })
})

describe('AShareDetailPanel row 变化', () => {
  it('row 变化触发 fetchAShareDetail 重拉', async () => {
    const { row } = mountPanel({ row: ROW_A })

    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000001.SZ', 360, 'qfq', undefined)

    row.value = ROW_B
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000002.SZ', 360, 'qfq', undefined)
  })
})

describe('AShareDetailPanel priceMode 变化', () => {
  it('priceMode 变化仅重拉 K 线，并复用缓存资金流', async () => {
    fetchDetailMock.mockResolvedValue({
      kline: [{ open_time: '2026-01-01' }],
      flowRows: [{ tsCode: '000001.SZ', tradeDate: '20260101', netAmount: '1.1' }],
      amvRows: [],
    })
    fetchKlineOnlyMock.mockResolvedValue([{ open_time: '2026-01-01' }])

    const { priceMode } = mountPanel({ row: ROW_A })
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenCalledTimes(1)
    expect(fetchKlineOnlyMock).not.toHaveBeenCalled()

    priceMode.value = 'raw'
    await flushPromises()
    await nextTick()

    expect(fetchKlineOnlyMock).toHaveBeenCalledTimes(1)
    expect(fetchKlineOnlyMock).toHaveBeenLastCalledWith('000001.SZ', 360, 'raw', undefined)
    expect(fetchDetailMock).toHaveBeenCalledTimes(1)
  })
})

describe('AShareDetailPanel AMV 标注', () => {
  it('渲染 0AMV 合规标注', async () => {
    const { wrapper } = mountPanel({ row: ROW_A })

    await flushPromises()
    await nextTick()

    const caption = wrapper.find('.amv-caption')
    expect(caption.exists()).toBe(true)
    expect(caption.text()).toContain('信号未回测校准')
  })
})

describe('AShareDetailPanel visible 显隐', () => {
  it('visible=false 清空数据，visible=true 重新加载', async () => {
    const { wrapper, visible } = mountPanel({ row: ROW_A })

    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent({ name: 'KlineChart' }).attributes('data-len')).toBe('1')

    visible.value = false
    await flushPromises()
    await nextTick()
    expect(wrapper.findComponent({ name: 'KlineChart' }).exists()).toBe(false)

    visible.value = true
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenCalledTimes(2)
    expect(wrapper.findComponent({ name: 'KlineChart' }).attributes('data-len')).toBe('1')
  })
})

describe('AShareDetailPanel update:range（B 类服务端重查）', () => {
  it('选区间 → limit=1000 + start/end；清空 → 回默认窗口 limit=360', async () => {
    const { wrapper } = mountPanel({ row: ROW_A })

    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000001.SZ', 360, 'qfq', undefined)

    // 选区间 [2024-01-05, 2024-01-10]。loadDetail 重查前会清空 klineRows → KlineChart
    // 短暂 unmount/remount，故每次 emit 前都重新 findComponent。
    wrapper
      .findComponent({ name: 'KlineChart' })
      .vm.$emit('update:range', [new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000001.SZ', 1000, 'qfq', {
      startDate: '20240105',
      endDate: '20240110',
    })

    wrapper.findComponent({ name: 'KlineChart' }).vm.$emit('update:range', null)
    await flushPromises()
    await nextTick()
    expect(fetchDetailMock).toHaveBeenLastCalledWith('000001.SZ', 360, 'qfq', undefined)
  })
})

describe('AShareDetailPanel recalcIndicators', () => {
  it('KDJ 参数变更成功后替换 klineRows，并带上当前选区与 priceMode', async () => {
    const recalcSpy = vi.spyOn(aSharesApi, 'recalcKlines').mockResolvedValue([
      { open_time: '2026-01-02', close: '11' } as never,
    ])

    const { wrapper } = mountPanel({ row: ROW_A })
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

    const { wrapper } = mountPanel({ row: ROW_A })
    await flushPromises()
    await nextTick()

    const kline = wrapper.findComponent({ name: 'KlineChart' })
    const recalc = (kline.vm as unknown as { recalcIndicators?: (params?: unknown) => Promise<void> }).recalcIndicators

    await expect(recalc?.({ KDJ: { n: 5, m1: 3, m2: 2 } })).rejects.toThrow('recalc failed')
    expect(recalcSpy).toHaveBeenCalledTimes(1)

    recalcSpy.mockRestore()
  })
})
