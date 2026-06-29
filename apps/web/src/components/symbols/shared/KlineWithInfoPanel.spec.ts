/**
 * KlineWithInfoPanel：K 线 + 可折叠信息侧栏共享布局单测。
 * - 默认折叠 / 展开 / 收起
 * - localStorage 持久化（按 storageKey 隔离）
 * - ResizeObserver 驱动的 canExpand 守卫（窄屏自动折叠、禁用触发按钮）
 * - kline / info 两个 slot 渲染
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

import KlineWithInfoPanel from './KlineWithInfoPanel.vue'

// 可控制的 ResizeObserver mock：捕获 callback，测试可手动 emit 宽度。
type ROCallback = (entries: ResizeObserverEntry[]) => void
let capturedROCallback: ROCallback | null = null
let observedTarget: Element | null = null

class MockResizeObserver {
  observe = vi.fn((target: Element) => {
    observedTarget = target
  })
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(cb: ROCallback) {
    capturedROCallback = cb
  }
}

function emitResize(width: number) {
  capturedROCallback?.([
    { contentRect: { width } } as unknown as ResizeObserverEntry,
  ])
}

function mountPanel(
  props: { storageKey: string; infoTitle?: string },
  slots: Record<string, unknown> = {},
) {
  return mount(KlineWithInfoPanel, {
    props,
    slots: {
      kline: '<div data-testid="kline-slot">KLINE</div>',
      info: '<div data-testid="info-slot">INFO</div>',
      ...slots,
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  capturedROCallback = null
  observedTarget = null
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('KlineWithInfoPanel', () => {
  it('默认折叠（localStorage 无值时 aside 不显示）', () => {
    const wrapper = mountPanel({ storageKey: 'a' })
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(false)
  })

  it('点击触发按钮展开', async () => {
    const wrapper = mountPanel({ storageKey: 'a' })
    await wrapper.find('.kline-with-info-panel__trigger').trigger('click')
    await nextTick()
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(true)
    // 展开后触发按钮（v-if !expanded）消失
    expect(wrapper.find('.kline-with-info-panel__trigger').exists()).toBe(false)
  })

  it('展开后点击侧栏头部折叠按钮收起', async () => {
    const wrapper = mountPanel({ storageKey: 'a' })
    await wrapper.find('.kline-with-info-panel__trigger').trigger('click')
    await nextTick()
    await wrapper.find('.kline-with-info-panel__collapse').trigger('click')
    await nextTick()
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(false)
  })

  it('展开状态写入 localStorage(storageKey)', async () => {
    const wrapper = mountPanel({ storageKey: 'a-share-info' })
    await wrapper.find('.kline-with-info-panel__trigger').trigger('click')
    await nextTick()
    expect(localStorage.getItem('a-share-info')).toBe('true')
  })

  it('不同 storageKey 互不干扰', () => {
    const w1 = mountPanel({ storageKey: 'a-share' })
    expect(w1.find('.kline-with-info-panel__aside').isVisible()).toBe(false)
    localStorage.setItem('a-share', 'true')
    w1.unmount()

    const w2 = mountPanel({ storageKey: 'crypto-info' })
    expect(w2.find('.kline-with-info-panel__aside').isVisible()).toBe(false)
  })

  it('从 localStorage 读取已展开状态作为初值', () => {
    localStorage.setItem('a-share', 'true')
    const wrapper = mountPanel({ storageKey: 'a-share' })
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(true)
  })

  it('容器宽度 < 620px 时触发按钮 disabled 且自动折叠', async () => {
    const wrapper = mountPanel({ storageKey: 'a' })
    await flushPromises()
    await nextTick()
    // 确认 ResizeObserver 已捕获 callback
    expect(capturedROCallback).not.toBeNull()
    await wrapper.find('.kline-with-info-panel__trigger').trigger('click')
    await nextTick()
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(true)

    // 模拟窄屏
    emitResize(500)
    await flushPromises()
    await nextTick()
    await flushPromises()

    // aside 应 display:none（isVisible 在 jsdom+scoped 下不可靠，改检 style）
    expect(wrapper.find('.kline-with-info-panel__aside').attributes('style')).toContain('display: none')
    const trigger = wrapper.find('.kline-with-info-panel__trigger')
    expect(trigger.exists()).toBe(true)
    expect(trigger.attributes('disabled')).toBeDefined()
  })

  it('中宽度容器(700px)展开后保持稳定，不因 kline 区收缩误折叠', async () => {
    // 回归：RO 观测容器宽度（≥620 即可展开），而非 kline 区宽度。
    // 若误观测 kline 区，展开后 kline 区 = 700-260 = 440 < 620 会触发误折叠。
    const wrapper = mountPanel({ storageKey: 'a' })
    await flushPromises()
    await nextTick()
    emitResize(700)
    await nextTick()

    await wrapper.find('.kline-with-info-panel__trigger').trigger('click')
    await nextTick()
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(true)

    // 再 emit 一次同宽度（模拟展开后 RO 对容器的回调）——应保持展开
    emitResize(700)
    await nextTick()
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(true)
  })

  it('窄屏恢复 >= 620px 时 canExpand 恢复但不自动展开', async () => {
    const wrapper = mountPanel({ storageKey: 'a' })
    await flushPromises()
    emitResize(500)
    await nextTick()
    expect(
      wrapper.find('.kline-with-info-panel__trigger').attributes('disabled'),
    ).toBeDefined()

    // 恢复宽屏
    emitResize(900)
    await nextTick()
    expect(
      wrapper.find('.kline-with-info-panel__trigger').attributes('disabled'),
    ).toBeUndefined()
    expect(wrapper.find('.kline-with-info-panel__aside').isVisible()).toBe(false)
  })

  it('kline slot 内容渲染', () => {
    const wrapper = mountPanel(
      { storageKey: 'a' },
      { kline: '<div data-testid="custom-kline">MY-KLINE</div>' },
    )
    expect(wrapper.find('[data-testid="custom-kline"]').text()).toBe('MY-KLINE')
  })

  it('info slot 内容渲染', () => {
    const wrapper = mountPanel(
      { storageKey: 'a' },
      { info: '<div data-testid="custom-info">MY-INFO</div>' },
    )
    expect(wrapper.find('[data-testid="custom-info"]').text()).toBe('MY-INFO')
  })

  it('默认 infoTitle 为"标的信息"，可被 prop 覆盖', async () => {
    const wrapper = mountPanel({ storageKey: 'a' })
    await wrapper.find('.kline-with-info-panel__trigger').trigger('click')
    await nextTick()
    expect(wrapper.find('.kline-with-info-panel__title').text()).toBe('标的信息')

    const wrapper2 = mountPanel({ storageKey: 'b', infoTitle: '加密信息' })
    await wrapper2.find('.kline-with-info-panel__trigger').trigger('click')
    await nextTick()
    expect(wrapper2.find('.kline-with-info-panel__title').text()).toBe('加密信息')
  })
})
