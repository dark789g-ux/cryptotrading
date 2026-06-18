import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NButton, NConfigProvider, NInputNumber } from 'naive-ui'

import KlineChartToolbar from './KlineChartToolbar.vue'
import KdjParamsEditor from './KdjParamsEditor.vue'
import { DEFAULT_KDJ_PARAMS } from '@/composables/kline/subplotConfig'

function mountToolbar(props: {
  granularity?: 'date' | 'hour' | 'minute'
  range?: [number, number] | null
  prefsKey?: string
} = {}) {
  const onUpdateRange = vi.fn()
  const onUpdatePrefs = vi.fn()

  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(
          NConfigProvider,
          null,
          {
            default: () =>
              h(KlineChartToolbar, {
                granularity: props.granularity ?? 'date',
                range: props.range ?? null,
                prefsKey: props.prefsKey ?? 'test-toolbar',
                'onUpdate:range': onUpdateRange,
                'onUpdate:prefs': onUpdatePrefs,
              }),
          },
        )
    },
  })

  const wrapper = mount(Wrapper, { attachTo: document.body })
  return { wrapper, onUpdateRange, onUpdatePrefs }
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

  it('修改参数 → 点确定 → update:prefs 携带 params.KDJ', async () => {
    const { wrapper, onUpdatePrefs } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    // 清除初始 mount 与 watch 触发的事件，避免干扰
    onUpdatePrefs.mockClear()

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

    expect(onUpdatePrefs).toHaveBeenCalled()
    const lastCall = onUpdatePrefs.mock.calls[onUpdatePrefs.mock.calls.length - 1][0]
    expect(lastCall.params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
  })

  it('点取消 → 不更新 params.KDJ', async () => {
    const { wrapper, onUpdatePrefs } = mountToolbar()
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    onUpdatePrefs.mockClear()

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

    // 取消不改变 prefs，因此不应有携带自定义 KDJ 参数的 update:prefs
    const callsWithKdj = onUpdatePrefs.mock.calls.filter(
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
    const storage = mockLocalStorage()
    storage['kline-chart-prefs:test-kdj-name'] = JSON.stringify({
      order: ['VOL', 'KDJ'],
      visibility: { VOL: true, KDJ: true },
      heightPct: { VOL: 8, KDJ: 8 },
      params: { KDJ: { n: 14, m1: 5, m2: 3 } },
    })

    const { wrapper } = mountToolbar({ prefsKey: 'test-kdj-name' })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openSubplotPanel(wrapper)

    expect(document.body.textContent ?? '').toContain('KDJ(14,5,3)')
  })

  it('KDJ 参数为默认值时仍显示 "KDJ"', async () => {
    const storage = mockLocalStorage()
    storage['kline-chart-prefs:test-kdj-default'] = JSON.stringify({
      order: ['VOL', 'KDJ'],
      visibility: { VOL: true, KDJ: true },
      heightPct: { VOL: 8, KDJ: 8 },
      params: { KDJ: DEFAULT_KDJ_PARAMS },
    })

    const { wrapper } = mountToolbar({ prefsKey: 'test-kdj-default' })
    lastWrapper = wrapper
    await flushPromises()
    await nextTick()

    await openSubplotPanel(wrapper)

    const text = document.body.textContent ?? ''
    expect(text).toContain('KDJ')
    expect(text).not.toContain('KDJ(')
  })
})
