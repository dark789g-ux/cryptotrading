import { Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm'
import { getSeriesWithRange, mapAmvEntityToSeriesRow } from './amv-series-query'

describe('mapAmvEntityToSeriesRow', () => {
  it('null 数值映射为 NaN', () => {
    const row = mapAmvEntityToSeriesRow({
      tsCode: '801750.SI',
      tradeDate: '20240102',
      amvOpen: null,
      amvHigh: null,
      amvLow: null,
      amvClose: 100,
      amvDif: null,
      amvDea: null,
      amvMacd: null,
      amvZdf: null,
      signal: 1,
      memberCount: 5,
    })
    expect(row.amvOpen).toBeNaN()
    expect(row.amvClose).toBe(100)
    expect(row.memberCount).toBe(5)
  })
})

describe('getSeriesWithRange', () => {
  it('range 模式用 Between 查询 ASC', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        tsCode: '801750.SI',
        tradeDate: '20240102',
        amvOpen: 1,
        amvHigh: 2,
        amvLow: 0.5,
        amvClose: 1.5,
        amvDif: 0.1,
        amvDea: 0.05,
        amvMacd: 0.1,
        amvZdf: 0,
        signal: 1,
        memberCount: 3,
      },
    ])
    const repo = { find } as never

    const rows = await getSeriesWithRange(repo, '801750.SI', 250, {
      startDate: '20240101',
      endDate: '20240131',
    })

    expect(find).toHaveBeenCalledWith({
      where: { tsCode: '801750.SI', tradeDate: Between('20240101', '20240131') },
      order: { tradeDate: 'ASC' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].tradeDate).toBe('20240102')
  })

  it('仅 startDate 时用 MoreThanOrEqual', async () => {
    const find = jest.fn().mockResolvedValue([])
    const repo = { find } as never

    await getSeriesWithRange(repo, '801750.SI', 250, { startDate: '20240101' })

    expect(find).toHaveBeenCalledWith({
      where: { tsCode: '801750.SI', tradeDate: MoreThanOrEqual('20240101') },
      order: { tradeDate: 'ASC' },
    })
  })

  it('仅 endDate 时用 LessThanOrEqual', async () => {
    const find = jest.fn().mockResolvedValue([])
    const repo = { find } as never

    await getSeriesWithRange(repo, '801750.SI', 250, { endDate: '20240131' })

    expect(find).toHaveBeenCalledWith({
      where: { tsCode: '801750.SI', tradeDate: LessThanOrEqual('20240131') },
      order: { tradeDate: 'ASC' },
    })
  })

  it('无 range 时 DESC take 后 reverse', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        tsCode: '801750.SI',
        tradeDate: '20240103',
        amvOpen: 1,
        amvHigh: 2,
        amvLow: 0.5,
        amvClose: 1.6,
        amvDif: 0.2,
        amvDea: 0.06,
        amvMacd: 0.2,
        amvZdf: 0,
        signal: 1,
        memberCount: 3,
      },
      {
        tsCode: '801750.SI',
        tradeDate: '20240102',
        amvOpen: 1,
        amvHigh: 2,
        amvLow: 0.5,
        amvClose: 1.5,
        amvDif: 0.1,
        amvDea: 0.05,
        amvMacd: 0.1,
        amvZdf: 0,
        signal: 1,
        memberCount: 3,
      },
    ])
    const repo = { find } as never

    const rows = await getSeriesWithRange(repo, '801750.SI', 2)

    expect(find).toHaveBeenCalledWith({
      where: { tsCode: '801750.SI' },
      order: { tradeDate: 'DESC' },
      take: 2,
    })
    expect(rows.map((r) => r.tradeDate)).toEqual(['20240102', '20240103'])
  })
})
