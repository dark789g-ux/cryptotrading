/**
 * FeatureLabelFields：特征/标签参数 + winsorize 成对报错。
 *
 * 2026-06-05 quant-label-management spec 更新：
 *  - fwd_horizon_days / max_hold_days 已从 FeatureLabelModel 移除（已进标签定义）
 *  - labelScheme prop 不再存在，FeatureLabelFields 无条件渲染其余字段
 *  - winsorize 成对校验保留不变
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NInputNumber } from 'naive-ui'
import FeatureLabelFields from '../train/train-modal/FeatureLabelFields.vue'

const EMPTY = {
  neutralize_cols: null,
  robust_z: null,
  factor_clip_sigma: null,
  label_winsorize_lo: null,
  label_winsorize_hi: null,
}

describe('FeatureLabelFields scheme 专属字段已移除', () => {
  it('不渲染 fwd_horizon_days（已进标签定义）', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY } },
    })
    expect(w.text()).not.toContain('fwd_horizon_days')
  })

  it('不渲染 max_hold_days（已进标签定义）', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY } },
    })
    expect(w.text()).not.toContain('max_hold_days')
  })
})

describe('FeatureLabelFields winsorize 成对校验', () => {
  it('只填 lo → 内联报错', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY, label_winsorize_lo: -0.5 } },
    })
    expect(w.text()).toContain('上下界必须同时填写或同时留空')
  })

  it('两者皆填 → 不报错', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY, label_winsorize_lo: -0.5, label_winsorize_hi: 0.5 } },
    })
    expect(w.text()).not.toContain('上下界必须同时填写或同时留空')
  })

  it('两者皆空 → 不报错', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY } },
    })
    expect(w.text()).not.toContain('上下界必须同时填写或同时留空')
  })
})

describe('FeatureLabelFields emit', () => {
  it('修改数字字段 → emit update:modelValue', async () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY } },
    })
    // factor_clip_sigma 是数字输入中的第一个
    w.findAllComponents(NInputNumber)[0].vm.$emit('update:value', 3.0)
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')).toBeTruthy()
  })
})
