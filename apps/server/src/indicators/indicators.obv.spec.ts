/**
 * OBV（成交额版）单测：
 * 1. 批算 calcIndicators 的 obv5d/10d/20d 正确性（手算对拍）
 * 2. 流式 calcIndicatorsStreaming 与批算 calcIndicators 数学等价
 * 3. 边界：不足周期 → null；持平 → 0
 */
import { calcIndicators, KlineRow } from './indicators';
import { calcIndicatorsStreaming } from './indicators-stream';

function buildRows(
  n: number,
  opts?: { closeSeq?: number[]; qvolSeq?: number[] },
): KlineRow[] {
  return Array.from({ length: n }, (_, i) => {
    const close = opts?.closeSeq ? opts.closeSeq[i] : 100 + i;
    const qvol = opts?.qvolSeq ? opts.qvolSeq[i] : 1000 + i * 100;
    return {
      open_time: `bar_${i}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      quote_volume: qvol,
    } as KlineRow;
  });
}

describe('OBV 指标（calcIndicators 批算）', () => {
  it('上涨取正、下跌取负、持平取 0', () => {
    // 5 根：平、涨、跌、涨、平
    // close: 100, 100, 110, 105, 115, 115
    const closeSeq = [100, 100, 110, 105, 115, 115];
    const qvolSeq = [1000, 2000, 3000, 4000, 5000, 6000];
    const rows = buildRows(closeSeq.length, { closeSeq, qvolSeq });
    const out = calcIndicators(rows);

    // signed: [0, 0, 3000, -4000, 5000, 0]
    expect(out[0].obv5d).toBeNull();
    expect(out[1].obv5d).toBeNull();
    expect(out[2].obv5d).toBeNull();
    expect(out[3].obv5d).toBeNull();
    // i=4: sum signed[0..4] = 0+0+3000-4000+5000 = 4000
    expect(out[4].obv5d).toBeCloseTo(4000, 2);
    // i=5: sum signed[1..5] = 0+3000-4000+5000+0 = 4000
    expect(out[5].obv5d).toBeCloseTo(4000, 2);
  });

  it('窗口不足时返回 null，满窗口后正确滚动', () => {
    // 25 根 close 严格递增，qvol 固定 1000
    // signed 每根均为 +1000
    const closeSeq = Array.from({ length: 25 }, (_, i) => 100 + i);
    const qvolSeq = Array.from({ length: 25 }, () => 1000);
    const rows = buildRows(25, { closeSeq, qvolSeq });
    const out = calcIndicators(rows);

    // obv5d: i < 4 null, i >= 4 为 4000（signed[0]=0, signed[1]=0）
    for (let i = 0; i < 4; i++) expect(out[i].obv5d).toBeNull();
    expect(out[4].obv5d).toBeCloseTo(4000, 2);
    expect(out[24].obv5d).toBeCloseTo(5000, 2);

    // obv10d: i < 9 null, i >= 9 为 9000（signed[0]=0）
    for (let i = 0; i < 9; i++) expect(out[i].obv10d).toBeNull();
    expect(out[9].obv10d).toBeCloseTo(9000, 2);
    expect(out[24].obv10d).toBeCloseTo(10000, 2);

    // obv20d: i < 19 null, i >= 19 为 19000（signed[0]=0）
    for (let i = 0; i < 19; i++) expect(out[i].obv20d).toBeNull();
    expect(out[19].obv20d).toBeCloseTo(19000, 2);
    expect(out[24].obv20d).toBeCloseTo(20000, 2);
  });

  it('混合涨跌时滚动和正确', () => {
    // 10 根，qvol 固定 100，close 涨跌交替
    const closeSeq = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106];
    const qvolSeq = Array.from({ length: 10 }, () => 100);
    const rows = buildRows(10, { closeSeq, qvolSeq });
    const out = calcIndicators(rows);

    // signed: [0, +100, -100, +100, -100, +100, -100, +100, -100, +100]
    // obv10d@9 = 0+100-100+100-100+100-100+100-100+100 = 100
    expect(out[9].obv10d).toBeCloseTo(100, 2);
  });
});

describe('OBV 流式 vs 批算对拍', () => {
  function expectObvEqual(actual: number | null, expected: number | null, label: string) {
    if (expected === null) {
      expect(actual).toBeNull();
    } else {
      expect(actual).not.toBeNull();
      expect(actual as number).toBeCloseTo(expected, 6);
    }
  }

  it('同一序列：calcIndicatorsStreaming 逐根结果与 calcIndicators 完全一致', () => {
    const closeSeq = Array.from({ length: 80 }, (_, i) =>
      100 + i * 1.5 + Math.sin(i / 7) * 8 + (i % 5 === 0 ? -3 : 0),
    );
    const qvolSeq = Array.from({ length: 80 }, (_, i) => 1000 + i * 50 + Math.cos(i / 3) * 100);
    const rows = buildRows(80, { closeSeq, qvolSeq });

    const batch = calcIndicators(rows);
    const stream = calcIndicatorsStreaming(rows);

    expect(stream).toHaveLength(batch.length);
    for (let i = 0; i < batch.length; i++) {
      expectObvEqual(stream[i].row.obv5d, batch[i].obv5d, `obv5d@${i}`);
      expectObvEqual(stream[i].row.obv10d, batch[i].obv10d, `obv10d@${i}`);
      expectObvEqual(stream[i].row.obv20d, batch[i].obv20d, `obv20d@${i}`);
    }
  });

  it('流式带种子续算：续算结果与一次性批算一致', () => {
    const closeSeq = Array.from({ length: 70 }, (_, i) => 50 + i * 3 + Math.cos(i / 5) * 4);
    const qvolSeq = Array.from({ length: 70 }, (_, i) => 2000 + i * 100);
    const rows = buildRows(70, { closeSeq, qvolSeq });

    const part1 = calcIndicatorsStreaming(rows.slice(0, 40));
    const seed = part1[part1.length - 1].state;
    const part2 = calcIndicatorsStreaming(rows.slice(40), seed);

    const full = calcIndicators(rows);
    for (let i = 0; i < 40; i++) {
      expectObvEqual(part1[i].row.obv5d, full[i].obv5d, `p1.obv5d@${i}`);
      expectObvEqual(part1[i].row.obv10d, full[i].obv10d, `p1.obv10d@${i}`);
      expectObvEqual(part1[i].row.obv20d, full[i].obv20d, `p1.obv20d@${i}`);
    }
    for (let i = 0; i < 30; i++) {
      const fullIdx = 40 + i;
      expectObvEqual(part2[i].row.obv5d, full[fullIdx].obv5d, `p2.obv5d@${i}`);
      expectObvEqual(part2[i].row.obv10d, full[fullIdx].obv10d, `p2.obv10d@${i}`);
      expectObvEqual(part2[i].row.obv20d, full[fullIdx].obv20d, `p2.obv20d@${i}`);
    }
  });

  it('每行 state 为独立引用（去 cloneState 优化契约）', () => {
    const rows = buildRows(30, {
      closeSeq: Array.from({ length: 30 }, (_, i) => 100 + i * 1.5),
      qvolSeq: Array.from({ length: 30 }, (_, i) => 1000 + i * 50),
    });
    const stream = calcIndicatorsStreaming(rows);

    // 每行 state 必须是不同的对象引用（因为 next() 每次新建 nextState）
    expect(stream).toHaveLength(30);
    expect(stream[0].state).not.toBe(stream[1].state);
    expect(stream[0].state).not.toBe(stream[29].state);
    expect(stream[1].state).not.toBe(stream[29].state);

    // state 内部的数组字段（closes）也必须是不同引用
    expect(stream[0].state.closes).not.toBe(stream[1].state.closes);
  });
});
