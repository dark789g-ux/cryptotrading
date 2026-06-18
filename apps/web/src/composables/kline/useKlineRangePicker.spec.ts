import { describe, it, expect, vi } from 'vitest'
import { useKlineRangePicker } from './useKlineRangePicker'

describe('useKlineRangePicker', () => {
  it('选区间：range 置位 + onApply 收到本地日历日 YYYYMMDD', () => {
    const onApply = vi.fn()
    const { range, onRangeUpdate } = useKlineRangePicker(onApply)

    const start = new Date(2024, 0, 5).getTime()
    const end = new Date(2024, 0, 10).getTime()
    onRangeUpdate([start, end])

    expect(range.value).toEqual([start, end])
    expect(onApply).toHaveBeenCalledWith({ startDate: '20240105', endDate: '20240110' })
  })

  it('清空：range=null + onApply(null)', () => {
    const onApply = vi.fn()
    const { range, onRangeUpdate } = useKlineRangePicker(onApply)

    onRangeUpdate([new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    onApply.mockClear()
    onRangeUpdate(null)

    expect(range.value).toBeNull()
    expect(onApply).toHaveBeenCalledWith(null)
  })

  it('reset：range=null 且不触发 onApply', () => {
    const onApply = vi.fn()
    const { range, onRangeUpdate, reset } = useKlineRangePicker(onApply)

    onRangeUpdate([new Date(2024, 0, 5).getTime(), new Date(2024, 0, 10).getTime()])
    onApply.mockClear()
    reset()

    expect(range.value).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('A 类无 onApply：onRangeUpdate 仅置位 range，不报错', () => {
    const { range, onRangeUpdate } = useKlineRangePicker()
    const start = new Date(2024, 0, 5).getTime()
    const end = new Date(2024, 0, 10).getTime()
    expect(() => onRangeUpdate([start, end])).not.toThrow()
    expect(range.value).toEqual([start, end])
  })
})
