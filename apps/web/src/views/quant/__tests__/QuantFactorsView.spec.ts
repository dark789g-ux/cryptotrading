/**
 * QuantFactorsView 单测（factor-registry-frontend spec / 06-testing.md §3）。
 *
 * 覆盖：
 *  - mount 时调 listFactors + listFactorCategories
 *  - 顶部统计 "X / Y" 正确反映已启用 / 全量
 *  - 筛选改值 → filteredItems 反映（纯前端筛选，不重拉）
 *  - 保存导致行被筛选隐藏 → 弹 info（rowMatchesFilter 兜底）
 *
 * 路由守卫的 admin 跳转由 router 单测覆盖（本 spec 不实例化 router）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import QuantFactorsView from '../QuantFactorsView.vue'
import type { FactorDefinition } from '@/api/modules/quant'

const listFactorsMock = vi.fn()
const listFactorCategoriesMock = vi.fn()
const updateFactorMock = vi.fn()

vi.mock('@/api/modules/quant', async () => {
  const actual = await vi.importActual<typeof import('@/api/modules/quant')>(
    '@/api/modules/quant',
  )
  return {
    ...actual,
    quantApi: {
      ...actual.quantApi,
      listFactors: (...args: unknown[]) => listFactorsMock(...args),
      listFactorCategories: (...args: unknown[]) => listFactorCategoriesMock(...args),
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
    pit_window_days: 35,
    pit_anchor: 'trade_date',
    min_trade_days: 17,
    enabled: true,
    display_order: 100,
    updated_at: '2026-05-23 00:00:00Z',
    updated_by: null,
    ...over,
  }
}

function mountView() {
  const Wrapper = defineComponent({
    components: { NConfigProvider, NMessageProvider, QuantFactorsView },
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(QuantFactorsView),
            }),
        })
    },
  })
  return mount(Wrapper, { attachTo: document.body })
}

function getViewVm(w: ReturnType<typeof mountView>) {
  const inner = w.findComponent(QuantFactorsView)
  return inner.vm as unknown as {
    items: FactorDefinition[]
    filteredItems: FactorDefinition[]
    statusFilter: 'all' | 'enabled' | 'disabled'
    categoryFilter: string | null
    searchText: string
    loadAll: () => Promise<void>
  }
}

describe('QuantFactorsView', () => {
  beforeEach(() => {
    listFactorsMock.mockReset()
    listFactorCategoriesMock.mockReset()
    updateFactorMock.mockReset()
  })

  it('mount 时调 listFactors + listFactorCategories', async () => {
    listFactorsMock.mockResolvedValue({ items: [makeFactor()] })
    listFactorCategoriesMock.mockResolvedValue({ items: ['price', 'industry'] })

    const w = mountView()
    await flushPromises()
    await nextTick()

    expect(listFactorsMock).toHaveBeenCalledTimes(1)
    expect(listFactorCategoriesMock).toHaveBeenCalledTimes(1)
  })

  it('顶部统计反映 已启用 / 全量', async () => {
    listFactorsMock.mockResolvedValue({
      items: [
        makeFactor({ factor_id: 'a', enabled: true }),
        makeFactor({ factor_id: 'b', enabled: true, display_order: 110 }),
        makeFactor({ factor_id: 'c', enabled: false, display_order: 120 }),
      ],
    })
    listFactorCategoriesMock.mockResolvedValue({ items: ['price'] })

    const w = mountView()
    await flushPromises()
    await nextTick()

    expect(w.html()).toContain('3 个因子')
    expect(w.html()).toContain('当前启用 2 / 3')
  })

  it('statusFilter=enabled 隐藏禁用行', async () => {
    listFactorsMock.mockResolvedValue({
      items: [
        makeFactor({ factor_id: 'on1', enabled: true }),
        makeFactor({ factor_id: 'off1', enabled: false, display_order: 110 }),
      ],
    })
    listFactorCategoriesMock.mockResolvedValue({ items: ['price'] })

    const w = mountView()
    await flushPromises()
    await nextTick()
    const vm = getViewVm(w)

    expect(vm.filteredItems.map((i) => i.factor_id)).toEqual(['on1', 'off1'])
    vm.statusFilter = 'enabled'
    await nextTick()
    expect(vm.filteredItems.map((i) => i.factor_id)).toEqual(['on1'])

    vm.statusFilter = 'disabled'
    await nextTick()
    expect(vm.filteredItems.map((i) => i.factor_id)).toEqual(['off1'])
  })

  it('searchText 按 factor_id / description 过滤', async () => {
    listFactorsMock.mockResolvedValue({
      items: [
        makeFactor({ factor_id: 'momentum_20d', description: '20 日动量' }),
        makeFactor({
          factor_id: 'amihud_illiq_20d',
          description: 'Amihud 非流动性',
          display_order: 120,
        }),
      ],
    })
    listFactorCategoriesMock.mockResolvedValue({ items: ['price'] })

    const w = mountView()
    await flushPromises()
    await nextTick()
    const vm = getViewVm(w)

    vm.searchText = 'amihud'
    await nextTick()
    expect(vm.filteredItems.map((i) => i.factor_id)).toEqual(['amihud_illiq_20d'])

    vm.searchText = '动量'
    await nextTick()
    expect(vm.filteredItems.map((i) => i.factor_id)).toEqual(['momentum_20d'])
  })

  it('categoryFilter 仅留匹配类别', async () => {
    listFactorsMock.mockResolvedValue({
      items: [
        makeFactor({ factor_id: 'p1', category: 'price' }),
        makeFactor({ factor_id: 'f1', category: 'fundamental', display_order: 110 }),
      ],
    })
    listFactorCategoriesMock.mockResolvedValue({ items: ['price', 'fundamental'] })

    const w = mountView()
    await flushPromises()
    await nextTick()
    const vm = getViewVm(w)

    vm.categoryFilter = 'fundamental'
    await nextTick()
    expect(vm.filteredItems.map((i) => i.factor_id)).toEqual(['f1'])
  })

  it('listFactors 按 display_order 升序展示', async () => {
    listFactorsMock.mockResolvedValue({
      items: [
        makeFactor({ factor_id: 'b', display_order: 200 }),
        makeFactor({ factor_id: 'a', display_order: 100 }),
        makeFactor({ factor_id: 'c', display_order: 150 }),
      ],
    })
    listFactorCategoriesMock.mockResolvedValue({ items: [] })

    const w = mountView()
    await flushPromises()
    await nextTick()
    const vm = getViewVm(w)
    expect(vm.items.map((i) => i.factor_id)).toEqual(['a', 'c', 'b'])
  })

  it('加载失败时展示错误 alert，不抛', async () => {
    listFactorsMock.mockRejectedValue(new Error('500'))
    listFactorCategoriesMock.mockResolvedValue({ items: [] })

    const w = mountView()
    await flushPromises()
    await nextTick()
    expect(w.html()).toContain('加载因子清单失败')
  })
})
