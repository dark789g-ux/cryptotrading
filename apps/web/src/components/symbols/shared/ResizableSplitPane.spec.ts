/**
 * ResizableSplitPane：通用可拖拽左右分栏组件单测。
 * - 左右 slot 渲染与初始宽度
 * - pointer 拖拽事件、min/max 约束、body 样式切换
 * - 窄屏（≤960px）上下堆叠退化
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

import ResizableSplitPane from './ResizableSplitPane.vue'

const CONTAINER_WIDTH = 1000

function createPointerEvent(
  type: string,
  options: { clientX: number; pointerId?: number },
): PointerEvent {
  const { clientX, pointerId = 1 } = options
  if (typeof PointerEvent !== 'undefined') {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      pointerId,
    })
  }
  // 部分测试环境没有 PointerEvent，回退到 MouseEvent 并补充 pointerId
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
  }) as unknown as PointerEvent
  ;(event as unknown as { pointerId: number }).pointerId = pointerId
  return event
}

function mountPane(props: Record<string, unknown> = {}) {
  const wrapper = mount(ResizableSplitPane, {
    attachTo: document.body,
    props,
    slots: {
      left: '<div data-testid="left-slot">Left</div>',
      right: '<div data-testid="right-slot">Right</div>',
    },
  })

  const container = wrapper.find('.rsp-split-pane').element as HTMLElement
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
    width: CONTAINER_WIDTH,
    height: 600,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 600,
    right: CONTAINER_WIDTH,
    toJSON: () => {},
  })

  return wrapper
}

function getDivider(wrapper: ReturnType<typeof mountPane>) {
  return wrapper.find('.rsp-divider').element as HTMLElement
}

function getContainer(wrapper: ReturnType<typeof mountPane>) {
  return wrapper.find('.rsp-split-pane').element as HTMLElement
}

function mockMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 960px)' && window.innerWidth <= 960,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

beforeEach(() => {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  mockMatchMedia()
})

afterEach(() => {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
})

describe('ResizableSplitPane', () => {
  it('渲染左右两个 slot', () => {
    const wrapper = mountPane()

    expect(wrapper.find('[data-testid="left-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="right-slot"]').exists()).toBe(true)
  })

  it('默认左侧面板宽度比例为 0.4', () => {
    const wrapper = mountPane()
    const container = getContainer(wrapper)

    expect(container.style.getPropertyValue('--left-ratio')).toBe('0.4')
  })

  it('prop leftWidth 超过 maxRatio 时会被钳制到 maxRatio', async () => {
    const wrapper = mountPane({ leftWidth: 0.4 })
    await wrapper.setProps({ leftWidth: 0.9 })
    await nextTick()
    await nextTick()
    const container = getContainer(wrapper)

    expect(container.style.getPropertyValue('--left-ratio')).toBe('0.6')
  })

  it('prop leftWidth 对应的像素小于 minWidthPx 时会被钳制到 minWidthPx', async () => {
    const wrapper = mountPane({ leftWidth: 0.4 })
    await wrapper.setProps({ leftWidth: 0.1 })
    await nextTick()
    await nextTick()
    const container = getContainer(wrapper)

    // 最小宽度 240px / 1000px = 0.24
    expect(container.style.getPropertyValue('--left-ratio')).toBe('0.24')
  })

  it('pointerdown 时给 body 添加 user-select:none 与 col-resize 光标；pointerup 后移除', async () => {
    const wrapper = mountPane()
    const divider = getDivider(wrapper)

    divider.dispatchEvent(createPointerEvent('pointerdown', { clientX: 400 }))
    await nextTick()
    expect(document.body.style.userSelect).toBe('none')
    expect(document.body.style.cursor).toBe('col-resize')

    divider.dispatchEvent(createPointerEvent('pointerup', { clientX: 400 }))
    await nextTick()
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')
  })

  it('拖拽 divider 时左侧面板比例实时变化，结束后 emit update:leftWidth', async () => {
    const wrapper = mountPane()
    const divider = getDivider(wrapper)
    const container = getContainer(wrapper)

    divider.dispatchEvent(createPointerEvent('pointerdown', { clientX: 400 }))
    divider.dispatchEvent(createPointerEvent('pointermove', { clientX: 500 }))
    await nextTick()
    expect(container.style.getPropertyValue('--left-ratio')).toBe('0.5')

    divider.dispatchEvent(createPointerEvent('pointerup', { clientX: 500 }))
    await nextTick()

    expect(wrapper.emitted('update:leftWidth')).toHaveLength(1)
    expect(wrapper.emitted('update:leftWidth')![0]).toEqual([0.5])
  })

  it('拖拽时受 maxRatio 约束', async () => {
    const wrapper = mountPane()
    const divider = getDivider(wrapper)

    divider.dispatchEvent(createPointerEvent('pointerdown', { clientX: 400 }))
    divider.dispatchEvent(createPointerEvent('pointermove', { clientX: 800 }))
    divider.dispatchEvent(createPointerEvent('pointerup', { clientX: 800 }))
    await nextTick()

    expect(wrapper.emitted('update:leftWidth')![0]).toEqual([0.6])
  })

  it('拖拽时受 minWidthPx 约束', async () => {
    const wrapper = mountPane()
    const divider = getDivider(wrapper)

    divider.dispatchEvent(createPointerEvent('pointerdown', { clientX: 400 }))
    divider.dispatchEvent(createPointerEvent('pointermove', { clientX: 100 }))
    divider.dispatchEvent(createPointerEvent('pointerup', { clientX: 100 }))
    await nextTick()

    // 最小宽度 240px / 1000px = 0.24
    expect(wrapper.emitted('update:leftWidth')![0]).toEqual([0.24])
  })

  it('窗口宽度 ≤960px 时退化为上下堆叠并隐藏 divider', async () => {
    const originalInnerWidth = window.innerWidth
    window.innerWidth = 800
    mockMatchMedia()

    const wrapper = mountPane()
    await nextTick()

    expect(wrapper.classes()).toContain('is-narrow')

    window.innerWidth = originalInnerWidth
    window.dispatchEvent(new Event('resize'))
  })
})
