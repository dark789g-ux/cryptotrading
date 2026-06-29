import { describe, expect, it } from 'vitest'
import { mapOamvToChartBar } from './oamvChartMapping'
import type { OamvData } from '@/api/modules/market/oamv'

/** 最小合法 OamvData（只含必填字段） */
function makeBase(tradeDate: string): OamvData {
  return {
    id: '1',
    tradeDate,
    open: '100.00',
    high: '110.00',
    low: '90.00',
    close: '105.00',
    createdAt: '2026-06-10T00:00:00Z',
  }
}

describe('mapOamvToChartBar', () => {
  describe('日期转换', () => {
    it('YYYYMMDD → YYYY-MM-DD', () => {
      const bar = mapOamvToChartBar(makeBase('20260610'))
      expect(bar.open_time).toBe('2026-06-10')
    })

    it('月份/日期补零正确', () => {
      const bar = mapOamvToChartBar(makeBase('20210101'))
      expect(bar.open_time).toBe('2021-01-01')
    })
  })

  describe('OHLC 字段透传', () => {
    it('string → number 转换', () => {
      const bar = mapOamvToChartBar(makeBase('20260610'))
      expect(bar.open).toBe(100)
      expect(bar.high).toBe(110)
      expect(bar.low).toBe(90)
      expect(bar.close).toBe(105)
    })

    it('volume 固定为 0', () => {
      expect(mapOamvToChartBar(makeBase('20260610')).volume).toBe(0)
    })
  })

  describe('缺字段时 ?? null 兜底', () => {
    it('新指标字段缺失时均为 null', () => {
      const bar = mapOamvToChartBar(makeBase('20260610'))
      expect(bar.MA5).toBeNull()
      expect(bar.MA30).toBeNull()
      expect(bar.MA60).toBeNull()
      expect(bar.MA120).toBeNull()
      expect(bar.MA240).toBeNull()
      expect(bar['KDJ.K']).toBeNull()
      expect(bar['KDJ.D']).toBeNull()
      expect(bar['KDJ.J']).toBeNull()
      expect(bar.DIF).toBeNull()
      expect(bar.DEA).toBeNull()
      expect(bar.MACD).toBeNull()
    })

    it('BBI 始终为 null，brickChart 始终为 undefined', () => {
      const bar = mapOamvToChartBar(makeBase('20260610'))
      expect(bar.BBI).toBeNull()
      expect(bar.brickChart).toBeUndefined()
    })
  })

  describe('指标字段透传（后端已落库）', () => {
    it('MA 均线透传', () => {
      const d: OamvData = {
        ...makeBase('20260610'),
        ma5: 101.5,
        ma30: 98.3,
        ma60: 95.1,
        ma120: 92.0,
        ma240: 88.5,
      }
      const bar = mapOamvToChartBar(d)
      expect(bar.MA5).toBe(101.5)
      expect(bar.MA30).toBe(98.3)
      expect(bar.MA60).toBe(95.1)
      expect(bar.MA120).toBe(92.0)
      expect(bar.MA240).toBe(88.5)
    })

    it('KDJ 透传', () => {
      const d: OamvData = {
        ...makeBase('20260610'),
        kdjK: 55.2,
        kdjD: 48.7,
        kdjJ: 68.1,
      }
      const bar = mapOamvToChartBar(d)
      expect(bar['KDJ.K']).toBe(55.2)
      expect(bar['KDJ.D']).toBe(48.7)
      expect(bar['KDJ.J']).toBe(68.1)
    })

    it('MACD 三线（amvDif/amvDea/amvMacd → DIF/DEA/MACD）透传', () => {
      const d: OamvData = {
        ...makeBase('20260610'),
        amvDif: 1.23,
        amvDea: 0.98,
        amvMacd: 0.5,
      }
      const bar = mapOamvToChartBar(d)
      expect(bar.DIF).toBe(1.23)
      expect(bar.DEA).toBe(0.98)
      expect(bar.MACD).toBe(0.5)
    })

    it('字段值为 null 时保持 null（不变成 undefined）', () => {
      const d: OamvData = {
        ...makeBase('20260610'),
        ma5: null,
        kdjK: null,
        amvDif: null,
      }
      const bar = mapOamvToChartBar(d)
      expect(bar.MA5).toBeNull()
      expect(bar['KDJ.K']).toBeNull()
      expect(bar.DIF).toBeNull()
    })
  })
})
