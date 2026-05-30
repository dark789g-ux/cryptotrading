/**
 * train-modal/buildParams：LSTM 分支 + pickDefined 纯函数单测。
 *
 * 覆盖（spec 05-frontend.md §3 参数装配）：
 *  (1) pickDefined 过滤 null/undefined，保留 0 与 false（业务有效值）
 *  (2) model='lstm' + 部分填写 → params.hyperparams 仅含已填项
 *  (3) model='lstm' + 全留空 → 不输出 hyperparams（后端补默认）
 *  (4) model='lstm' + 填 0 / dropout=0 → 0 保留进 hyperparams
 *  (5) model!='lstm' 即使带 lstm 字段也不输出 hyperparams
 *  (6) dir3_* label_scheme 照常透传
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
    f.e2e.label_scheme = 'dir3_band'
    f.e2e.lstm = { ...EMPTY_LSTM, lookback: 64, hidden_size: 256 }

    const out = buildJobPayload(f, true)
    expect(out.run_type).toBe('train_e2e')
    expect(out.params.model).toBe('lstm')
    expect(out.params.label_scheme).toBe('dir3_band')
    expect(out.params.hyperparams).toEqual({ lookback: 64, hidden_size: 256 })
  })

  it('model=lstm + 全留空 → 不输出 hyperparams', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.label_scheme = 'dir3_tercile'
    f.e2e.lstm = { ...EMPTY_LSTM }

    const out = buildJobPayload(f, true)
    expect(out.params.label_scheme).toBe('dir3_tercile')
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

describe('buildJobPayload dir3_band ε 透传（A2）', () => {
  it('label_scheme=dir3_band + 自定义 ε → params 含 dir3_band_eps', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.label_scheme = 'dir3_band'
    f.e2e.dir3_band_eps = 0.008

    const out = buildJobPayload(f, true)
    // 前端只透原始 ε；ε→canonical scheme 串编码由后端 dir3_scheme.py 单一源完成
    expect(out.params.label_scheme).toBe('dir3_band')
    expect(out.params.dir3_band_eps).toBe(0.008)
  })

  it('label_scheme=dir3_band 但 ε 留空 → 走默认 0.005', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.label_scheme = 'dir3_band'
    f.e2e.dir3_band_eps = null

    const out = buildJobPayload(f, true)
    expect(out.params.dir3_band_eps).toBe(0.005)
  })

  it('label_scheme=dir3_band 但未设 dir3_band_eps 字段 → 走默认 0.005', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.label_scheme = 'dir3_band'

    const out = buildJobPayload(f, true)
    expect(out.params.dir3_band_eps).toBe(0.005)
  })

  it('label_scheme=dir3_tercile → 不输出 dir3_band_eps（ε 仅 dir3_band 有意义）', () => {
    const f = freshForm()
    f.e2e.model = 'lstm'
    f.e2e.label_scheme = 'dir3_tercile'
    f.e2e.dir3_band_eps = 0.02

    const out = buildJobPayload(f, true)
    expect('dir3_band_eps' in out.params).toBe(false)
  })

  it('label_scheme=strategy-aware → 不输出 dir3_band_eps', () => {
    const f = freshForm()
    f.e2e.label_scheme = 'strategy-aware'

    const out = buildJobPayload(f, true)
    expect('dir3_band_eps' in out.params).toBe(false)
  })
})
