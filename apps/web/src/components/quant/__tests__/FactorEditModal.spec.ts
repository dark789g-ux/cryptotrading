/**
 * FactorEditModal 单测（factor-registry-frontend spec / 06-testing.md §3）。
 *
 * 覆盖：
 *  - formula / data_source 字段渲染为 readonly
 *  - description 长度校验（空 → disable 保存按钮；>500 → maxlength 兜底）
 *  - pit_window_days 越界（0 / 401）→ canSubmit=false
 *  - 修改 pit_window_days/category/pit_anchor 时显示警告 banner
 *  - 保存按钮调 quantApi.updateFactor mock，传 patch 正确
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

// 跨 case 间累积的 attachTo: body 节点，统一清理避免上一个测试的 modal 残留干扰
// `document.querySelector('[data-testid=...]')` 等断言。
const mountedWrappers: Array<{ unmount: () => void }> = []

import FactorEditModal from '../FactorEditModal.vue'
import type { FactorDefinition } from '@/api/modules/quant'

const updateFactorMock = vi.fn()

vi.mock('@/api/modules/quant', async () => {
  const actual = await vi.importActual<typeof import('@/api/modules/quant')>(
    '@/api/modules/quant',
  )
  return {
    ...actual,
    quantApi: {
      ...actual.quantApi,
      updateFactor: (...args: unknown[]) => updateFactorMock(...args),
    },
  }
})

function makeFactor(over: Partial<FactorDefinition> = {}): FactorDefinition {
  return {
    factor_id: 'momentum_20d',
    factor_version: 'v1',
    description: '20 日动量',
    formula: 'close_adj(T)/close_adj(T-20)-1',
    data_source: ['close_adj'],
    category: 'price',
    pit_window_days: 50,
    pit_anchor: 'trade_date',
    // min_trade_days=21 → minRequired = ceil(21 × 2.0) = 42；默认 pit_window_days=50 合法
    min_trade_days: 21,
    enabled: true,
    display_order: 100,
    updated_at: '2026-05-23 00:00:00Z',
    updated_by: null,
    ...over,
  }
}

function mountModal(factor: FactorDefinition | null) {
  const Wrapper = defineComponent({
    components: { NConfigProvider, NMessageProvider, FactorEditModal },
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(FactorEditModal, { show: true, factor }),
            }),
        })
    },
  })
  const w = mount(Wrapper, { attachTo: document.body })
  mountedWrappers.push(w)
  return w
}

function getModalVm(wrapper: ReturnType<typeof mountModal>) {
  const inner = wrapper.findComponent(FactorEditModal)
  return inner.vm as unknown as {
    form: {
      description: string
      category: FactorDefinition['category']
      pit_window_days: number
      pit_anchor: FactorDefinition['pit_anchor']
      display_order: number
    } | null
    canSubmit: boolean
    buildPatch: () => Record<string, unknown>
  }
}

describe('FactorEditModal', () => {
  beforeEach(() => {
    updateFactorMock.mockReset()
  })

  afterEach(() => {
    while (mountedWrappers.length > 0) {
      const w = mountedWrappers.pop()
      try {
        w?.unmount()
      } catch {
        /* ignore */
      }
    }
    // n-modal 把内容渲染到 body 末端 portal；unmount 后 portal 节点理应一并销毁，
    // 仍兜底清掉残留 data-testid 节点以避免下个 case 误命中。
    document.body
      .querySelectorAll('[data-testid="factor-edit-warning"]')
      .forEach((el) => el.remove())
  })

  it('formula / data_source 字段渲染为 readonly', async () => {
    const w = mountModal(makeFactor())
    await nextTick()
    await flushPromises()

    const formula = document.querySelector('[data-testid="factor-edit-formula"] textarea')
    const ds = document.querySelector('[data-testid="factor-edit-data-source"] input')
    expect(formula).toBeTruthy()
    expect(ds).toBeTruthy()
    expect((formula as HTMLTextAreaElement).readOnly).toBe(true)
    expect((ds as HTMLInputElement).readOnly).toBe(true)
  })

  it('初始化时 canSubmit=true（已存在合法值）', async () => {
    const w = mountModal(makeFactor())
    await nextTick()
    await flushPromises()
    const vm = getModalVm(w)
    expect(vm.canSubmit).toBe(true)
  })

  it('description 为空 → canSubmit=false', async () => {
    const w = mountModal(makeFactor())
    await nextTick()
    const vm = getModalVm(w)
    expect(vm.form).not.toBeNull()
    vm.form!.description = '   '
    await nextTick()
    expect(vm.canSubmit).toBe(false)
  })

  it('pit_window_days 越界 → canSubmit=false', async () => {
    const w = mountModal(makeFactor())
    await nextTick()
    const vm = getModalVm(w)

    vm.form!.pit_window_days = 0
    await nextTick()
    expect(vm.canSubmit).toBe(false)

    vm.form!.pit_window_days = 401
    await nextTick()
    expect(vm.canSubmit).toBe(false)

    vm.form!.pit_window_days = 200
    await nextTick()
    expect(vm.canSubmit).toBe(true)
  })

  it('修改 pit_window_days 时显示警告 banner', async () => {
    // 已存在合法值（50）—— minRequired=42 满足；改成 60 仍合法触发警告
    const w = mountModal(makeFactor({ pit_window_days: 50 }))
    await nextTick()
    const vm = getModalVm(w)

    // 初始无变更，warning 隐藏
    expect(document.querySelector('[data-testid="factor-edit-warning"]')).toBeFalsy()

    vm.form!.pit_window_days = 60
    await nextTick()
    expect(document.querySelector('[data-testid="factor-edit-warning"]')).toBeTruthy()
  })

  // ====== PIT 窗口护门校验（2026-05-23 spec §4.2） ======

  it('pit_window_days < ceil(min_trade_days × 2.0) → 保存按钮禁用 + hint 红色 + input error 状态', async () => {
    // min_trade_days=21，required=42；初始 pit_window_days=50（合法）
    const w = mountModal(makeFactor())
    await nextTick()
    const vm = getModalVm(w)

    // 改成 41 < 42 → 不满足
    vm.form!.pit_window_days = 41
    await nextTick()
    expect(vm.canSubmit).toBe(false)

    // 保存按钮 disabled
    const submit = document.querySelector(
      '[data-testid="factor-edit-submit"]',
    ) as HTMLButtonElement | null
    expect(submit).toBeTruthy()
    // n-button 渲染为 button，disabled 属性是真布尔，但 naive-ui 通过 .n-button--disabled class 标识
    expect(submit!.classList.contains('n-button--disabled')).toBe(true)

    // hint 显示红色 + 文案带 ">= 42"
    const hint = document.querySelector(
      '[data-testid="factor-edit-pit-window-hint"]',
    ) as HTMLElement | null
    expect(hint).toBeTruthy()
    expect(hint!.classList.contains('hint--error')).toBe(true)
    expect(hint!.textContent).toContain('21')
    expect(hint!.textContent).toContain('42')
  })

  it('pit_window_days = ceil(min_trade_days × 2.0) 临界值 → 保存按钮可点', async () => {
    const w = mountModal(makeFactor())
    await nextTick()
    const vm = getModalVm(w)

    vm.form!.pit_window_days = 42  // === required
    await nextTick()
    expect(vm.canSubmit).toBe(true)

    const submit = document.querySelector(
      '[data-testid="factor-edit-submit"]',
    ) as HTMLButtonElement | null
    expect(submit!.classList.contains('n-button--disabled')).toBe(false)
  })

  it('pit_window_days 合法 → hint 灰色（info）', async () => {
    const w = mountModal(makeFactor())
    await nextTick()
    const vm = getModalVm(w)
    vm.form!.pit_window_days = 50
    await nextTick()

    const hint = document.querySelector(
      '[data-testid="factor-edit-pit-window-hint"]',
    ) as HTMLElement | null
    expect(hint).toBeTruthy()
    expect(hint!.classList.contains('hint--info')).toBe(true)
    expect(hint!.classList.contains('hint--error')).toBe(false)
  })

  it('min_trade_days 不同 → minRequired 随之变化（向上取整）', async () => {
    // min_trade_days=20 → required = ceil(20 × 2.0) = 40
    const w = mountModal(makeFactor({ min_trade_days: 20, pit_window_days: 50 }))
    await nextTick()
    const vm = getModalVm(w)

    vm.form!.pit_window_days = 39
    await nextTick()
    expect(vm.canSubmit).toBe(false)

    vm.form!.pit_window_days = 40
    await nextTick()
    expect(vm.canSubmit).toBe(true)
  })

  it('修改 category 时显示警告 banner', async () => {
    const w = mountModal(makeFactor({ category: 'price' }))
    await nextTick()
    const vm = getModalVm(w)
    vm.form!.category = 'industry'
    await nextTick()
    expect(document.querySelector('[data-testid="factor-edit-warning"]')).toBeTruthy()
  })

  it('buildPatch 仅包含改动字段（partial update）', async () => {
    // 起点 50 也是合法（>= required 42），改到 60 触发 partial patch
    const w = mountModal(makeFactor({ description: 'old', pit_window_days: 50 }))
    await nextTick()
    const vm = getModalVm(w)
    vm.form!.description = 'new desc'
    vm.form!.pit_window_days = 60
    await nextTick()

    const patch = vm.buildPatch()
    expect(patch).toEqual({ description: 'new desc', pit_window_days: 60 })
  })

  it('点击保存调 updateFactor mock，emit saved 与 update:show', async () => {
    const initialFactor = makeFactor() // 稳定引用：避免父组件每次渲染都新建 factor 触发 watcher 重置 form
    const updatedRow = makeFactor({ description: 'new desc' })
    updateFactorMock.mockResolvedValue({ item: updatedRow })

    const savedEvents: FactorDefinition[] = []
    const updateShowEvents: boolean[] = []
    const Parent = defineComponent({
      components: { NConfigProvider, NMessageProvider, FactorEditModal },
      setup() {
        return () =>
          h(NConfigProvider, null, {
            default: () =>
              h(NMessageProvider, null, {
                default: () =>
                  h(FactorEditModal, {
                    show: true,
                    factor: initialFactor,
                    onSaved: (item: FactorDefinition) => savedEvents.push(item),
                    'onUpdate:show': (v: boolean) => updateShowEvents.push(v),
                  }),
              }),
          })
      },
    })
    const w = mount(Parent, { attachTo: document.body })
    mountedWrappers.push(w)
    await nextTick()
    await flushPromises()

    const inner = w.findComponent(FactorEditModal)
    const vm = inner.vm as unknown as {
      form: { description: string }
      canSubmit: boolean
      buildPatch: () => Record<string, unknown>
    }
    vm.form.description = 'new desc'
    await nextTick()
    // sanity check: buildPatch 当下应已捕获改动
    expect(vm.buildPatch()).toEqual({ description: 'new desc' })

    const submit = document.querySelector(
      '[data-testid="factor-edit-submit"]',
    ) as HTMLElement | null
    expect(submit).toBeTruthy()
    submit!.click()
    await flushPromises()

    expect(updateFactorMock).toHaveBeenCalledTimes(1)
    const [id, version, patch] = updateFactorMock.mock.calls[0]
    expect(id).toBe('momentum_20d')
    expect(version).toBe('v1')
    expect(patch).toEqual({ description: 'new desc' })

    expect(savedEvents).toHaveLength(1)
    expect(savedEvents[0].description).toBe('new desc')
    expect(updateShowEvents).toContain(false)
  })
})
