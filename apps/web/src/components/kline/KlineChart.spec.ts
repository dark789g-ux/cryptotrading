import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import KlineChart from './KlineChart.vue'
import {
  ALL_SUBPLOT_KEYS,
  DEFAULT_SUBPLOT_HEIGHT_PCT,
  type IndicatorSubplotParams,
  type RawSubplotPrefs,
  type SubplotKey,
  type SubplotPrefs,
} from '@/composables/kline/subplotConfig'

const ToolbarStub = defineComponent({
  name: 'KlineChartToolbar',
  props: ['granularity', 'range', 'disabledRange', 'prefsKey', 'availableSubplots', 'prefs', 'update', 'reset'],
  emits: ['update:range'],
  setup(props) {
    return {
      applyUpdate: (partial: RawSubplotPrefs) => props.update?.(partial),
      applyReset: () => props.reset?.(),
    }
  },
  render() {
    return h('div')
  },
})

const mountedWrappers: VueWrapper[] = []

function createPrefs(params?: IndicatorSubplotParams): SubplotPrefs {
  const visible: SubplotKey[] = ['VOL', 'KDJ']
  return {
    order: visible,
    visibility: Object.fromEntries(
      ALL_SUBPLOT_KEYS.map((k) => [k, visible.includes(k)]),
    ) as Record<SubplotKey, boolean>,
    heightPct: { ...DEFAULT_SUBPLOT_HEIGHT_PCT },
    params,
  }
}

function mountChart(opts: {
  recalcIndicators?: (params?: IndicatorSubplotParams) => Promise<void>
  errorHandler?: (err: unknown) => void
} = {}) {
  const errorHandler = opts.errorHandler ?? vi.fn()
  const wrapper = mount(KlineChart, {
    props: {
      data: [],
      prefsKey: 'test-klinechart',
      availableSubplots: ['VOL', 'KDJ'],
      showToolbar: true,
      recalcIndicators: opts.recalcIndicators,
    },
    global: {
      stubs: { KlineChartToolbar: ToolbarStub },
      config: { errorHandler },
    },
    attachTo: document.body,
  })
  mountedWrappers.push(wrapper)
  return { wrapper, errorHandler }
}

function getPrefs(wrapper: ReturnType<typeof mountChart>['wrapper']): SubplotPrefs {
  return (wrapper.vm as unknown as { prefs: SubplotPrefs }).prefs
}

function getToolbarStub(wrapper: ReturnType<typeof mountChart>['wrapper']) {
  return wrapper.findComponent(ToolbarStub)
}

describe('KlineChart recalcIndicators', () => {
  afterEach(() => {
    mountedWrappers.forEach((w) => w.unmount())
    mountedWrappers.length = 0
    vi.restoreAllMocks()
  })

  it('不传 recalcIndicators 时，params 变化不会调用任何外部函数', async () => {
    const { wrapper } = mountChart()
    await flushPromises()
    const toolbar = getToolbarStub(wrapper)
    await toolbar.vm.applyUpdate({ params: { KDJ: { n: 14, m1: 5, m2: 3 } } })
    await flushPromises()
    expect(getPrefs(wrapper).params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
  })

  it('传 recalcIndicators 时，params 变化会调用它', async () => {
    const recalc = vi.fn(async () => {})
    const { wrapper } = mountChart({ recalcIndicators: recalc })
    await flushPromises()
    const toolbar = getToolbarStub(wrapper)
    await toolbar.vm.applyUpdate({ params: { KDJ: { n: 14, m1: 5, m2: 3 } } })
    await flushPromises()
    expect(recalc).toHaveBeenCalledTimes(1)
    expect(recalc).toHaveBeenCalledWith({ KDJ: { n: 14, m1: 5, m2: 3 } })
    expect(getPrefs(wrapper).params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
  })

  it('recalcIndicators 失败时会回滚 params 并重新抛出错误，Toolbar 同步收到旧参数', async () => {
    const recalc = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('backend failed'))
    const { wrapper, errorHandler } = mountChart({ recalcIndicators: recalc })
    await flushPromises()
    const toolbar = getToolbarStub(wrapper)

    // 先设置一个旧版成功值
    await toolbar.vm.applyUpdate({ params: { KDJ: { n: 10, m1: 3, m2: 3 } } })
    await flushPromises()
    expect(getPrefs(wrapper).params).toEqual({ KDJ: { n: 10, m1: 3, m2: 3 } })
    expect(toolbar.props('prefs').params).toEqual({ KDJ: { n: 10, m1: 3, m2: 3 } })

    // 再改成新参数，触发失败与回滚
    await toolbar.vm.applyUpdate({ params: { KDJ: { n: 14, m1: 5, m2: 3 } } })
    await flushPromises()

    expect(recalc).toHaveBeenCalledTimes(2)
    expect(recalc).toHaveBeenLastCalledWith({ KDJ: { n: 14, m1: 5, m2: 3 } })
    expect(getPrefs(wrapper).params).toEqual({ KDJ: { n: 10, m1: 3, m2: 3 } })
    expect(toolbar.props('prefs').params).toEqual({ KDJ: { n: 10, m1: 3, m2: 3 } })
    expect(errorHandler).toHaveBeenCalled()
    expect((errorHandler as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(Error)
    expect((errorHandler as ReturnType<typeof vi.fn>).mock.calls[0][0].message).toBe('backend failed')
  })

  it('recalcIndicators 成功时不会回滚', async () => {
    const recalc = vi.fn(async () => {})
    const { wrapper } = mountChart({ recalcIndicators: recalc })
    await flushPromises()
    const toolbar = getToolbarStub(wrapper)
    await toolbar.vm.applyUpdate({ params: { KDJ: { n: 14, m1: 5, m2: 3 } } })
    await flushPromises()
    expect(getPrefs(wrapper).params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
    expect(recalc).toHaveBeenCalledTimes(1)
  })
})
