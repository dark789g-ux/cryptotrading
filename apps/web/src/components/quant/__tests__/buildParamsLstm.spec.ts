/**
 * train-modal/buildParams：LSTM 分支 + pickDefined 纯函数单测。
 *
 * 2026-06-05 quant-label-management spec 更新：
 *  - label_scheme / dir3_band_eps 字段已废弃，改为 labelKey（label_id:label_version）
 *  - E2E 路径输出 labelRef，不再输出 label_scheme / dir3_band_eps
 *  - 原 dir3_* 相关测试已移除（字段不再存在）
 */
import { describe, it, expect } from 'vitest'
import {
  buildJobPayload,
  pickDefined,
  type TrainTriggerFormShape,
} from '../train-modal/buildParams'

function freshForm(): TrainTriggerFormShape {
  return {
    run_type: 'train',
    train: { feature_set_id: '', model: 'lgb-lambdarank', walk_forward: true, seed: null },
    e2e: {
      factor_version: 'v1',
      labelKey: 'my_label:v1',
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

const EMPTY_LSTM = {
  lookback: null,
  hidden_size: null,
  num_layers: null,
  dropout: null,
  learning_rate: null,
  epochs: null,
  batch_size: null,
}

describe('pickDefined', () => {
  it('过滤 null / undefined', () => {
    const out = pickDefined({ a: 1, b: null, c: undefined, d: 'x' })
    expect(out).toEqual({ a: 1, d: 'x' })
  })

  it('保留 0 与 false（业务有效值，非默认占位）', () => {
    const out = pickDefined({ a: 0, b: false, c: null })
    expect(out).toEqual({ a: 0, b: false })
  })

  it('全 null → 空对象', () => {
    expect(pickDefined({ ...EMPTY_LSTM })).toEqual({})
  })
})

describe('buildJobPayload LSTM 分支', () => {
  it('model=lstm + 部分填写 → hyperparams 仅含已填项', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.labelKey = 'dir3_label:v1'
    f.e2e.lstm = { ...EMPTY_LSTM, lookback: 64, hidden_size: 256 }

    const out = buildJobPayload(f, true)
    expect(out.run_type).toBe('train_e2e')
    expect(out.params.model).toBe('lstm')
    // labelRef 而非 label_scheme
    expect(out.labelRef).toEqual({ label_id: 'dir3_label', label_version: 'v1' })
    expect(out.params.hyperparams).toEqual({ lookback: 64, hidden_size: 256 })
  })

  it('model=lstm + 全留空 → 不输出 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.labelKey = 'tercile_label:v1'
    f.e2e.lstm = { ...EMPTY_LSTM }

    const out = buildJobPayload(f, true)
    expect(out.labelRef).toEqual({ label_id: 'tercile_label', label_version: 'v1' })
    expect('hyperparams' in out.params).toBe(false)
  })

  it('model=lstm + dropout=0 → 0 保留进 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.lstm = { ...EMPTY_LSTM, dropout: 0, epochs: 10 }

    const out = buildJobPayload(f, true)
    expect(out.params.hyperparams).toEqual({ dropout: 0, epochs: 10 })
  })

  it('model=lstm 但无 lstm 字段 → 不输出 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.lstm = undefined

    const out = buildJobPayload(f, true)
    expect('hyperparams' in out.params).toBe(false)
  })

  it('model!=lstm 即使带 lstm 字段也不输出 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'gbdt'
    f.e2e.lstm = { ...EMPTY_LSTM, lookback: 99 }

    const out = buildJobPayload(f, true)
    expect('hyperparams' in out.params).toBe(false)
  })
})

describe('buildJobPayload labelRef 透传', () => {
  it('labelKey → params 不含 label_scheme，labelRef 正确输出', () => {
    const f = freshForm()
    f.e2e.labelKey = 'band_label:v2'

    const out = buildJobPayload(f, true)
    expect('label_scheme' in out.params).toBe(false)
    expect('dir3_band_eps' in out.params).toBe(false)
    expect(out.labelRef).toEqual({ label_id: 'band_label', label_version: 'v2' })
  })

  it('labelKey=null → labelRef=undefined', () => {
    const f = freshForm()
    f.e2e.labelKey = null

    const out = buildJobPayload(f, true)
    expect(out.labelRef).toBeUndefined()
  })
})
