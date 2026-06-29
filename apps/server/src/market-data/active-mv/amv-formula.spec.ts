import {
  tdSma,
  tdEma,
  calcMacd,
  calcAmvSeries,
  calcSignal,
  calcZdf,
} from './amv-formula'

/**
 * AMV 公式层纯函数单测（spec §3 / §10）。
 *
 * 期望值优先**手算 / 交叉验证**，不把"当前实现输出"直接当期望：
 * - tdSma / tdEma：用通达信递推公式逐点手算固定序列；
 * - calcMacd：用 tdEma 自身结果交叉验证 dif=ema12-ema26、dea=tdEma(dif,9)、柱=2(dif-dea)；
 * - calcAmvSeries：v1/v3/AMVc 三步手算；重点验异常口径（v3≤0 / AMVc≤0 → NaN + invalid）；
 * - calcSignal / calcZdf：三态边界 / 分母≤0 全覆盖。
 *
 * 对实现定义的边界（invalid 的精确口径 `!(x>0)`、首点种子、NaN 透传）以 amv-formula.ts
 * 实际语义为准，并在注释中说明。
 */
describe('amv-formula', () => {
  describe('tdSma — 通达信 SMA(X,N,M) 递推', () => {
    it('默认 n=10,m=1：SMA_t=(x_t+9·SMA_{t-1})/10，首值=首个有效值，逐点精确', () => {
      // 手算 [10,20,30,40,50]：
      //  SMA0 = 10（种子）
      //  SMA1 = (20 + 9·10)/10 = 110/10 = 11
      //  SMA2 = (30 + 9·11)/10 = 129/10 = 12.9
      //  SMA3 = (40 + 9·12.9)/10 = 156.1/10 = 15.61
      //  SMA4 = (50 + 9·15.61)/10 = 190.49/10 = 19.049
      const out = tdSma([10, 20, 30, 40, 50])
      expect(out).toHaveLength(5)
      expect(out[0]).toBeCloseTo(10, 10)
      expect(out[1]).toBeCloseTo(11, 10)
      expect(out[2]).toBeCloseTo(12.9, 10)
      expect(out[3]).toBeCloseTo(15.61, 10)
      expect(out[4]).toBeCloseTo(19.049, 10)
    })

    it('常数序列 → 全为该常数（种子后递推不变）', () => {
      // SMA0=7；SMA_t=(7+9·7)/10=7，恒为 7
      expect(tdSma([7, 7, 7, 7])).toEqual([7, 7, 7, 7])
    })

    it('首值 = 第一个有效值（即便前面有有效值，种子就是首元素）', () => {
      const out = tdSma([100, 0, 0])
      expect(out[0]).toBe(100)
      // SMA1=(0+9·100)/10=90；SMA2=(0+9·90)/10=81
      expect(out[1]).toBeCloseTo(90, 10)
      expect(out[2]).toBeCloseTo(81, 10)
    })

    it('NaN 透传：无效值落 NaN 且不推进种子', () => {
      // [10, NaN, 20]：
      //  i0: 种子=10
      //  i1: NaN → push NaN，种子仍=10（不推进）
      //  i2: (20+9·10)/10 = 11
      const out = tdSma([10, NaN, 20])
      expect(out[0]).toBeCloseTo(10, 10)
      expect(Number.isNaN(out[1])).toBe(true)
      expect(out[2]).toBeCloseTo(11, 10)
    })

    it('前导 NaN：种子直到首个有效值才建立', () => {
      // [NaN, 10, 20]：i0 NaN→NaN（无种子）；i1 种子=10；i2=(20+9·10)/10=11
      const out = tdSma([NaN, 10, 20])
      expect(Number.isNaN(out[0])).toBe(true)
      expect(out[1]).toBeCloseTo(10, 10)
      expect(out[2]).toBeCloseTo(11, 10)
    })

    it('自定义 n,m：SMA(X,5,2)=(2·x_t+3·prev)/5', () => {
      // [10,20]：SMA0=10；SMA1=(2·20+3·10)/5=70/5=14
      const out = tdSma([10, 20], 5, 2)
      expect(out[0]).toBeCloseTo(10, 10)
      expect(out[1]).toBeCloseTo(14, 10)
    })
  })

  describe('tdEma — 通达信 EMA(X,N) 递推', () => {
    it('n=10：EMA_t=(2·x_t+9·EMA_{t-1})/11，首值=首个有效值，逐点精确', () => {
      // 手算 [10,20,30]，n=10：
      //  EMA0 = 10（种子）
      //  EMA1 = (2·20 + 9·10)/11 = (40+90)/11 = 130/11 = 11.8181818...
      //  EMA2 = (2·30 + 9·11.8181818)/11 = (60+106.363636)/11 = 166.363636/11 = 15.1239669...
      const out = tdEma([10, 20, 30], 10)
      expect(out).toHaveLength(3)
      expect(out[0]).toBeCloseTo(10, 10)
      expect(out[1]).toBeCloseTo(130 / 11, 10)
      expect(out[2]).toBeCloseTo(166.36363636363637 / 11, 8)
    })

    it('默认 n=12：EMA_t=(2·x_t+11·EMA_{t-1})/13', () => {
      // [10,20]：EMA0=10；EMA1=(2·20+11·10)/13=(40+110)/13=150/13=11.538461...
      const out = tdEma([10, 20])
      expect(out[0]).toBeCloseTo(10, 10)
      expect(out[1]).toBeCloseTo(150 / 13, 10)
    })

    it('常数序列 → 恒为该常数', () => {
      expect(tdEma([5, 5, 5], 12)).toEqual([5, 5, 5])
    })

    it('NaN 透传且不推进种子', () => {
      // [10, NaN, 20], n=10：i1 NaN→NaN 种子仍=10；i2=(2·20+9·10)/11=130/11
      const out = tdEma([10, NaN, 20], 10)
      expect(out[0]).toBeCloseTo(10, 10)
      expect(Number.isNaN(out[1])).toBe(true)
      expect(out[2]).toBeCloseTo(130 / 11, 10)
    })
  })

  describe('calcMacd — DIF/DEA/柱 关系（tdEma 交叉验证）', () => {
    // 一段已知斜坡序列（足够长以观察前段未收敛）
    const values = Array.from({ length: 40 }, (_, i) => i + 1)

    it('dif = tdEma(12) - tdEma(26)，dea = tdEma(dif,9)，柱 = 2·(dif-dea) 三者关系成立', () => {
      const { dif, dea, macd } = calcMacd(values)

      // 用 tdEma 自身结果交叉验证（不依赖外部工具）
      const emaFast = tdEma(values, 12)
      const emaSlow = tdEma(values, 26)
      const expectedDif = emaFast.map((v, i) => v - emaSlow[i])
      const expectedDea = tdEma(expectedDif, 9)
      const expectedMacd = expectedDif.map((d, i) => 2 * (d - expectedDea[i]))

      for (let i = 0; i < values.length; i++) {
        expect(dif[i]).toBeCloseTo(expectedDif[i], 10)
        expect(dea[i]).toBeCloseTo(expectedDea[i], 10)
        expect(macd[i]).toBeCloseTo(expectedMacd[i], 10)
        // 柱与 dif/dea 的代数恒等式必须逐点成立
        expect(macd[i]).toBeCloseTo(2 * (dif[i] - dea[i]), 10)
      }
    })

    it('三序列长度与输入对齐', () => {
      const { dif, dea, macd } = calcMacd(values)
      expect(dif).toHaveLength(values.length)
      expect(dea).toHaveLength(values.length)
      expect(macd).toHaveLength(values.length)
    })

    it('前段未收敛不报错：全段有限值（tdEma 种子机制下无 NaN/Inf）', () => {
      const { dif, dea, macd } = calcMacd(values)
      for (let i = 0; i < values.length; i++) {
        expect(Number.isFinite(dif[i])).toBe(true)
        expect(Number.isFinite(dea[i])).toBe(true)
        expect(Number.isFinite(macd[i])).toBe(true)
      }
      // 首点：fast/slow 种子相同 → dif[0]=0，dea[0]=0，柱[0]=0
      expect(dif[0]).toBeCloseTo(0, 12)
      expect(dea[0]).toBeCloseTo(0, 12)
      expect(macd[0]).toBeCloseTo(0, 12)
    })

    it('自定义 fast/slow/signal 参数透传到 tdEma', () => {
      const { dif } = calcMacd(values, 5, 10, 3)
      const expectedDif = tdEma(values, 5).map(
        (v, i) => v - tdEma(values, 10)[i],
      )
      for (let i = 0; i < values.length; i++) {
        expect(dif[i]).toBeCloseTo(expectedDif[i], 10)
      }
    })
  })

  describe('calcAmvSeries — 量价合成（spec §3，无 /1e6）', () => {
    it('v1=tdSma(vol,10), v3=MA5(REF(close,1)), AMVc=v1×close/v3×0.1（手算固定值）', () => {
      // 构造常数量价以便手算：amountInYuan 已 ×1000，全 100；close 全 10；open/high/low=9/11/8
      const n = 6
      const input = {
        amountInYuan: Array(n).fill(100),
        open: Array(n).fill(9),
        high: Array(n).fill(11),
        low: Array(n).fill(8),
        close: Array(n).fill(10),
      }
      const r = calcAmvSeries(input)

      // v1 = tdSma([100,...],10) → 全 100（常数）
      // refClose1 = [NaN, 10,10,10,10,10]
      // v3 = MA5(refClose1)：i0 窗口只含 NaN → NaN（→ 异常）；i≥1 → 10
      // AMVc[i≥1] = 100 × 10 / 10 × 0.1 = 10
      // AMVo = 100×9/10×0.1 = 9；AMVh = 100×11/10×0.1 = 11；AMVl = 100×8/10×0.1 = 8
      expect(r.invalid[0]).toBe(true) // v3=NaN → 异常
      expect(Number.isNaN(r.amvClose[0])).toBe(true)
      for (let i = 1; i < n; i++) {
        expect(r.invalid[i]).toBe(false)
        expect(r.amvClose[i]).toBeCloseTo(10, 10)
        expect(r.amvOpen[i]).toBeCloseTo(9, 10)
        expect(r.amvHigh[i]).toBeCloseTo(11, 10)
        expect(r.amvLow[i]).toBeCloseTo(8, 10)
      }
    })

    it('量纲：不做 /1e6（大成交额直接放大为大数值，仅乘 0.1）', () => {
      // amountInYuan 已 ×1000 到元，给一个千万级量；价稳定，验证 AMVc 是元级大数而非 /1e6 后的小数
      const n = 6
      const vol = 1e7 // 元
      const input = {
        amountInYuan: Array(n).fill(vol),
        open: Array(n).fill(10),
        high: Array(n).fill(10),
        low: Array(n).fill(10),
        close: Array(n).fill(10),
      }
      const r = calcAmvSeries(input)
      // i≥1: v1=1e7, v3=10, close=10 → AMVc = 1e7×10/10×0.1 = 1e6
      // 若实现误加 /1e6 则会是 1 —— 此断言锁死"无 /1e6"
      expect(r.amvClose[1]).toBeCloseTo(1e6, 4)
    })

    it('v3≤0（close 全 0）→ 当日四价 NaN + invalid，且不出现 Inf', () => {
      const n = 5
      const input = {
        amountInYuan: Array(n).fill(100),
        open: Array(n).fill(0),
        high: Array(n).fill(0),
        low: Array(n).fill(0),
        close: Array(n).fill(0),
      }
      const r = calcAmvSeries(input)
      // refClose1 全 0/NaN → v3≤0 处处成立 → 全部异常（口径 !(v3>0)）
      for (let i = 0; i < n; i++) {
        expect(r.invalid[i]).toBe(true)
        expect(Number.isNaN(r.amvClose[i])).toBe(true)
        expect(Number.isNaN(r.amvOpen[i])).toBe(true)
        expect(Number.isNaN(r.amvHigh[i])).toBe(true)
        expect(Number.isNaN(r.amvLow[i])).toBe(true)
        // 关键：不得为 ±Infinity（除以 0 的伪装）
        expect(Number.isFinite(r.amvClose[i])).toBe(false)
        expect(r.amvClose[i]).not.toBe(Infinity)
        expect(r.amvClose[i]).not.toBe(-Infinity)
      }
    })

    it('AMVc≤0（当日 close 为负）→ 该日 NaN + invalid（v3 有效但 AMVc 非正）', () => {
      // 前 5 日正常建立正 v3，第 6 日 close=-5 → AMVc<0 → 异常
      const close = [10, 10, 10, 10, 10, -5]
      const n = close.length
      const input = {
        amountInYuan: Array(n).fill(100),
        open: Array(n).fill(9),
        high: Array(n).fill(11),
        low: Array(n).fill(8),
        close,
      }
      const r = calcAmvSeries(input)
      // i=5: refClose1[5]=close[4]=10 → v3=MA5([10,10,10,10,10])=10>0；
      //      AMVc=100×(-5)/10×0.1 = -50 <0 → 异常
      expect(r.invalid[5]).toBe(true)
      expect(Number.isNaN(r.amvClose[5])).toBe(true)
      // 前面正常日不受影响（i=0 因 v3=NaN 异常，i=1..4 正常）
      expect(r.invalid[1]).toBe(false)
      expect(r.amvClose[1]).toBeCloseTo(10, 10)
    })

    it('输出四价 + invalid 长度均与输入对齐', () => {
      const n = 8
      const input = {
        amountInYuan: Array(n).fill(100),
        open: Array(n).fill(9),
        high: Array(n).fill(11),
        low: Array(n).fill(8),
        close: Array(n).fill(10),
      }
      const r = calcAmvSeries(input)
      expect(r.amvOpen).toHaveLength(n)
      expect(r.amvHigh).toHaveLength(n)
      expect(r.amvLow).toHaveLength(n)
      expect(r.amvClose).toHaveLength(n)
      expect(r.invalid).toHaveLength(n)
    })
  })

  describe('calcSignal — 三态边界全覆盖', () => {
    it('多头 +1：DIF>0 且 柱>0', () => {
      expect(calcSignal(1, 1)).toBe(1)
      expect(calcSignal(0.0001, 0.0001)).toBe(1)
    })

    it('空头 -1：DIF<0 且 柱<0', () => {
      expect(calcSignal(-1, -1)).toBe(-1)
      expect(calcSignal(-0.0001, -0.0001)).toBe(-1)
    })

    it('中性 0：DIF=0（柱任意）', () => {
      expect(calcSignal(0, 1)).toBe(0)
      expect(calcSignal(0, -1)).toBe(0)
      expect(calcSignal(0, 0)).toBe(0)
    })

    it('中性 0：柱=0（DIF 任意）', () => {
      expect(calcSignal(1, 0)).toBe(0)
      expect(calcSignal(-1, 0)).toBe(0)
    })

    it('中性 0：DIF 与 柱 异号', () => {
      expect(calcSignal(1, -1)).toBe(0) // DIF>0 且 柱<0
      expect(calcSignal(-1, 1)).toBe(0) // DIF<0 且 柱>0
    })

    it('中性 0：NaN 输入（实现定义：任一为 NaN → 0）', () => {
      expect(calcSignal(NaN, 1)).toBe(0)
      expect(calcSignal(1, NaN)).toBe(0)
      expect(calcSignal(NaN, NaN)).toBe(0)
    })
  })

  describe('calcZdf — 涨跌幅（分母≤0/NaN 落 null）', () => {
    it('正常涨跌幅：(cur-prev)/prev×100', () => {
      // [10,12,11]：i0=null；i1=(12-10)/10×100=20；i2=(11-12)/12×100=-8.3333...
      const out = calcZdf([10, 12, 11])
      expect(out[0]).toBeNull()
      expect(out[1]).toBeCloseTo(20, 10)
      expect(out[2]).toBeCloseTo((-1 / 12) * 100, 10)
    })

    it('首点恒为 null', () => {
      expect(calcZdf([5])[0]).toBeNull()
      expect(calcZdf([5, 6])[0]).toBeNull()
    })

    it('REF(amvClose,1)≤0 → 该点 null（不是 Infinity/NaN）', () => {
      // prev=0：[10,0,5] → i2 prev=0，!(0>0) → null
      const zeroPrev = calcZdf([10, 0, 5])
      expect(zeroPrev[2]).toBeNull()
      // prev<0：[10,-3,5] → i2 prev=-3 → null
      const negPrev = calcZdf([10, -3, 5])
      expect(negPrev[2]).toBeNull()
    })

    it('cur=NaN → null；prev=NaN → null（分母无效）', () => {
      // [10,12,NaN,5]：i2 cur=NaN→null；i3 prev=NaN→null
      const out = calcZdf([10, 12, NaN, 5])
      expect(out[1]).toBeCloseTo(20, 10)
      expect(out[2]).toBeNull()
      expect(out[3]).toBeNull()
    })

    it('全程不出现 Infinity / NaN（只可能是 number 或 null）', () => {
      const out = calcZdf([10, 0, -5, NaN, 8])
      for (const v of out) {
        if (v !== null) {
          expect(Number.isFinite(v)).toBe(true)
        }
      }
    })
  })
})
