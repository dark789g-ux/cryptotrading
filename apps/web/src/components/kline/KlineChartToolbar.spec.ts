import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NButton, NConfigProvider, NDatePicker, NInputNumber } from 'naive-ui'

import KlineChartToolbar from './KlineChartToolbar.vue'
import KdjParamsEditor from './KdjParamsEditor.vue'
import {
  ALL_SUBPLOT_KEYS,
  DEFAULT_KDJ_PARAMS,
  type IndicatorSubplotParams,
  type RawSubplotPrefs,
  type SubplotKey,
  type SubplotPrefs,
} from '@/composables/kline/subplotConfig'
import type { KlineChartBar } from '@/api'

function makeBar(openTime: string): KlineChartBar {
  return {
    open_time: openTime,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
    MA5: null,
    MA30: null,
    MA60: null,
    MA120: null,
    MA240: null,
    'KDJ.K': null,
    'KDJ.D': null,
    'KDJ.J': null,
    DIF: null,
    DEA: null,
    MACD: null,
    BBI: null,
    VWAP5: null,
    VWAP10: null,
    VWAP20: null,
  }
}

function defaultTestPrefs(params?: IndicatorSubplotParams): SubplotPrefs {
  const visible: SubplotKey[] = ['VOL', 'KDJ']
  return {
    order: visible,
    visibility: Object.fromEntries(
      ALL_SUBPLOT_KEYS.map((k) => [k, visible.includes(k)]),
    ) as Record<SubplotKey, boolean>,
    heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6, FLOW: 10, '0AMV': 8, '0AMV_MACD': 8 },
    params,
  }
}

function mountToolbar(props: {
  granularity?: 'date' | 'hour' | 'minute'
  range?: [number, number] | null
  data?: KlineChartBar[]
  prefs?: SubplotPrefs
  symbolCode?: string
  symbolName?: string
  suspend?: import('@/api').AShareKlineSuspend | null
} = {}, slots?: { actions?: () => ReturnType<typeof h> }) {
  const onUpdateRange = vi.fn()

  const Wrapper = defineComponent({
    setup() {
      const prefs = ref<SubplotPrefs>(props.prefs ?? defaultTestPrefs())
      const update = vi.fn((partial: RawSubplotPrefs) => {
        if (partial.order !== undefined) prefs.value.order = partial.order
        if (partial.visibility !== undefined) {
          prefs.value.visibility = { ...prefs.value.visibility, ...partial.visibility }
        }
        if (partial.heightPct !== undefined) {
          prefs.value.heightPct = { ...prefs.value.heightPct, ...partial.heightPct }
        }
        if ('params' in partial) {
          prefs.value.params = partial.params as IndicatorSubplotParams | undefined
        }
      })
      const reset = vi.fn(() => {
        prefs.value = defaultTestPrefs()
      })

      return {
        prefs,
        update,
        reset,
        render: () =>
          h(
            KlineChartToolbar,
            {
              granularity: props.granularity ?? 'date',
              range: props.range ?? null,
              data: props.data ?? [],
              prefs: prefs.value,
              update,
              reset,
              symbolCode: props.symbolCode,
              symbolName: props.symbolName,
              suspend: props.suspend ?? null,
              'onUpdate:range': onUpdateRange,
            },
            slots,
          ),
      }
    },
    render() {
      return this.render()
    },
  })

  const wrapper = mount(Wrapper, { attachTo: document.body })
  return { wrapper, onUpdateRange }
}

function mockLocalStorage() {
  const storage: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = value
      }),
      removeItem: vi.fn((key: string) => {
        delete storage[key]
      }),
      clear: vi.fn(() => {
        Object.keys(storage).forEach((k) => delete storage[k])
      }),
    },
    writable: true,
  })
  return storage
}

async function openSubplotPanel(wrapper: ReturnType<typeof mountToolbar>['wrapper']) {
  // 主设置齿轮按钮 aria-label="副图设置"
  const settingsBtn = wrapper.findAllComponents(NButton).find((b) => b.attributes('aria-label') === '副图设置')
  expect(settingsBtn).toBeTruthy()
  await settingsBtn!.trigger('click')
  await nextTick()
  await flushPromises()
}

