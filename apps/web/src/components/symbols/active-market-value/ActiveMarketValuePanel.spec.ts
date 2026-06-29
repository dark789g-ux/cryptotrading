/**
 * ActiveMarketValuePanel：KlineChart 工具栏 update:range 接入（B 类服务端重查 oamv）。
 *  - 激活（onActivated）→ 默认窗口 getData(250, undefined)。
 *  - 选区间 → getData(250, {start,end})（后端按 trade_date 闭区间过滤、忽略 days）。
 *  - 清空 → 回默认窗口 getData(250, undefined)。
 * onActivated 需 KeepAlive 包裹才触发（与生产中本面板处 keep-alive tab 一致）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import ActiveMarketValuePanel from './ActiveMarketValuePanel.vue'

const { getDataMock, getTodayMock } = vi.hoisted(() => ({
  getDataMock: vi.fn(),
  getTodayMock: vi.fn(),
}))
vi.mock('@/api/modules/market/oamv', () => ({
  oamvApi: { getData: getDataMock, sync: vi.fn() },
}))
vi.mock('@/api/modules/strategy/regimeEngine', () => ({
  regimeEngineApi: { getToday: getTodayMock },
}))

const KlineChartStub = defineComponent({
  name: 'KlineChart',
  props: { data: { type: Array, default: () => [] }, range: { type: Array, default: null } },
  emits: ['update:range'],
  setup(props) {
    return () => h('div', { class: 'kline-stub', 'data-len': (props.data as unknown[]).length })
  },
})
const RegimeBadgeStub = defineComponent({ name: 'RegimeBadge', setup: () => () => h('div') })

function mountPanel() {
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(KeepAlive, null, { default: () => h(ActiveMarketValuePanel) }),
            }),
        })
    },
  })
  return mount(Wrapper, {
    attachTo: document.body,
    global: { stubs: { KlineChart: KlineChartStub, RegimeBadge: RegimeBadgeStub } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getDataMock.mockResolvedValue([
    { tradeDate: '20260101', open: '1', high: '1', low: '1', close: '1' },
  ])
  getTodayMock.mockResolvedValue(null)
})

describe('ActiveMarketValuePanel update:range（B 类 oamv）', () => {
  it('激活 → 默认 getData(250, undefined)；选区 → getData(250,{start,end})；清空 → 回默认', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await nextTick()
    expect(getDataMock).toHaveBeenLastCalledWith(250, undefined)

    const chart = wrapper.findComponent({ name: 'KlineChart' })

    chart.vm.$emit('update:range', [new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    await flushPromises()
    await nextTick()
    expect(getDataMock).toHaveBeenLastCalledWith(250, { startDate: '20240105', endDate: '20240110' })

    chart.vm.$emit('update:range', null)
    await flushPromises()
    await nextTick()
    expect(getDataMock).toHaveBeenLastCalledWith(250, undefined)
  })
})
