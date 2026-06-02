/**
 * train-modal/buildParams：lgb 超参 + 特征/标签参数 + 枚举映射单测。
 *
 * 覆盖（04-testing-and-rollout.md「前端 vitest」段）：
 *  - E2E + lgb-lambdarank + 部分超参 → params.hyperparams 仅含已填项
 *  - E2E + lgb-multiclass → 特征参数正确打包（neutralize 映射、winsorize 成对）
 *  - 普通 train + lgb → p.hyperparams 不含 early_stopping_rounds（UI disabled → 留 null）
 *  - neutralize 三档语义映射；winsorize 成对校验
 */
import { describe, it, expect } from 'vitest'
import {
  buildJobPayload,
  isLgbModel,
  mapNeutralizeCols,
  isWinsorizePaired,
  type TrainTriggerFormShape,
} from '../train-modal/buildParams'

const EMPTY_LGB = {
  num_leaves: null,
  min_data_in_leaf: null,
  feature_fraction: null,
  learning_rate: null,
  num_boost_round: null,
  early_stopping_rounds: null,
  bagging_fraction: null,
  lambda_l1: null,
  lambda_l2: null,
}

const EMPTY_FL = {
  neutralize_cols: null,
  robust_z: null,
  factor_clip_sigma: null,
  label_winsorize_lo: null,
  label_winsorize_hi: null,
  fwd_horizon_days: null,
  max_hold_days: null,
}

function freshForm(): TrainTriggerFormShape {
  return {
    run_type: 'train',
    train: { feature_set_id: '', model: 'lgb-lambdarank', walk_forward: true, seed: null },
    e2e: {
      factor_version: 'v1',
      label_scheme: 'strategy-aware',
      new_listing_min_days: 60,
      date_range: [new Date(2026, 4, 9).getTime(), new Date(2026, 4, 11).getTime()],
      model: 'lgb-lambdarank',
      walk_forward: true,
      seed: 42,
    },
    optuna: { feature_set_id: '', n_trials: 50, space: 'lgb-4knobs' },
    seed_avg: { model_version_base: '', seedsText: '42' },
  }
}

describe('isLgbModel', () => {
  it('识别 lgb 系模型', () => {
    expect(isLgbModel('lgb-lambdarank')).toBe(true)
    expect(isLgbModel('lgb-multiclass')).toBe(true)
    expect(isLgbModel('lstm')).toBe(false)
    expect(isLgbModel('linear')).toBe(false)
    expect(isLgbModel('gbdt')).toBe(false)
  })
})

describe('mapNeutralizeCols', () => {
  it('三档枚举 → 后端语义数组', () => {
    expect(mapNeutralizeCols('none')).toEqual([])
    expect(mapNeutralizeCols('industry')).toEqual(['industry_l1'])
    expect(mapNeutralizeCols('industry_mv')).toEqual(['industry_l1', 'mv'])
  })
})

describe('isWinsorizePaired', () => {
  it('两者皆填 → true', () => {
    const e = { ...freshForm().e2e, featureLabel: { ...EMPTY_FL, label_winsorize_lo: -0.5, label_winsorize_hi: 0.5 } }
    expect(isWinsorizePaired(e)).toBe(true)
  })
  it('两者皆空 → true', () => {
    const e = { ...freshForm().e2e, featureLabel: { ...EMPTY_FL } }
    expect(isWinsorizePaired(e)).toBe(true)
  })
  it('无 featureLabel → true', () => {
    expect(isWinsorizePaired(freshForm().e2e)).toBe(true)
  })
  it('只填 lo → false', () => {
    const e = { ...freshForm().e2e, featureLabel: { ...EMPTY_FL, label_winsorize_lo: -0.5 } }
    expect(isWinsorizePaired(e)).toBe(false)
  })
  it('只填 hi → false', () => {
    const e = { ...freshForm().e2e, featureLabel: { ...EMPTY_FL, label_winsorize_hi: 0.5 } }
    expect(isWinsorizePaired(e)).toBe(false)
  })
})

describe('buildJobPayload E2E lgb 超参', () => {
  it('lgb-lambdarank + 部分超参 → hyperparams 仅含已填项', () => {
    const f = freshForm()
    f.e2e.model = 'lgb-lambdarank'
    f.e2e.lgb = { ...EMPTY_LGB, num_leaves: 64, learning_rate: 0.05 }
    const out = buildJobPayload(f, true)
    expect(out.run_type).toBe('train_e2e')
    expect(out.params.hyperparams).toEqual({ num_leaves: 64, learning_rate: 0.05 })
  })

  it('lgb-multiclass + lgb 全留空 → 不输出 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'lgb-multiclass'
    f.e2e.label_scheme = 'dir3_band'
    f.e2e.lgb = { ...EMPTY_LGB }
    const out = buildJobPayload(f, true)
    expect('hyperparams' in out.params).toBe(false)
  })

  it('lgb lambda_l1=0 → 0 保留进 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'lgb-lambdarank'
    f.e2e.lgb = { ...EMPTY_LGB, lambda_l1: 0, num_leaves: 31 }
    const out = buildJobPayload(f, true)
    expect(out.params.hyperparams).toEqual({ lambda_l1: 0, num_leaves: 31 })
  })

  it('非 lgb 模型即使带 lgb 字段也不输出 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'linear'
    f.e2e.lgb = { ...EMPTY_LGB, num_leaves: 99 }
    const out = buildJobPayload(f, true)
    expect('hyperparams' in out.params).toBe(false)
  })
})

