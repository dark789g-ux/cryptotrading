import { describe, it, expect } from 'vitest'
import { fmtTradeDate, fmtRetPct, exitReasonLabel, retColor } from './signalStatsFormatters'

describe('fmtTradeDate', () => {
  it('converts YYYYMMDD to YYYY-MM-DD', () => {
    expect(fmtTradeDate('20260312')).toBe('2026-03-12')
  })
  it('returns original string when length is not 8', () => {
    expect(fmtTradeDate('2026031')).toBe('2026031')
    expect(fmtTradeDate('202603120')).toBe('202603120')
    expect(fmtTradeDate('')).toBe('')
  })
})

describe('fmtRetPct', () => {
  it('converts decimal string to percentage', () => {
    expect(fmtRetPct('0.032')).toBe('3.20%')
    expect(fmtRetPct('0.1')).toBe('10.00%')
    expect(fmtRetPct('-0.05')).toBe('-5.00%')
  })
  it('returns original string when value is NaN', () => {
    expect(fmtRetPct('abc')).toBe('abc')
    expect(fmtRetPct('')).toBe('')
  })
})

describe('exitReasonLabel', () => {
  it('maps known reasons to Chinese labels', () => {
    expect(exitReasonLabel('max_hold')).toBe('强平')
    expect(exitReasonLabel('signal')).toBe('信号')
    expect(exitReasonLabel('delist')).toBe('退市')
    expect(exitReasonLabel('stop')).toBe('止损')
    expect(exitReasonLabel('ma5_exit')).toBe('MA5离场')
  })
  it('returns unknown reason as-is', () => {
    expect(exitReasonLabel('unknown_reason')).toBe('unknown_reason')
    expect(exitReasonLabel('')).toBe('')
  })
})

describe('retColor', () => {
  it('returns green for positive return', () => {
    expect(retColor('0.01')).toBe('#18a058')
  })
  it('returns green for zero return', () => {
    expect(retColor('0')).toBe('#18a058')
  })
  it('returns red for negative return', () => {
    expect(retColor('-0.01')).toBe('#d03050')
  })
})
