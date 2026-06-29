/**
 * SymbolsPanelLayout：通用标的面板外壳组件单测。
 * - 按钮 emit（refresh、视图切换）
 * - 视图模式与分栏宽度的 localStorage 读写及校验
 * - table / split 两种形态下的 slot 渲染
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { NConfigProvider } from 'naive-ui'

import SymbolsPanelLayout from './SymbolsPanelLayout.vue'

const TEST_SCOPE = 'crypto'
const VIEW_MODE_KEY = `symbols_panel_view_mode_${TEST_SCOPE}`
const LEFT_WIDTH_KEY = `symbols_panel_split_width_${TEST_SCOPE}`

const ResizableSplitPaneStub = defineComponent({
  name: 'ResizableSplitPane',
  props: ['leftWidth', 'minWidthPx', 'maxRatio'],
  emits: ['update:leftWidth'],
  methods: {
    emitUpdate(val: number) {
      this.$emit('update:leftWidth', val)
    },
  },
  render() {
    return h('div', { class: 'resizable-split-pane-stub' }, [
      h('div', { class: 'rsp-left-stub' }, this.$slots.left?.()),
      h('div', { class: 'rsp-right-stub' }, this.$slots.right?.()),
    ])
  },
})

function mountLayout(props: Record<string, unknown> = {}, slots: Record<string, unknown> = {}) {
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(
          NConfigProvider,
          null,
          {
            default: () =>
              h(SymbolsPanelLayout, {
                scope: TEST_SCOPE,
                ...props,
              }, {
                'header-actions': () => h('div', { 'data-testid': 'header-actions-slot' }, 'header-actions'),
                filters: () => h('div', { 'data-testid': 'filters-slot' }, 'filters'),
                table: () => h('div', { 'data-testid': 'table-slot' }, 'table'),
                'split-left': () => h('div', { 'data-testid': 'split-left-slot' }, 'split-left'),
                'split-right': () => h('div', { 'data-testid': 'split-right-slot' }, 'split-right'),
                'empty-detail': () => h('div', { 'data-testid': 'empty-detail-slot' }, 'empty-detail'),
                ...Object.fromEntries(
                  Object.entries(slots).map(([key, value]) => [
                    key,
                    () => h('div', { 'data-testid': `${key}-slot` }, String(value)),
                  ]),
                ),
              }),
          },
        )
    },
  })

  return mount(Wrapper, {
    global: {
      stubs: {
        ResizableSplitPane: ResizableSplitPaneStub,
      },
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('SymbolsPanelLayout', () => {
  it('渲染 header 中的 Refresh / 视图切换按钮以及 header-actions slot', () => {
    const wrapper = mountLayout()
    const buttons = wrapper.findAll('button.n-button')

    expect(buttons).toHaveLength(2)
    expect(buttons[0].text()).toContain('Refresh')
    expect(wrapper.find('[data-testid="header-actions-slot"]').exists()).toBe(true)
  })

  it('Refresh 按钮在 loading 时不触发 refresh，loading 结束后可触发', async () => {
    const wrapperLoading = mountLayout({ loading: true })
    const refreshButtonLoading = wrapperLoading.findAll('button')[0]

    await refreshButtonLoading.trigger('click')
    expect(wrapperLoading.findComponent(SymbolsPanelLayout).emitted('refresh')).toBeUndefined()

    const wrapper = mountLayout({ loading: false })
    const refreshButton = wrapper.findAll('button')[0]

    await refreshButton.trigger('click')
    expect(wrapper.findComponent(SymbolsPanelLayout).emitted('refresh')).toHaveLength(1)
  })

  function layoutEmitted(wrapper: ReturnType<typeof mountLayout>, event: string) {
    return wrapper.findComponent(SymbolsPanelLayout).emitted(event)
  }

  it('视图切换按钮在 table 模式显示 GridOutline 并切换到 split，同时持久化到 localStorage', async () => {
    const wrapper = mountLayout()
    const toggleButton = wrapper.findAll('button.n-button')[1]

    expect(localStorage.getItem(VIEW_MODE_KEY)).toBeNull()

    await toggleButton.trigger('click')

    expect(layoutEmitted(wrapper, 'update:viewMode')).toHaveLength(1)
    expect(layoutEmitted(wrapper, 'update:viewMode')![0]).toEqual(['split'])
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('split')
  })

  it('视图切换按钮在 split 模式显示 ListOutline 并切换回 table', async () => {
    const wrapper = mountLayout({ viewMode: 'split' })
    const toggleButton = wrapper.findAll('button.n-button')[1]

    await toggleButton.trigger('click')

    expect(layoutEmitted(wrapper, 'update:viewMode')).toHaveLength(1)
    expect(layoutEmitted(wrapper, 'update:viewMode')![0]).toEqual(['table'])
  })

  it('从 localStorage 读取合法的 viewMode', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'split')
    const wrapper = mountLayout()

    // 初始读取不会触发 emit，仅根据持久化值渲染 split 视图
    expect(layoutEmitted(wrapper, 'update:viewMode')).toBeUndefined()
    expect(wrapper.find('[data-testid="split-left-slot"]').exists()).toBe(true)
  })

  it('localStorage 中 viewMode 非法时回退到 table', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'invalid')
    const wrapper = mountLayout()

    expect(wrapper.find('[data-testid="table-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="split-left-slot"]').exists()).toBe(false)
  })

  it('从 localStorage 读取合法的 leftWidth 并传递给 ResizableSplitPane', () => {
    localStorage.setItem(LEFT_WIDTH_KEY, '0.55')
    const wrapper = mountLayout({ viewMode: 'split' })
    const pane = wrapper.findComponent({ name: 'ResizableSplitPane' })

    expect(pane.props('leftWidth')).toBe(0.55)
  })

  it('localStorage 中 leftWidth 超出 [0.2, 0.6] 时回退到 0.4', () => {
    localStorage.setItem(LEFT_WIDTH_KEY, '0.9')
    const wrapper = mountLayout({ viewMode: 'split' })
    const pane = wrapper.findComponent({ name: 'ResizableSplitPane' })

    expect(pane.props('leftWidth')).toBe(0.4)
  })

  it('ResizableSplitPane 更新 leftWidth 时持久化到 localStorage 并触发 emit', async () => {
    const wrapper = mountLayout({ viewMode: 'split' })
    const pane = wrapper.findComponent({ name: 'ResizableSplitPane' })
    const vm = pane.vm as unknown as { emitUpdate: (val: number) => void }

    vm.emitUpdate(0.35)
    await nextTick()

    expect(layoutEmitted(wrapper, 'update:leftWidth')).toHaveLength(1)
    expect(layoutEmitted(wrapper, 'update:leftWidth')![0]).toEqual([0.35])
    expect(localStorage.getItem(LEFT_WIDTH_KEY)).toBe('0.35')
  })

  it('ResizableSplitPane 更新超出范围的 leftWidth 时会被钳制到 [0.2, 0.6]', async () => {
    const wrapper = mountLayout({ viewMode: 'split' })
    const pane = wrapper.findComponent({ name: 'ResizableSplitPane' })
    const vm = pane.vm as unknown as { emitUpdate: (val: number) => void }

    vm.emitUpdate(0.05)
    await nextTick()

    expect(layoutEmitted(wrapper, 'update:leftWidth')![0]).toEqual([0.2])
    expect(localStorage.getItem(LEFT_WIDTH_KEY)).toBe('0.2')
  })

  it('table 模式下渲染 filters 与 table slot，不渲染 split slot', () => {
    const wrapper = mountLayout()

    expect(wrapper.find('[data-testid="filters-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="table-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="split-left-slot"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="split-right-slot"]').exists()).toBe(false)
  })

  it('split 模式下渲染 filters、split-left 与 split-right slot', () => {
    const wrapper = mountLayout({ viewMode: 'split' })

    expect(wrapper.find('[data-testid="filters-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="split-left-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="split-right-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="table-slot"]').exists()).toBe(false)
  })

  it('split 模式下 showEmptyDetail=true 时渲染 empty-detail slot 而非 split-right', () => {
    const wrapper = mountLayout({ viewMode: 'split', showEmptyDetail: true })

    expect(wrapper.find('[data-testid="split-left-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="empty-detail-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="split-right-slot"]').exists()).toBe(false)
  })
})