describe('buildJobPayload E2E 特征/标签参数', () => {
  it('neutralize_cols=industry → 映射数组', () => {
    const f = freshForm()
    f.e2e.featureLabel = { ...EMPTY_FL, neutralize_cols: 'industry' }
    const out = buildJobPayload(f, true)
    expect(out.params.neutralize_cols).toEqual(['industry_l1'])
  })

  it('neutralize_cols=none → 空数组', () => {
    const f = freshForm()
    f.e2e.featureLabel = { ...EMPTY_FL, neutralize_cols: 'none' }
    const out = buildJobPayload(f, true)
    expect(out.params.neutralize_cols).toEqual([])
  })

  it('robust_z=false → 保留打包（非默认占位）', () => {
    const f = freshForm()
    f.e2e.featureLabel = { ...EMPTY_FL, robust_z: false }
    const out = buildJobPayload(f, true)
    expect(out.params.robust_z).toBe(false)
  })

  it('robust_z=null → 不打包', () => {
    const f = freshForm()
    f.e2e.featureLabel = { ...EMPTY_FL }
    const out = buildJobPayload(f, true)
    expect('robust_z' in out.params).toBe(false)
  })

  it('winsorize 成对 → params.label_winsorize=[lo,hi]', () => {
    const f = freshForm()
    f.e2e.featureLabel = { ...EMPTY_FL, label_winsorize_lo: -0.5, label_winsorize_hi: 0.5 }
    const out = buildJobPayload(f, true)
    expect(out.params.label_winsorize).toEqual([-0.5, 0.5])
  })

  it('winsorize 只填一个 → 不打包 label_winsorize', () => {
    const f = freshForm()
    f.e2e.featureLabel = { ...EMPTY_FL, label_winsorize_lo: -0.5 }
    const out = buildJobPayload(f, true)
    expect('label_winsorize' in out.params).toBe(false)
  })

  it('factor_clip_sigma 打包', () => {
    const f = freshForm()
    f.e2e.featureLabel = { ...EMPTY_FL, factor_clip_sigma: 3.0 }
    const out = buildJobPayload(f, true)
    expect(out.params.factor_clip_sigma).toBe(3.0)
  })

  it('fwd_horizon_days 仅 fwd_5d_ret 打包', () => {
    const f = freshForm()
    f.e2e.label_scheme = 'fwd_5d_ret'
    f.e2e.featureLabel = { ...EMPTY_FL, fwd_horizon_days: 5 }
    const out = buildJobPayload(f, true)
    expect(out.params.fwd_horizon_days).toBe(5)
  })

  it('fwd_horizon_days 在非 fwd_5d_ret 下不打包', () => {
    const f = freshForm()
    f.e2e.label_scheme = 'strategy-aware'
    f.e2e.featureLabel = { ...EMPTY_FL, fwd_horizon_days: 5 }
    const out = buildJobPayload(f, true)
    expect('fwd_horizon_days' in out.params).toBe(false)
  })

  it('max_hold_days 仅 strategy-aware 打包', () => {
    const f = freshForm()
    f.e2e.label_scheme = 'strategy-aware'
    f.e2e.featureLabel = { ...EMPTY_FL, max_hold_days: 20 }
    const out = buildJobPayload(f, true)
    expect(out.params.max_hold_days).toBe(20)
  })
})

describe('buildJobPayload 普通 train lgb 超参', () => {
  it('普通 train + lgb 超参 → p.hyperparams（不打特征参数）', () => {
    const f = freshForm()
    f.train.feature_set_id = 'fs-1'
    f.train.model = 'lgb-multiclass'
    f.train.lgb = { ...EMPTY_LGB, num_leaves: 31 }
    const out = buildJobPayload(f, false)
    expect(out.run_type).toBe('train')
    expect(out.params.hyperparams).toEqual({ num_leaves: 31 })
    expect('neutralize_cols' in out.params).toBe(false)
    expect('label_winsorize' in out.params).toBe(false)
  })

  it('普通 train early_stopping_rounds 留 null（UI disabled）→ hyperparams 不含它', () => {
    const f = freshForm()
    f.train.feature_set_id = 'fs-1'
    f.train.model = 'lgb-lambdarank'
    f.train.lgb = { ...EMPTY_LGB, num_leaves: 63, early_stopping_rounds: null }
    const out = buildJobPayload(f, false)
    expect(out.params.hyperparams).toEqual({ num_leaves: 63 })
    expect('early_stopping_rounds' in (out.params.hyperparams as object)).toBe(false)
  })

  it('普通 train + 非 lgb 模型 → 不输出 hyperparams', () => {
    const f = freshForm()
    f.train.feature_set_id = 'fs-1'
    f.train.model = 'linear'
    const out = buildJobPayload(f, false)
    expect('hyperparams' in out.params).toBe(false)
  })
})
