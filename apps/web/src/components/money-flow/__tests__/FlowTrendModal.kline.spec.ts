/**
 * FlowTrendModal kline 模式回归测试（KlineChart 工具栏 update:range 接入后）。
 *
 * 锁三条零回归行为（交接验证标准 #4）：
 *  1. 打开（kline 模式）→ 以近 120 天默认窗口重查（fetchFn 收到 start_date/end_date + ts_code）。
 *  2. 选区间（KlineChart emit update:range）→ 以对应 start/end 重查。
 *  3. 清空（emit update:range null）→ 不再重查（no-op，保留当前数据，与接入前一致）。
 *
 * 重型子组件（AppModal / FlowTrendChart / FlowDateControl / KlineChart）均 stub；
 * moneyFlowApi / watchlistApi mock。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import FlowTrendModal from '../FlowTrendModal.vue'

vi.mock('@/api/modules/market/moneyFlow', () => ({
  moneyFlowApi: { getMembers: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/api', () => ({
  watchlistApi: { upsertByName: vi.fn() },
}))

// AppModal stub：渲染 default 作用域插槽（透传 maximized=false），让内部 n-tabs / KlineChart 真正挂载。
const AppModalStub = defineComponent({
  name: 'AppModal',
  props: { show: Boolean },
  setup(_, { slots }) {
    return () => h('div', { class: 'app-modal-stub' }, slots.default ? slots.default({ maximized: false }) : [])
  },
})

// KlineChart stub：记录收到的 :data 长度 + 暴露 update:range 供测试驱动父 handler。
const KlineChartStub = defineComponent({
  name: 'KlineChart',
  props: { data: { type: Array, default: () => [] }, range: { type: Array, default: null } },
  emits: ['update:range'],
  setup(props) {
    return () => h('div', { class: 'kline-stub', 'data-len': (props.data as unknown[]).length })
  },
})

const StubDiv = (name: string) =>
  defineComponent({ name, setup: () => () => h('div', { class: `${name}-stub` }) })

function mountModal(fetchFn: ReturnType<typeof vi.fn>) {
  const visible = ref(false)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () =>
                h(FlowTrendModal, {
                  visible: visible.value,
                  tsCode: '880082.TI',
                  entityName: '某行业',
                  // fetchFn prop 的 TrendFetchFn 类型未从组件导出，测试里用 vi.fn() 桩，转 never 规避类型校验
                  fetchFn: fetchFn as never,
                  chartMode: 'kline',
                }),
            }),
        })
    },
  })
  const wrapper = mount(Wrapper, {
    attachTo: document.body,
    global: {
      stubs: {
        AppModal: AppModalStub,
        KlineChart: KlineChartStub,
        FlowTrendChart: StubDiv('FlowTrendChart'),
        FlowDateControl: StubDiv('FlowDateControl'),
      },
    },
  })
  return { wrapper, visible }
}

// YYYYMMDD 字符串校验
const YMD = /^\d{8}$/

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FlowTrendModal kline 模式 update:range 接线', () => {
  it('打开 → 以近 120 天默认窗口重查（fetchFn 收 start/end + ts_code）', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ kline: [{ open_time: '2024-01-02' }] })
    const { wrapper, visible } = mountModal(fetchFn)

    visible.value = true
    await wrapper.setProps({}) // 触发 wrapper 重渲染，让内层 props.visible 变 true
    await flushPromises()
    await nextTick()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const arg = fetchFn.mock.calls[0][0]
    expect(arg.ts_code).toBe('880082.TI')
    expect(arg.start_date).toMatch(YMD)
    expect(arg.end_date).toMatch(YMD)
    // 默认窗口约 120 天：start < end
    expect(arg.start_date < arg.end_date).toBe(true)
  })

  it('选区间 → 以对应 start/end 重查；清空 → 不再重查', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ kline: [{ open_time: '2024-01-02' }] })
    const { wrapper, visible } = mountModal(fetchFn)

    visible.value = true
    await wrapper.setProps({})
    await flushPromises()
    await nextTick()
    expect(fetchFn).toHaveBeenCalledTimes(1) // 默认窗口

    // 选区间：[2024-01-05, 2024-01-10]（本地午夜 ms）
    const start = new Date(2024, 0, 5).getTime()
    const end = new Date(2024, 0, 10).getTime()
    wrapper.findComponent({ name: 'KlineChart' }).vm.$emit('update:range', [start, end])
    await flushPromises()
    await nextTick()

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[1][0]).toMatchObject({
      ts_code: '880082.TI',
      start_date: '20240105',
      end_date: '20240110',
    })

    // 清空：no-op（不再重查）
    wrapper.findComponent({ name: 'KlineChart' }).vm.$emit('update:range', null)
    await flushPromises()
    await nextTick()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
