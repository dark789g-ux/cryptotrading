import { describe, it, expect } from 'vitest'
import {
  fmtTradeDate,
  fmtRetPct,
  exitReasonLabel,
  retColor,
  exitModeTag,
  exitModeSummary,
  exitModeShortLabel,
  exitModeText,
} from './signalStatsFormatters'
import type {
  SignalTest,
  SignalTestExitMode,
  SignalTestTrade,
} from '../../api/modules/strategy/signalStats'

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

// ── 枚举渲染点守门 ────────────────────────────────────────────────────────────
// 遍历 SignalTestExitMode / exitReason 全集，断言每个值经 label 函数都得到非兜底、
// 非原始枚举串的中文标签。新增枚举值时若漏在 signalStatsFormatters 补分支，本组测试变红。
//
// 全集以 Record<联合, true> 字面量声明为唯一真值源：TS 对对象字面量强制穷尽——
// 新增枚举成员而此处漏列 → type-check 报缺键(TS2741)，多列不存在的键也报错。
// 遍历用的全集数组由该表 keys 派生，守门覆盖随枚举同步扩张、不会名实不符。
// 注意：不要写成 `Object.fromEntries(arr) as Record<...>`——as 强转会把缺键抹平、
// 令穷尽校验失效（数组漏列也不报错）。

const EXIT_MODE_SET: Record<SignalTestExitMode, true> = {
  fixed_n: true,
  strategy: true,
  trailing_lock: true,
  phase_lock: true,
}
const ALL_EXIT_MODES = Object.keys(EXIT_MODE_SET) as SignalTestExitMode[]

const EXIT_REASON_SET: Record<SignalTestTrade['exitReason'], true> = {
  max_hold: true,
  signal: true,
  delist: true,
  stop: true,
  ma5_exit: true,
  phase_lock_stop: true,
  phase_lock_ma5: true,
}
const ALL_EXIT_REASONS = Object.keys(EXIT_REASON_SET) as Array<SignalTestTrade['exitReason']>

/** 含中文字符即视为已渲染为真标签（非原始 snake_case 枚举串）。 */
function hasChinese(s: string): boolean {
  return /[一-龥]/.test(s)
}

/** 构造一个带参数的最小 SignalTest，用于驱动含参标签函数。 */
function makeTest(mode: SignalTestExitMode): SignalTest {
  return {
    id: 't1',
    name: '测试方案',
    buyConditions: [],
    exitMode: mode,
    horizonN: 5,
    exitConditions: null,
    maxHold: 10,
    bandLockParams: null,
    phaseLockParams: null,
    universe: { type: 'all' },
    dateStart: '20260101',
    dateEnd: '20260601',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('exitMode 标签全集守门（防新增枚举漏渲染点）', () => {
  it('exitModeTag 对每个 exitMode 都返回非原始串中文标签 + 合法 NTag 颜色', () => {
    for (const mode of ALL_EXIT_MODES) {
      const { type, label } = exitModeTag(makeTest(mode))
      // 标签不得退化为原始枚举串，且必须含中文
      expect(label, `exitModeTag('${mode}') 落到 fallback`).not.toBe(mode)
      expect(hasChinese(label), `exitModeTag('${mode}') 标签无中文：${label}`).toBe(true)
      // NTag 颜色不得退化为 default 兜底
      expect(type, `exitModeTag('${mode}') 颜色落到 default 兜底`).not.toBe('default')
    }
  })

  it('exitModeSummary 对每个 exitMode 都返回非原始串中文标签', () => {
    for (const mode of ALL_EXIT_MODES) {
      const label = exitModeSummary(makeTest(mode))
      expect(label, `exitModeSummary('${mode}') 落到 fallback`).not.toBe(mode)
      expect(hasChinese(label), `exitModeSummary('${mode}') 标签无中文：${label}`).toBe(true)
    }
  })

  it('exitModeShortLabel 对每个 exitMode 都返回非原始串中文标签', () => {
    for (const mode of ALL_EXIT_MODES) {
      const label = exitModeShortLabel(mode)
      expect(label, `exitModeShortLabel('${mode}') 落到 fallback`).not.toBe(mode)
      expect(hasChinese(label), `exitModeShortLabel('${mode}') 标签无中文：${label}`).toBe(true)
    }
  })

  it('exitModeText 对每个 exitMode 都返回非原始串中文标签', () => {
    for (const mode of ALL_EXIT_MODES) {
      const label = exitModeText(mode)
      expect(label, `exitModeText('${mode}') 落到 fallback`).not.toBe(mode)
      expect(hasChinese(label), `exitModeText('${mode}') 标签无中文：${label}`).toBe(true)
    }
  })

  it('未知 exitMode 各函数兜底为原始串（保留兜底语义，不抛错）', () => {
    const unknown = 'some_new_mode' as SignalTestExitMode
    expect(exitModeShortLabel(unknown)).toBe('some_new_mode')
    expect(exitModeText(unknown)).toBe('some_new_mode')
    expect(exitModeSummary(makeTest(unknown))).toBe('some_new_mode')
    expect(exitModeTag(makeTest(unknown))).toEqual({ type: 'default', label: 'some_new_mode' })
  })
})

describe('exitReason 标签全集守门（防新增枚举漏渲染点）', () => {
  it('exitReasonLabel 对每个 exitReason 都返回非原始串中文标签', () => {
    for (const reason of ALL_EXIT_REASONS) {
      const label = exitReasonLabel(reason)
      expect(label, `exitReasonLabel('${reason}') 落到 fallback`).not.toBe(reason)
      expect(hasChinese(label), `exitReasonLabel('${reason}') 标签无中文：${label}`).toBe(true)
    }
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
