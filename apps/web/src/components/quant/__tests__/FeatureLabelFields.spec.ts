/**
 * FeatureLabelFields：特征/标签参数显隐 + winsorize 成对报错。
 *  - fwd_horizon_days 仅 label_scheme=fwd_5d_ret 显示
 *  - max_hold_days 仅 label_scheme=strategy-aware 显示
 *  - winsorize 只填一个 → 内联报错文案出现；成对 → 不报错
 *  - 修改字段 → emit update:modelValue
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NInputNumber } from 'naive-ui'
import FeatureLabelFields from '../train-modal/FeatureLabelFields.vue'

const EMPTY = {
  neutralize_cols: null,
  robust_z: null,
  factor_clip_sigma: null,
  label_winsorize_lo: null,
  label_winsorize_hi: null,
  fwd_horizon_days: null,
  max_hold_days: null,
}

describe('FeatureLabelFields 条件字段显隐', () => {
  it('fwd_5d_ret → 显示 fwd_horizon_days，不显示 max_hold_days', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY }, labelScheme: 'fwd_5d_ret' },
    })
    expect(w.text()).toContain('fwd_horizon_days')
    expect(w.text()).not.toContain('max_hold_days')
  })

  it('strategy-aware → 显示 max_hold_days，不显示 fwd_horizon_days', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY }, labelScheme: 'strategy-aware' },
    })
    expect(w.text()).toContain('max_hold_days')
    expect(w.text()).not.toContain('fwd_horizon_days')
  })

  it('dir3_band → 两个条件字段都不显示', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY }, labelScheme: 'dir3_band' },
    })
    expect(w.text()).not.toContain('fwd_horizon_days')
    expect(w.text()).not.toContain('max_hold_days')
  })
})

describe('FeatureLabelFields winsorize 成对校验', () => {
  it('只填 lo → 内联报错', () => {
    const w = mount(FeatureLabelFields, {
      props: {
        modelValue: { ...EMPTY, label_winsorize_lo: -0.5 },
        labelScheme: 'fwd_5d_ret',
      },
    })
    expect(w.text()).toContain('上下界必须同时填写或同时留空')
  })

  it('两者皆填 → 不报错', () => {
    const w = mount(FeatureLabelFields, {
      props: {
        modelValue: { ...EMPTY, label_winsorize_lo: -0.5, label_winsorize_hi: 0.5 },
        labelScheme: 'fwd_5d_ret',
      },
    })
    expect(w.text()).not.toContain('上下界必须同时填写或同时留空')
  })

  it('两者皆空 → 不报错', () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY }, labelScheme: 'fwd_5d_ret' },
    })
    expect(w.text()).not.toContain('上下界必须同时填写或同时留空')
  })
})

describe('FeatureLabelFields emit', () => {
  it('修改数字字段 → emit update:modelValue', async () => {
    const w = mount(FeatureLabelFields, {
      props: { modelValue: { ...EMPTY }, labelScheme: 'fwd_5d_ret' },
    })
    // factor_clip_sigma 是第一个 n-input-number
    w.findAllComponents(NInputNumber)[0].vm.$emit('update:value', 3.0)
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')).toBeTruthy()
  })
})
