import { buildIndicatorArrays, OamvIndicatorRow } from './oamv-indicators'
import { calcMacd } from '../active-mv/amv-formula'

/**
 * 测试 fixture：10 行数据。
 *
 * 首行设计：open == high == low == close == 10
 *   → 9日窗口 high_9 == low_9 == 10 → rsv = 50（high==low 分支）
 *   → K = prevK(50) × 2/3 + rsv/3 = 50，D = prevD(50) × 2/3 + K/3 = 50，J = 3×50 - 2×50 = 50
 *
 * MA5：前4行 null，第5行 = (10+11+12+13+14)/5 = 12
 */
const FIXTURE: OamvIndicatorRow[] = [
  { tradeDate: '20230101', open: '10', high: '10', low: '10', close: '10' },
  { tradeDate: '20230102', open: '11', high: '12', low: '10', close: '11' },
  { tradeDate: '20230103', open: '12', high: '13', low: '11', close: '12' },
  { tradeDate: '20230104', open: '13', high: '14', low: '12', close: '13' },
  { tradeDate: '20230105', open: '14', high: '15', low: '13', close: '14' },
  { tradeDate: '20230106', open: '15', high: '16', low: '14', close: '15' },
  { tradeDate: '20230107', open: '16', high: '17', low: '15', close: '16' },
  { tradeDate: '20230108', open: '17', high: '18', low: '16', close: '17' },
  { tradeDate: '20230109', open: '18', high: '19', low: '17', close: '18' },
  { tradeDate: '20230110', open: '19', high: '20', low: '18', close: '19' },
]

describe('buildIndicatorArrays', () => {
  let result: ReturnType<typeof buildIndicatorArrays>

  beforeAll(() => {
    result = buildIndicatorArrays(FIXTURE)
  })

  // ── tradeDates ─────────────────────────────────────────────────────────────
  it('tradeDates 与输入行数相等', () => {
    expect(result.tradeDates).toHaveLength(FIXTURE.length)
    expect(result.tradeDates[0]).toBe('20230101')
    expect(result.tradeDates[9]).toBe('20230110')
  })

  // ── KDJ 首行：rsv=50 分支，K=D=50，J=50 ──────────────────────────────────
  it('KDJ 首行 high==low 时 K=D=J=50（rsv=50 分支）', () => {
    expect(result.kdjK[0]).toBe(50)
    expect(result.kdjD[0]).toBe(50)
    expect(result.kdjJ[0]).toBe(50)
  })

  it('KDJ 第2行开始 K/D/J 不全等于 50（rsv 偏离）', () => {
    // row[1]: close=11, high_9=max(10,12)=12, low_9=min(10,10)=10
    // rsv = (11-10)/(12-10)*100 = 50 — 恰好也是50！
    // row[2]: close=12, high_9=max(10,12,13)=13, low_9=10
    // rsv = (12-10)/(13-10)*100 = 66.67
    // K = 50*2/3 + 66.67/3 = 33.33+22.22 = 55.55...
    const k2 = result.kdjK[2]
    expect(k2).not.toBeNull()
    expect(k2).not.toBe(50)
  })

  it('KDJ J = 3K - 2D（逐位验证第3行）', () => {
    const k = result.kdjK[2]!
    const d = result.kdjD[2]!
    const j = result.kdjJ[2]!
    expect(j).toBeCloseTo(3 * k - 2 * d, 3)
  })

  it('KDJ 所有行均非 null（9日窗口无数据缺失）', () => {
    for (let i = 0; i < 10; i++) {
      expect(result.kdjK[i]).not.toBeNull()
      expect(result.kdjD[i]).not.toBeNull()
      expect(result.kdjJ[i]).not.toBeNull()
    }
  })

  // ── MA5：前4行 null，第5行等于窗口均值 ───────────────────────────────────
  it('MA5 前4行为 null', () => {
    expect(result.ma5[0]).toBeNull()
    expect(result.ma5[1]).toBeNull()
    expect(result.ma5[2]).toBeNull()
    expect(result.ma5[3]).toBeNull()
  })

  it('MA5 第5行等于前5行 close 均值 (10+11+12+13+14)/5=12', () => {
    expect(result.ma5[4]).toBeCloseTo(12, 6)
  })

  it('MA5 第6行等于 (11+12+13+14+15)/5=13', () => {
    expect(result.ma5[5]).toBeCloseTo(13, 6)
  })

  // ── MA30/60/120/240：10行数据不足，全为 null ──────────────────────────────
  it('MA30 在10行数据下全为 null', () => {
    expect(result.ma30.every((v) => v === null)).toBe(true)
  })

  it('MA60 在10行数据下全为 null', () => {
    expect(result.ma60.every((v) => v === null)).toBe(true)
  })

  // ── NaN → null 转换 ────────────────────────────────────────────────────────
  it('所有指标数组中不含 NaN（已转为 null）', () => {
    const arrays = [
      result.dif, result.dea, result.macd,
      result.ma5, result.ma30, result.ma60, result.ma120, result.ma240,
      result.kdjK, result.kdjD, result.kdjJ,
    ]
    for (const arr of arrays) {
      for (const v of arr) {
        expect(Number.isNaN(v)).toBe(false)
      }
    }
  })

  // ── MACD：与 calcMacd 直接输出逐位一致 ───────────────────────────────────
  it('MACD dif/dea/macd 数组与 calcMacd 直接输出逐位一致', () => {
    const closes = FIXTURE.map((r) => Number(r.close))
    const { dif, dea, macd } = calcMacd(closes)

    const toNullable = (v: number): number | null => (Number.isFinite(v) ? v : null)
    const expectedDif = dif.map(toNullable)
    const expectedDea = dea.map(toNullable)
    const expectedMacd = macd.map(toNullable)

    expect(result.dif).toEqual(expectedDif)
    expect(result.dea).toEqual(expectedDea)
    expect(result.macd).toEqual(expectedMacd)
  })

  // ── 空输入 ────────────────────────────────────────────────────────────────
  it('空输入返回所有空数组', () => {
    const empty = buildIndicatorArrays([])
    expect(empty.tradeDates).toHaveLength(0)
    expect(empty.dif).toHaveLength(0)
    expect(empty.kdjK).toHaveLength(0)
    expect(empty.ma5).toHaveLength(0)
  })
})