async function openKdjEditor(wrapper: ReturnType<typeof mountToolbar>['wrapper']) {
  await openSubplotPanel(wrapper)

  // KDJ 参数齿轮按钮 aria-label="KDJ 参数"
  const kdjBtn = wrapper.findAllComponents(NButton).find((b) => b.attributes('aria-label') === 'KDJ 参数')
  expect(kdjBtn).toBeTruthy()
  await kdjBtn!.trigger('click')
  await nextTick()
  await flushPromises()

  // KdjParamsEditor 通过 portal 渲染到 document.body
  const editors = Array.from(document.body.querySelectorAll('.kdj-params-editor'))
  expect(editors.length).toBeGreaterThan(0)
}

describe('KlineChartToolbar KDJ 参数设置', () => {
  let lastWrapper: ReturnType<typeof mountToolbar>['wrapper'] | null = null

  beforeEach(() => {
    mockLocalStorage()
  })

  afterEach(() => {
    if (lastWrapper) {
      lastWrapper.unmount()
      lastWrapper = null
    }
    // 清理 naive-ui portal 残留的 body 内容
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('KDJ 行显示齿轮按钮，点击后弹出 KdjParamsEditor', async () => {
    const { wrapper } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openKdjEditor(wrapper)

    const editor = wrapper.findComponent(KdjParamsEditor)
    expect(editor.exists()).toBe(true)
  })

  it('默认状态下 KDJ 行显示 "KDJ"', async () => {
    const { wrapper } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openSubplotPanel(wrapper)

    const text = document.body.textContent ?? ''
    expect(text).toContain('KDJ')
    expect(text).not.toContain('KDJ(')
  })

  it('修改参数 → 点确定 → update 被调用并携带 params.KDJ', async () => {
    const { wrapper } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openKdjEditor(wrapper)

    const editor = wrapper.findComponent(KdjParamsEditor)
    const [nInput, m1Input, m2Input] = editor.findAllComponents(NInputNumber)
    nInput.vm.$emit('update:value', 14)
    m1Input.vm.$emit('update:value', 5)
    m2Input.vm.$emit('update:value', 3)
    await nextTick()

    const confirmBtn = editor.findAllComponents(NButton).find((b) => b.text() === '确定')
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.trigger('click')
    await flushPromises()
    await nextTick()

    const updateFn = wrapper.vm.update as ReturnType<typeof vi.fn>
    expect(updateFn).toHaveBeenCalled()
    const lastCall = updateFn.mock.calls[updateFn.mock.calls.length - 1][0]
    expect(lastCall.params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
  })

  it('点取消 → 不更新 params.KDJ', async () => {
    const { wrapper } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openKdjEditor(wrapper)

    const editor = wrapper.findComponent(KdjParamsEditor)
    const [nInput] = editor.findAllComponents(NInputNumber)
    nInput.vm.$emit('update:value', 14)
    await nextTick()

    const cancelBtn = editor.findAllComponents(NButton).find((b) => b.text() === '取消')
    expect(cancelBtn).toBeTruthy()
    await cancelBtn!.trigger('click')
    await flushPromises()
    await nextTick()

    const updateFn = wrapper.vm.update as ReturnType<typeof vi.fn>
    const callsWithKdj = updateFn.mock.calls.filter(
      (call) => call[0].params?.KDJ != null,
    )
    expect(callsWithKdj).toHaveLength(0)
  })

  it('点取消 → 关闭 KDJ 参数 Popover', async () => {
    const { wrapper } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openKdjEditor(wrapper)
    expect(document.body.querySelectorAll('.kdj-params-editor').length).toBeGreaterThan(0)

    const editor = wrapper.findComponent(KdjParamsEditor)
    const cancelBtn = editor.findAllComponents(NButton).find((b) => b.text() === '取消')
    expect(cancelBtn).toBeTruthy()
    await cancelBtn!.trigger('click')
    await flushPromises()
    await nextTick()

    expect(document.body.querySelectorAll('.kdj-params-editor')).toHaveLength(0)
  })

  it('存在非默认 KDJ 参数时行名显示 KDJ(n,m1,m2)', async () => {
    const { wrapper } = mountToolbar({
      prefs: defaultTestPrefs({ KDJ: { n: 14, m1: 5, m2: 3 } }),
    })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openSubplotPanel(wrapper)

    expect(document.body.textContent ?? '').toContain('KDJ(14,5,3)')
  })

  it('KDJ 参数为默认值时仍显示 "KDJ"', async () => {
    const { wrapper } = mountToolbar({
      prefs: defaultTestPrefs({ KDJ: DEFAULT_KDJ_PARAMS }),
    })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openSubplotPanel(wrapper)

    const text = document.body.textContent ?? ''
    expect(text).toContain('KDJ')
    expect(text).not.toContain('KDJ(')
  })
})

describe('KlineChartToolbar 时间范围同步', () => {
  let lastWrapper: ReturnType<typeof mountToolbar>['wrapper'] | null = null

  afterEach(() => {
    if (lastWrapper) {
      lastWrapper.unmount()
      lastWrapper = null
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('空数据 + 无 range 时 n-date-picker 值为 null', async () => {
    const { wrapper } = mountToolbar({ data: [], range: null })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const picker = wrapper.findComponent(NDatePicker)
    expect(picker.exists()).toBe(true)
    expect(picker.props('value')).toBeNull()
  })

  it('空数据 + 有 range 时显示该 range', async () => {
    const range: [number, number] = [
      new Date(2024, 0, 1).getTime(),
      new Date(2024, 0, 5).getTime(),
    ]
    const { wrapper } = mountToolbar({ data: [], range })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const picker = wrapper.findComponent(NDatePicker)
    expect(picker.props('value')).toEqual(range)
  })

  it('有数据（日期格式）时显示对应本地午夜 ms', async () => {
    const data = [makeBar('2024-01-01'), makeBar('2024-01-05')]
    const { wrapper } = mountToolbar({ data })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const picker = wrapper.findComponent(NDatePicker)
    expect(picker.props('value')).toEqual([
      new Date(2024, 0, 1).getTime(),
      new Date(2024, 0, 5).getTime(),
    ])
  })

  it('有数据（ISO 格式）时正确解析为 ms', async () => {
    const data = [makeBar('2024-01-01T08:00:00Z'), makeBar('2024-01-05T08:00:00Z')]
    const { wrapper } = mountToolbar({ data })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const picker = wrapper.findComponent(NDatePicker)
    expect(picker.props('value')).toEqual([
      new Date('2024-01-01T08:00:00Z').getTime(),
      new Date('2024-01-05T08:00:00Z').getTime(),
    ])
  })

  it('有数据（YYYYMMDD 格式，A 股指数 index-daily）时显示对应本地午夜 ms', async () => {
    const data = [makeBar('20250618'), makeBar('20250623')]
    const { wrapper } = mountToolbar({ data })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const picker = wrapper.findComponent(NDatePicker)
    expect(picker.props('value')).toEqual([
      new Date(2025, 5, 18).getTime(),
      new Date(2025, 5, 23).getTime(),
    ])
  })

  it('数据从空变为 YYYYMMDD 时不会因 actualRange 同步而 emit update:range', async () => {
    const onUpdateRange = vi.fn()
    const range: [number, number] = [
      new Date(2024, 5, 1).getTime(),
      new Date(2025, 5, 23).getTime(),
    ]

    const data = ref<KlineChartBar[]>([])
    const Wrapper = defineComponent({
      setup() {
        const prefs = ref(defaultTestPrefs())
        return () =>
          h(
            KlineChartToolbar,
            {
              granularity: 'date',
              range,
              data: data.value,
              prefs: prefs.value,
              update: vi.fn(),
              reset: vi.fn(),
              'onUpdate:range': onUpdateRange,
            },
            undefined,
          )
      },
    })

    const wrapper = mount(Wrapper, { attachTo: document.body })
    lastWrapper = wrapper as ReturnType<typeof mountToolbar>['wrapper']
    await flushPromises()
    await nextTick()
    onUpdateRange.mockClear()

    data.value = [makeBar('20250618'), makeBar('20250623')]
    await flushPromises()
    await nextTick()

    expect(onUpdateRange).not.toHaveBeenCalled()
  })

  it('用户确认选择时 emit update:range 一次', async () => {
    const { wrapper, onUpdateRange } = mountToolbar({ data: [], range: null })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const picker = wrapper.findComponent(NDatePicker)
    const range: [number, number] = [
      new Date(2024, 0, 1).getTime(),
      new Date(2024, 0, 5).getTime(),
    ]
    picker.vm.$emit('update:value', range)
    await nextTick()

    expect(onUpdateRange).toHaveBeenCalledTimes(1)
    expect(onUpdateRange).toHaveBeenCalledWith(range)
  })
})

describe('KlineChartToolbar 标的代码/名称展示', () => {
  let lastWrapper: ReturnType<typeof mountToolbar>['wrapper'] | null = null

  afterEach(() => {
    if (lastWrapper) {
      lastWrapper.unmount()
      lastWrapper = null
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('传 symbolCode + symbolName → 渲染代码和名称', async () => {
    const { wrapper } = mountToolbar({ symbolCode: '000001.SZ', symbolName: '平安银行' })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const symbolEl = wrapper.find('.kline-toolbar__symbol')
    expect(symbolEl.exists()).toBe(true)
    expect(symbolEl.find('.kline-toolbar__symbol-code').text()).toContain('000001.SZ')
    expect(symbolEl.find('.kline-toolbar__symbol-name').text()).toContain('平安银行')
  })

  it('只传 symbolCode → 渲染代码，不渲染名称', async () => {
    const { wrapper } = mountToolbar({ symbolCode: '000001.SZ' })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const symbolEl = wrapper.find('.kline-toolbar__symbol')
    expect(symbolEl.exists()).toBe(true)
    expect(symbolEl.find('.kline-toolbar__symbol-code').text()).toContain('000001.SZ')
    expect(symbolEl.find('.kline-toolbar__symbol-name').exists()).toBe(false)
  })

  it('不传 symbolCode → 不渲染 symbol 块', async () => {
    const { wrapper } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.kline-toolbar__symbol').exists()).toBe(false)
  })
})

describe('KlineChartToolbar actions 具名插槽', () => {
  let lastWrapper: ReturnType<typeof mountToolbar>['wrapper'] | null = null

  afterEach(() => {
    if (lastWrapper) {
      lastWrapper.unmount()
      lastWrapper = null
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('传入 actions 插槽内容渲染到 .kline-toolbar__actions 内', async () => {
    const { wrapper } = mountToolbar(
      {},
      { actions: () => h('button', { class: 'info-trigger' }, '信息面板') },
    )
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const actionsEl = wrapper.find('.kline-toolbar__actions')
    expect(actionsEl.exists()).toBe(true)
    expect(actionsEl.find('button.info-trigger').exists()).toBe(true)
    expect(actionsEl.text()).toContain('信息面板')
  })

  it('不传 actions 插槽时副图设置齿轮仍在且 .kline-toolbar__actions 存在', async () => {
    const { wrapper } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    const actionsEl = wrapper.find('.kline-toolbar__actions')
    expect(actionsEl.exists()).toBe(true)
    const settingsBtn = wrapper
      .findAllComponents(NButton)
      .find((b) => b.attributes('aria-label') === '副图设置')
    expect(settingsBtn).toBeTruthy()
  })
})

describe('KlineChartToolbar 停牌标识', () => {
  let lastWrapper: ReturnType<typeof mountToolbar>['wrapper'] | null = null

  afterEach(() => {
    if (lastWrapper) {
      lastWrapper.unmount()
      lastWrapper = null
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('停牌时渲染「停牌中」Badge 与副文案', async () => {
    const { wrapper } = mountToolbar({
      symbolCode: '000008.SZ',
      symbolName: '神州高铁',
      suspend: {
        status: 'suspended',
        sinceDate: '20260707',
        timing: '全天',
        lastQuoteTradeDate: '20260706',
        asOfTradeDate: '20260710',
      },
    })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).toContain('停牌中')
    expect(wrapper.find('.kline-toolbar__suspend-caption').text()).toContain('行情截至 2026-07-06')
    expect(wrapper.find('.kline-toolbar__suspend-caption').text()).toContain('自 2026-07-07 停牌')
  })

  it('非停牌时不渲染 Badge 与副文案', async () => {
    const { wrapper } = mountToolbar({
      symbolCode: '000001.SZ',
      symbolName: '平安银行',
      suspend: {
        status: 'none',
        sinceDate: null,
        timing: null,
        lastQuoteTradeDate: null,
        asOfTradeDate: null,
      },
    })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).not.toContain('停牌中')
    expect(wrapper.find('.kline-toolbar__suspend-caption').exists()).toBe(false)
  })
})
