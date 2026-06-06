/**
 * train-modal/buildParams：pickDefined 纯函数单测。
 *
 * 2026-06-06 close_adj 纯后复权改造：
 *  - E2E / lstm 分支随 train_e2e 一并删除
 *  - 本文件仅保留 pickDefined（工具函数，与 E2E 无关）测试
 */
import { describe, it, expect } from 'vitest'
import {
  pickDefined,
} from '../train-modal/buildParams'

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

  it('部分填写 → 仅保留非 null/undefined 项', () => {
    const out = pickDefined({ ...EMPTY_LSTM, lookback: 64, hidden_size: 256 })
    expect(out).toEqual({ lookback: 64, hidden_size: 256 })
  })

  it('dropout=0 保留进输出（0 是业务有效超参）', () => {
    const out = pickDefined({ ...EMPTY_LSTM, dropout: 0, epochs: 10 })
    expect(out).toEqual({ dropout: 0, epochs: 10 })
  })
})
