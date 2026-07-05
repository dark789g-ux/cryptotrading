/**
 * ASharesIndexKlineModal：KlineChart 随 modal 首次 patch 常驻（v-show），数据就绪后 renderChart。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import ASharesIndexKlineModal from './ASharesIndexKlineModal.vue'
import type { IndexLatestRow } from './types'
import type { KlineChartBar } from '@/api/modules/market/symbols'

const mockEchartsInstance = {
  setOption: vi.fn(),
  dispose: vi.fn(),
  resize: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}

vi.mock('echarts', () => ({
  init: vi.fn(() => mockEchartsInstance),
  use: vi.fn(),
  registerTheme: vi.fn(),
}))

const fetchIndexKline = vi.fn()

vi.mock('./aSharesIndexKlineFetcher', () => ({
  fetchIndexKline: (...args: unknown[]) => fetchIndexKline(...args),
}))

const renderChartSpy = vi.fn(async () => {})

const KlineChartStub = defineComponent({
  name: 'KlineChart',
  props: ['data', 'height', 'range', 'prefsKey', 'availableSubplots', 'showToolbar', 'granularity'],
  setup(_props, { expose }) {
    expose({ renderChart: renderChartSpy, resize: vi.fn() })
    return () =>
      h('div', {
        class: 'kline-chart-stub',
        'data-len': String((_props.data as KlineChartBar[])?.length ?? 0),
      })
  },
})

const AppModalStub = defineComponent({
  name: 'AppModal',
  props: ['show', 'title', 'width', 'maximizable'],
  emits: ['update:show'],
  setup(_props, { slots }) {
    return () =>
      h('div', { class: 'app-modal-stub' }, slots.default?.({ maximized: false }) ?? [])
  },
})

const sampleRow: IndexLatestRow = {
  tsCode: '000001.SH',
  name: '上证指数',
  category: 'market',
  tradeDate: '20250618',
  close: 3000,
  pctChange: 0.5,
  vol: 100,
  amount: 200,
  totalMvWan: null,
  pe: null,
  pb: null,
  count: null,
  netAmount: null,
  netAmount5d: null,
  netAmount10d: null,
  netAmount20d: null,
  obv5d: null,
  obv10d: null,
  obv20d: null,
  buyLgAmount: null,
  buyMdAmount: null,
  buySmAmount: null,
}

const mountedWrappers: VueWrapper[] = []

function makeBar(): KlineChartBar {
  return {
    open_time: '20250618',
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 100,
    MA5: 1,
    MA30: 1,
    MA60: 1,
    MA120: 1,
    MA240: 1,
  } as KlineChartBar
}

function mountModal(opts: { realKlineChart?: boolean } = {}) {
  const show = ref(false)
  const wrapper = mount(
    defineComponent({
      setup() {
        return () =>
          h(NConfigProvider, null, {
            default: () =>
              h(NMessageProvider, null, {
                default: () =>
                  h(ASharesIndexKlineModal, {
                    show: show.value,
                    row: sampleRow,
                  }),
              }),
          })
      },
    }),
    {
      attachTo: document.body,
      global: {
        stubs: {
          AppModal: AppModalStub,
          ...(opts.realKlineChart ? {} : { KlineChart: KlineChartStub }),
        },
      },
    },
  )
  mountedWrappers.push(wrapper)
  return { wrapper, show }
}

describe('ASharesIndexKlineModal KlineChart mount timing', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    })
    mockEchartsInstance.setOption.mockClear()
    mockEchartsInstance.dispose.mockClear()
    mockEchartsInstance.resize.mockClear()
  })
  afterEach(() => {
    mountedWrappers.forEach((w) => w.unmount())
    mountedWrappers.length = 0
    fetchIndexKline.mockReset()
    renderChartSpy.mockReset()
  })

  it('loading 时 KlineChart 已挂载但 data 为空；数据就绪后 renderChart 被显式调用', async () => {
    let resolveKline: (bars: KlineChartBar[]) => void = () => {}
    fetchIndexKline.mockImplementation(
      () =>
        new Promise<KlineChartBar[]>((resolve) => {
          resolveKline = resolve
        }),
    )

    const { wrapper, show } = mountModal()
    show.value = true
    await flushPromises()
    expect(wrapper.findComponent({ name: 'KlineChart' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'KlineChart' }).attributes('data-len')).toBe('0')

    resolveKline([makeBar(), makeBar()])
    await flushPromises()

    const chart = wrapper.findComponent({ name: 'KlineChart' })
    expect(chart.attributes('data-len')).toBe('2')
    expect(renderChartSpy).toHaveBeenCalled()
  })

  it('无数据时展示 empty-state，KlineChart 仍挂载', async () => {
    fetchIndexKline.mockResolvedValue([])
    const { wrapper, show } = mountModal()
    show.value = true
    await flushPromises()

    expect(wrapper.findComponent({ name: 'KlineChart' }).exists()).toBe(true)
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(renderChartSpy).not.toHaveBeenCalled()
  })

  it('YYYYMMDD 数据就绪后 queryKline 仅首屏一次且 loading 遮罩消失', async () => {
    fetchIndexKline.mockResolvedValue([makeBar(), makeBar(), makeBar()])
    const { wrapper, show } = mountModal({ realKlineChart: true })
    show.value = true
    await flushPromises()
    await new Promise((r) => setTimeout(r, 200))

    expect(fetchIndexKline).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.modal-pane-overlay').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'KlineChart' }).exists()).toBe(true)
  })

  it('sw category 白名单含 0AMV_MACD', async () => {
    fetchIndexKline.mockResolvedValue([makeBar()])
    const swRow: IndexLatestRow = { ...sampleRow, tsCode: '801750.SI', category: 'sw' }
    const show = ref(false)
    const wrapper = mount(
      defineComponent({
        setup() {
          return () =>
            h(NConfigProvider, null, {
              default: () =>
                h(NMessageProvider, null, {
                  default: () =>
                    h(ASharesIndexKlineModal, { show: show.value, row: swRow }),
                }),
            })
        },
      }),
      {
        attachTo: document.body,
        global: { stubs: { AppModal: AppModalStub, KlineChart: KlineChartStub } },
      },
    )
    mountedWrappers.push(wrapper)
    show.value = true
    await flushPromises()

    const chart = wrapper.findComponent({ name: 'KlineChart' })
    expect(chart.props('availableSubplots')).toContain('0AMV_MACD')
  })

  it('market category 白名单不含 AMV 副图', async () => {
    fetchIndexKline.mockResolvedValue([makeBar()])
    const { wrapper, show } = mountModal()
    show.value = true
    await flushPromises()

    const chart = wrapper.findComponent({ name: 'KlineChart' })
    expect(chart.props('availableSubplots')).not.toContain('0AMV')
    expect(chart.props('availableSubplots')).not.toContain('0AMV_MACD')
  })
})
