/**
 * StepIndexSpec 单测：create 模式「调仓生效日默认同基期」的同步逻辑。
 *
 * 背景 bug：defaultState 把 effectiveDate 初始化为今天（永不为空），旧实现仅在
 * `!effectiveDate` 时同步，导致改 base_date 后 effective_date 仍停在今天 →
 * 计算 0 点位。修复后：effective_date 为空或仍与改动前 base_date 相同（未被显式
 * 改成不同值）时跟随新 base_date；用户已显式改成不同值则不覆盖；edit 模式不同步。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NDatePicker } from 'naive-ui'
import StepIndexSpec from './StepIndexSpec.vue'

/** 'YYYYMMDD' → 本地午夜 ms（与组件 ymdToTs 同口径）。 */
function ymdToTs(ymd: string): number {
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6)) - 1
  const d = Number(ymd.slice(6, 8))
  return new Date(y, m, d).getTime()
}

function mountSpec(props: {
  baseDate: string | null
  effectiveDate: string | null
  isEdit: boolean
}) {
  return mount(StepIndexSpec, {
    props: {
      baseDate: props.baseDate,
      basePoint: 1000,
      indexType: 'price' as const,
      effectiveDate: props.effectiveDate,
      isEdit: props.isEdit,
    },
  })
}

/** 第一个 NDatePicker = 基期日期，第二个 = 调仓生效日。 */
function changeBaseDate(w: ReturnType<typeof mountSpec>, ymd: string) {
  const baseDatePicker = w.findAllComponents(NDatePicker).at(0)!
  baseDatePicker.vm.$emit('update:value', ymdToTs(ymd))
}

function lastEmit(w: ReturnType<typeof mountSpec>, event: string): unknown {
  const emitted = w.emitted(event) as unknown[][] | undefined
  if (!emitted || emitted.length === 0) return undefined
  return emitted[emitted.length - 1][0]
}

describe('StepIndexSpec onBaseDateChange', () => {
  it('create 模式 + effective_date 与基期同步：改基期 → effective_date 跟随', () => {
    const w = mountSpec({ baseDate: '20260628', effectiveDate: '20260628', isEdit: false })
    changeBaseDate(w, '20260105')
    expect(lastEmit(w, 'update:baseDate')).toBe('20260105')
    expect(lastEmit(w, 'update:effectiveDate')).toBe('20260105')
  })

  it('create 模式 + effective_date 为空：改基期 → effective_date 跟随', () => {
    const w = mountSpec({ baseDate: '20260628', effectiveDate: null, isEdit: false })
    changeBaseDate(w, '20260105')
    expect(lastEmit(w, 'update:effectiveDate')).toBe('20260105')
  })

  it('create 模式 + 用户已把 effective_date 改成不同值：改基期不覆盖', () => {
    const w = mountSpec({ baseDate: '20260628', effectiveDate: '20260701', isEdit: false })
    changeBaseDate(w, '20260105')
    expect(lastEmit(w, 'update:baseDate')).toBe('20260105')
    expect(w.emitted('update:effectiveDate')).toBeUndefined()
  })

  it('edit 模式：改基期不同步 effective_date', () => {
    const w = mountSpec({ baseDate: '20260628', effectiveDate: '20260628', isEdit: true })
    changeBaseDate(w, '20260105')
    expect(lastEmit(w, 'update:baseDate')).toBe('20260105')
    expect(w.emitted('update:effectiveDate')).toBeUndefined()
  })
})
