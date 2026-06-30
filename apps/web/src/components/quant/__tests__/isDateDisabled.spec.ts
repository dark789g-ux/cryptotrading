/**
 * isDateDisabled 纯函数单测。
 *
 * 逻辑：给定 coverage: CoverageSegment[]，ts（本地午夜 ms）落在任一段内返回 false（可选），
 * 否则（区间外 + 空洞）返回 true（禁用）。
 *
 * 覆盖：
 *  (1) 单段：段内日期可选，段外禁用
 *  (2) 多段：空洞日期禁用，两段内日期各可选
 *  (3) coverage 为空时全禁用
 *  (4) 边界日期（start / end）本身可选
 *  (5) 切换 fs（coverage 变化）后旧日期可能变为禁用
 */
import { describe, it, expect } from 'vitest'
import { isDateDisabled } from '../train/train-modal/buildParams'
import type { CoverageSegment } from '@/api/modules/quant'

/** 把年月日（本地）转成 n-date-picker 的本地午夜 ms */
function localMs(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day).getTime()
}

describe('isDateDisabled', () => {
  const singleSeg: CoverageSegment[] = [
    { start: '20240101', end: '20241231' },
  ]

  it('(1) 单段：段内日期可选（返回 false）', () => {
    expect(isDateDisabled(localMs(2024, 6, 15), singleSeg)).toBe(false)
    expect(isDateDisabled(localMs(2024, 1, 1), singleSeg)).toBe(false)
    expect(isDateDisabled(localMs(2024, 12, 31), singleSeg)).toBe(false)
  })

  it('(1) 单段：段外日期禁用（返回 true）', () => {
    expect(isDateDisabled(localMs(2023, 12, 31), singleSeg)).toBe(true)
    expect(isDateDisabled(localMs(2025, 1, 1), singleSeg)).toBe(true)
  })

  const multiSeg: CoverageSegment[] = [
    { start: '20230101', end: '20231231' },
    { start: '20250101', end: '20251231' },
  ]

  it('(2) 多段：空洞（2024 年）禁用', () => {
    expect(isDateDisabled(localMs(2024, 1, 1), multiSeg)).toBe(true)
    expect(isDateDisabled(localMs(2024, 6, 15), multiSeg)).toBe(true)
    expect(isDateDisabled(localMs(2024, 12, 31), multiSeg)).toBe(true)
  })

  it('(2) 多段：两段内日期各可选', () => {
    expect(isDateDisabled(localMs(2023, 6, 15), multiSeg)).toBe(false)
    expect(isDateDisabled(localMs(2025, 6, 15), multiSeg)).toBe(false)
  })

  it('(3) coverage 为空时全禁用', () => {
    expect(isDateDisabled(localMs(2024, 6, 15), [])).toBe(true)
  })

  it('(4) 边界日期（start / end）本身可选', () => {
    expect(isDateDisabled(localMs(2024, 1, 1), singleSeg)).toBe(false)
    expect(isDateDisabled(localMs(2024, 12, 31), singleSeg)).toBe(false)
    expect(isDateDisabled(localMs(2023, 1, 1), multiSeg)).toBe(false)
    expect(isDateDisabled(localMs(2023, 12, 31), multiSeg)).toBe(false)
    expect(isDateDisabled(localMs(2025, 1, 1), multiSeg)).toBe(false)
    expect(isDateDisabled(localMs(2025, 12, 31), multiSeg)).toBe(false)
  })

  it('(5) 切换 fs coverage 后原日期变为禁用', () => {
    const oldCoverage: CoverageSegment[] = [{ start: '20230101', end: '20231231' }]
    const newCoverage: CoverageSegment[] = [{ start: '20250101', end: '20251231' }]
    const ts = localMs(2023, 6, 15)
    // 旧 coverage 可选
    expect(isDateDisabled(ts, oldCoverage)).toBe(false)
    // 新 coverage 禁用
    expect(isDateDisabled(ts, newCoverage)).toBe(true)
  })
})
