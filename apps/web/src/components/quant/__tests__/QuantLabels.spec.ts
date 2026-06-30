/**
 * 标签库管理：组件渲染 + 动态字段切换。
 *
 * 覆盖（04-frontend.md 硬约束 + 06-validation-and-testing.md 测试矩阵）：
 *  - BaseTypeFields：base_type 切换 → 动态字段（horizon / max_hold_days）
 *  - ClassifyFields：classify_mode 切换 → 动态字段（eps / tercile 提示 / custom 分位）
 *  - buildParams.parseLabelRef：key 解析 + 边界情况
 *  - LabelTable：基础渲染（摘要文本）
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { NSelect } from 'naive-ui'
import BaseTypeFields from '../label/label-modal/BaseTypeFields.vue'
import ClassifyFields from '../label/label-modal/ClassifyFields.vue'

// BaseTypeFields 在 strategy_aware 下会拉 enabled 策略列表，单测里 mock 掉避免真实 fetch
vi.mock('@/api/modules/quant', () => ({
  quantApi: {
    listStrategies: vi.fn().mockResolvedValue({
      items: [
        {
          strategy_id: 'default_exit',
          strategy_version: 'v1',
          name: '默认出场策略',
          exit_rules: [],
          description: null,
          enabled: true,
          display_order: 0,
          created_at: '2026-06-06 00:00:00Z',
        },
      ],
    }),
  },
}))

// ---- BaseTypeFields ----

const BASE_FWD = { base_type: 'fwd_ret', base_params: { horizon: 1 } }
const BASE_STRAT = { base_type: 'strategy_aware', base_params: {} }

describe('BaseTypeFields 动态字段切换', () => {
  it('fwd_ret → 显示 horizon 字段，不显示引用策略', () => {
    const w = mount(BaseTypeFields, { props: { modelValue: BASE_FWD } })
    expect(w.text()).toContain('horizon')
    expect(w.text()).not.toContain('引用策略')
  })

  it('strategy_aware → 显示引用策略选择器，不显示 horizon', () => {
    const w = mount(BaseTypeFields, { props: { modelValue: BASE_STRAT } })
    expect(w.text()).toContain('引用策略')
    expect(w.text()).not.toContain('horizon（天）')
  })

  it('切换 base_type → emit update:modelValue 并把 strategy_aware 的 base_params 置空待选', async () => {
    const w = mount(BaseTypeFields, { props: { modelValue: BASE_FWD } })
    // 通过第一个 NSelect（base_type 下拉）触发
    w.findAllComponents(NSelect)[0].vm.$emit('update:value', 'strategy_aware')
    await w.vm.$nextTick()
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    const payload = (emitted as unknown[][])[0][0] as { base_type: string; base_params: Record<string, unknown> }
    expect(payload.base_type).toBe('strategy_aware')
    // 切入 strategy_aware 时 base_params 置空（待用户从下拉选）
    expect(payload.base_params).toEqual({})
  })
})

// ---- ClassifyFields ----

const CLS_NULL = { classify_mode: null, classify_params: null }
const CLS_BAND = { classify_mode: 'band', classify_params: { eps: 0.005 } }
const CLS_TERCILE = { classify_mode: 'tercile', classify_params: {} }
const CLS_CUSTOM = { classify_mode: 'custom', classify_params: { lo_pct: 33, hi_pct: 67 } }

describe('ClassifyFields 动态字段切换', () => {
  it('null（连续）→ 不显示任何额外字段', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_NULL } })
    expect(w.text()).not.toContain('横盘阈值')
    expect(w.text()).not.toContain('截面三分位')
    expect(w.text()).not.toContain('下界分位')
  })

  it('band → 显示 ε 字段', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_BAND } })
    expect(w.text()).toContain('横盘阈值 ε')
  })

  it('tercile → 显示无额外参数提示', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_TERCILE } })
    expect(w.text()).toContain('截面三分位')
  })

  it('custom → 显示上下界分位输入', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_CUSTOM } })
    expect(w.text()).toContain('下界分位')
    expect(w.text()).toContain('上界分位')
  })

  it('切换 classify_mode → emit update:modelValue 并重置 classify_params', async () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_NULL } })
    w.findAllComponents(NSelect)[0].vm.$emit('update:value', 'band')
    await w.vm.$nextTick()
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    const payload = (emitted as unknown[][])[0][0] as { classify_mode: string; classify_params: Record<string, unknown> | null }
    expect(payload.classify_mode).toBe('band')
    expect(payload.classify_params).toHaveProperty('eps')
  })
})

// parseLabelRef 已随 E2E 路径一同从 buildParams 删除（2026-06-06 close_adj 改造）
