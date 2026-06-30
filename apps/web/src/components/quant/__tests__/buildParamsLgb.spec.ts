/**
 * train-modal/buildParams：lgb 超参 + 特征/标签参数 + 枚举映射单测。
 *
 * 2026-06-06 close_adj 纯后复权改造：
 *  - 删 train_e2e / E2E 模式；buildJobPayload 第二参数 modeIsE2E 已移除
 *  - TrainTriggerFormShape 改为 shared.{feature_set_id, date_range} + train/optuna/seed_avg
 *  - parseLabelRef / isWinsorizePaired / applyFeatureLabelParams 仅属 E2E 路径，随 E2E 一并移除
 */
import { describe, it, expect } from 'vitest'
import {
  buildJobPayload,
  isLgbModel,
  mapNeutralizeCols,
  type TrainTriggerFormShape,
} from '../train/train-modal/buildParams'

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

function freshForm(): TrainTriggerFormShape {
  return {
    run_type: 'train',
    shared: {
      feature_set_id: 'fs-v1-20260517',
      date_range: [new Date(2026, 4, 9).getTime(), new Date(2026, 4, 11).getTime()],
    },
    train: { model: 'lgb-lambdarank', walk_forward: true, seed: null },
    optuna: { n_trials: 50, space: 'lgb-4knobs' },
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

describe('buildJobPayload train lgb 超参', () => {
  it('lgb-lambdarank + 部分超参 → hyperparams 仅含已填项', () => {
    const f = freshForm()
    f.train.model = 'lgb-lambdarank'
    f.train.lgb = { ...EMPTY_LGB, num_leaves: 64, learning_rate: 0.05 }
    const out = buildJobPayload(f)
    expect(out.run_type).toBe('train')
    expect(out.params.hyperparams).toEqual({ num_leaves: 64, learning_rate: 0.05 })
  })

  it('lgb-multiclass + lgb 全留空 → 不输出 hyperparams', () => {
    const f = freshForm()
    f.train.model = 'lgb-multiclass'
    f.train.lgb = { ...EMPTY_LGB }
    const out = buildJobPayload(f)
    expect('hyperparams' in out.params).toBe(false)
  })

  it('lgb lambda_l1=0 → 0 保留进 hyperparams', () => {
    const f = freshForm()
    f.train.model = 'lgb-lambdarank'
    f.train.lgb = { ...EMPTY_LGB, lambda_l1: 0, num_leaves: 31 }
    const out = buildJobPayload(f)
    expect(out.params.hyperparams).toEqual({ lambda_l1: 0, num_leaves: 31 })
  })

  it('非 lgb 模型即使带 lgb 字段也不输出 hyperparams', () => {
    const f = freshForm()
    f.train.model = 'linear'
    f.train.lgb = { ...EMPTY_LGB, num_leaves: 99 }
    const out = buildJobPayload(f)
    expect('hyperparams' in out.params).toBe(false)
  })

  it('普通 train early_stopping_rounds 留 null（UI disabled）→ hyperparams 不含它', () => {
    const f = freshForm()
    f.train.model = 'lgb-lambdarank'
    f.train.lgb = { ...EMPTY_LGB, num_leaves: 63, early_stopping_rounds: null }
    const out = buildJobPayload(f)
    expect(out.params.hyperparams).toEqual({ num_leaves: 63 })
    expect('early_stopping_rounds' in (out.params.hyperparams as object)).toBe(false)
  })
})

describe('buildJobPayload train params', () => {
  it('feature_set_id + date_range 进 params', () => {
    const out = buildJobPayload(freshForm())
    expect(out.params.feature_set_id).toBe('fs-v1-20260517')
    expect(out.params.date_range).toBe('20260509:20260511')
  })

  it('seed 有值时打包', () => {
    const f = freshForm()
    f.train.seed = 7
    const out = buildJobPayload(f)
    expect(out.params.seed).toBe(7)
  })

  it('seed=null 时不打包', () => {
    const out = buildJobPayload(freshForm())
    expect('seed' in out.params).toBe(false)
  })

  it('不输出 train_e2e run_type', () => {
    const out = buildJobPayload(freshForm())
    expect(out.run_type).not.toBe('train_e2e')
  })
})

describe('buildJobPayload optuna', () => {
  it('optuna params 包含 feature_set_id + date_range + n_trials + space', () => {
    const f = freshForm()
    f.run_type = 'optuna'
    const out = buildJobPayload(f)
    expect(out.params.feature_set_id).toBe('fs-v1-20260517')
    expect(out.params.date_range).toBe('20260509:20260511')
    expect(out.params.n_trials).toBe(50)
    expect(out.params.space).toBe('lgb-4knobs')
  })
})

describe('buildJobPayload seed_avg', () => {
  it('seed_avg params 包含 feature_set_id + date_range + model_version_base + seeds', () => {
    const f = freshForm()
    f.run_type = 'seed_avg'
    f.seed_avg.model_version_base = 'lgb-v1-20260620'
    f.seed_avg.seedsText = '42,43,44'
    const out = buildJobPayload(f)
    expect(out.params.feature_set_id).toBe('fs-v1-20260517')
    expect(out.params.date_range).toBe('20260509:20260511')
    expect(out.params.model_version_base).toBe('lgb-v1-20260620')
    expect(out.params.seeds).toEqual([42, 43, 44])
  })
})
