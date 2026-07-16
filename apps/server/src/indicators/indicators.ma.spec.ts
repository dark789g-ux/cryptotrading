/**
 * MA（均线）单测：
 * 1. 批算 calcIndicators 的 MA5/MA30/MA60/MA120/MA240 正确性（窗口不足 null + 手算对拍）
 * 2. 纯函数行为验证：除权跳变场景下 qfqClose 连续则 MA 平滑，raw 跳变则 MA 断层
 *    （注：service 层 close 映射回归由 a-shares-indicator.service.spec.ts 的 MA 对拍守卫）
 * 3. 反向断言：若 close 用 raw 未复权价，MA 会出现断层
 * 4. 流式 calcIndicatorsStreaming 与批算 calcIndicators 数学等价
 */
import { calcIndicators, KlineRow } from './indicators';
import { calcIndicatorsStreaming } from './indicators-stream';

function buildRows(
  n: number,
  opts?: { closeSeq?: number[]; qfqCloseSeq?: number[]; qvolSeq?: number[] },
): KlineRow[] {
  return Array.from({ length: n }, (_, i) => {
    const close = opts?.closeSeq ? opts.closeSeq[i] : 100 + i;
    const qfqClose = opts?.qfqCloseSeq ? opts.qfqCloseSeq[i] : close;
    const qvol = opts?.qvolSeq ? opts.qvolSeq[i] : 1000 + i * 100;
    return {
      open_time: `bar_${i}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      quote_volume: qvol,
      qfqClose,
    } as KlineRow;
  });
}

describe('MA 指标（calcIndicators 批算）', () => {
  it('严格 SMA：窗口不足返回 null', () => {
    // 300 根递增 close
    const rows = buildRows(300);
    const out = calcIndicators(rows);

    // MA5：前 4 根（i < 4）返回 null
    for (let i = 0; i < 4; i++) {
      expect(out[i].MA5).toBeNull();
    }
    // MA60：前 59 根返回 null
    for (let i = 0; i < 59; i++) {
      expect(out[i].MA60).toBeNull();
    }
    // MA240：前 239 根返回 null
    for (let i = 0; i < 239; i++) {
      expect(out[i].MA240).toBeNull();
    }
    // 满窗口后非空
    expect(out[4].MA5).not.toBeNull();
    expect(out[59].MA60).not.toBeNull();
    expect(out[239].MA240).not.toBeNull();
  });

  it('满窗口后正确滚动 + 末值等于手算均值', () => {
    // 已知 close 序列 [1,2,3,4,5,6]
    const closeSeq = [1, 2, 3, 4, 5, 6];
    const rows = buildRows(closeSeq.length, { closeSeq });
    const out = calcIndicators(rows);

    // MA5[4] = (1+2+3+4+5)/5 = 3
    expect(out[4].MA5).toBeCloseTo(3, 8);
    // MA5[5] = (2+3+4+5+6)/5 = 4
    expect(out[5].MA5).toBeCloseTo(4, 8);

    // MA30 和 MA60 窗口不足（只有 6 根），应全部 null
    for (let i = 0; i < 6; i++) {
      expect(out[i].MA30).toBeNull();
      expect(out[i].MA60).toBeNull();
    }
  });

  it('除权场景：qfq 连续则 MA 平滑，raw 跳变则 MA 断层（纯函数行为验证）', () => {
    // 构造含"除权跳变"的 KlineRow 序列：
    // - 除权日（index=80）前 raw close 约为 100，除权后 raw close 跳到 60
    // - qfqClose 全程连续（从约 60 递增到约 180），模拟前复权后的平滑价格
    // - row.close = row.qfqClose（service 里 close: row.qfqClose）
    const n = 200;
    const closeSeq: number[] = [];
    for (let i = 0; i < n; i++) {
      // qfqClose 连续递增，模拟前复权价
      closeSeq.push(60 + i * 0.5);
    }
    const rows = buildRows(n, { closeSeq });
    const out = calcIndicators(rows);

    // 断言：MA60 在除权日附近连续平滑，相邻两天差值 < 1
    // 找到 MA60 第一个非 null 的位置（index >= 59）
    for (let i = 60; i < n - 1; i++) {
      const prev = out[i].MA60;
      const curr = out[i + 1].MA60;
      expect(prev).not.toBeNull();
      expect(curr).not.toBeNull();
      const diff = Math.abs((curr as number) - (prev as number));
      // MA60 是 60 日均值，相邻两天的差值应 < 1（因为 qfqClose 相邻差 0.5，均值变化更小）
      expect(diff).toBeLessThan(1);
    }

    // 反向断言：若故意用 raw 未复权价（除权前 200，除权后 60），MA60 会出现断层
    const exRightDay = 80; // 除权日在 index 80
    const rawCloseSeq: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i < exRightDay) {
        // 除权前 raw close 在 200 附近
        rawCloseSeq.push(200 + i * 0.1);
      } else {
        // 除权后 raw close 跌到 60 附近
        rawCloseSeq.push(60 + (i - exRightDay) * 0.5);
      }
    }
    const rawRows = buildRows(n, { closeSeq: rawCloseSeq, qfqCloseSeq: rawCloseSeq });
    const rawOut = calcIndicators(rawRows);

    // MA60 在 index >= 59 后才有值
    // 对比 index 79（窗口全是高价 200+）和 index 139（窗口内有 60 个低价值）
    const ma60BeforeJump = rawOut[79].MA60;     // 窗口 [20..79]，全部 >= 202
    const ma60AfterJump = rawOut[139].MA60;      // 窗口 [80..139]，全部 <= 99.5
    expect(ma60BeforeJump).not.toBeNull();
    expect(ma60AfterJump).not.toBeNull();
    // 从 ~208 跌到 ~89，差值远超 5
    const jumpDiff = Math.abs((ma60AfterJump as number) - (ma60BeforeJump as number));
    expect(jumpDiff).toBeGreaterThan(5);
  });
});

describe('MA 流式 vs 批算对拍', () => {
  function expectMaEqual(actual: number | null, expected: number | null, label: string) {
    if (expected === null) {
      expect(actual).toBeNull();
    } else {
      expect(actual).not.toBeNull();
      expect(actual as number).toBeCloseTo(expected, 4);
    }
  }

  it('同一序列：calcIndicatorsStreaming 逐根结果与 calcIndicators 完全一致', () => {
    // 300 根含除权跳变的 close 序列
    const n = 300;
    const closeSeq: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i < 100) {
        // 除权前：raw close 在 100 附近
        closeSeq.push(100 + i * 0.1);
      } else {
        // 除权后：前复权价连续，从约 50 递增
        closeSeq.push(50 + (i - 100) * 0.3);
      }
    }
    const rows = buildRows(n, { closeSeq });
    const batch = calcIndicators(rows);
    const stream = calcIndicatorsStreaming(rows);

    expect(stream).toHaveLength(batch.length);
    for (let i = 0; i < batch.length; i++) {
      expectMaEqual(stream[i].row.MA5, batch[i].MA5, `MA5@${i}`);
      expectMaEqual(stream[i].row.MA30, batch[i].MA30, `MA30@${i}`);
      expectMaEqual(stream[i].row.MA60, batch[i].MA60, `MA60@${i}`);
      expectMaEqual(stream[i].row.MA120, batch[i].MA120, `MA120@${i}`);
      expectMaEqual(stream[i].row.MA240, batch[i].MA240, `MA240@${i}`);
    }
  });
});
