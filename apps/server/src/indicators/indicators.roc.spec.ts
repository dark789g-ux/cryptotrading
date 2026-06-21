/**
 * ROC（动量/变化率百分比）单测：
 * 1. 批算 calcIndicators 的 roc10/20/60 正确性（手算对拍）
 * 2. 流式 calcIndicatorsStreaming 与批算 calcIndicators 数学等价
 * 3. 边界：不足周期 → null；prev=0/NaN → null（fail-closed）
 */
import { calcIndicators, KlineRow } from './indicators';
import { calcIndicatorsStreaming } from './indicators-stream';

/** 构造 N 根 close 递增的 KlineRow（close = 100 + i*2，便于手算 ROC） */
function buildRows(n: number, closeSeq?: number[]): KlineRow[] {
  return Array.from({ length: n }, (_, i) => {
    const close = closeSeq ? closeSeq[i] : 100 + i * 2;
    return {
      open_time: `bar_${i}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
    } as KlineRow;
  });
}

describe('ROC 指标（calcIndicators 批算）', () => {
  it('roc10：前 10 根为 null，第 11 根（i=10）起有值', () => {
    const rows = buildRows(30);
    const out = calcIndicators(rows);
    // i < 10 → null
    for (let i = 0; i < 10; i++) {
      expect(out[i].roc10).toBeNull();
    }
    // i = 10：close[10]=120, close[0]=100 → (120-100)/100*100 = 20
    expect(out[10].roc10).toBeCloseTo(20, 6);
  });

  it('roc20：前 20 根为 null，i=20 起 (close[20]-close[0])/close[0]*100', () => {
    const rows = buildRows(40);
    const out = calcIndicators(rows);
    for (let i = 0; i < 20; i++) {
      expect(out[i].roc20).toBeNull();
    }
    // close[20]=140, close[0]=100 → 40
    expect(out[20].roc20).toBeCloseTo(40, 6);
  });

  it('roc60：前 60 根为 null，i=60 起', () => {
    const rows = buildRows(70);
    const out = calcIndicators(rows);
    for (let i = 0; i < 60; i++) {
      expect(out[i].roc60).toBeNull();
    }
    // close[60]=220, close[0]=100 → 120
    expect(out[60].roc60).toBeCloseTo(120, 6);
  });

  it('prev=0（脏数据）→ null（fail-closed）', () => {
    // 第 0 根 close=0，第 10 根算 roc10 时 prev=closes[0]=0
    const closes = Array.from({ length: 15 }, (_, i) => (i === 0 ? 0 : 100 + i * 2));
    const rows = buildRows(15, closes);
    const out = calcIndicators(rows);
    // i=10：prev=closes[0]=0 → null
    expect(out[10].roc10).toBeNull();
    // i=11：prev=closes[1]=102 正常
    expect(out[11].roc10).not.toBeNull();
  });

  it('负动量：价格下跌时 ROC 为负', () => {
    // close 递减：200, 198, 196, ...
    const closes = Array.from({ length: 15 }, (_, i) => 200 - i * 2);
    const rows = buildRows(15, closes);
    const out = calcIndicators(rows);
    // i=10: close[10]=180, close[0]=200 → (180-200)/200*100 = -10
    expect(out[10].roc10).toBeCloseTo(-10, 6);
  });
});

describe('ROC 流式 vs 批算对拍', () => {
  /** 断言流式与批算的 roc 值一致（含 null 情况） */
  function expectRocEqual(actual: number | null, expected: number | null, label: string) {
    if (expected === null) {
      expect(actual).toBeNull();
    } else {
      expect(actual).not.toBeNull();
      expect(actual as number).toBeCloseTo(expected, 6);
    }
  }

  it('同一序列：calcIndicatorsStreaming 逐根结果与 calcIndicators 完全一致', () => {
    // 构造 80 根带波动的序列（覆盖 roc10/20/60 三个周期）
    const closes = Array.from({ length: 80 }, (_, i) =>
      100 + i * 1.5 + Math.sin(i / 7) * 8 + (i % 5 === 0 ? -3 : 0),
    );
    const rows = buildRows(80, closes);

    const batch = calcIndicators(rows);
    const stream = calcIndicatorsStreaming(rows);

    expect(stream).toHaveLength(batch.length);
    for (let i = 0; i < batch.length; i++) {
      expectRocEqual(stream[i].row.roc10, batch[i].roc10, `roc10@${i}`);
      expectRocEqual(stream[i].row.roc20, batch[i].roc20, `roc20@${i}`);
      expectRocEqual(stream[i].row.roc60, batch[i].roc60, `roc60@${i}`);
    }
  });

  it('流式带种子续算：续算结果与一次性批算一致', () => {
    const closes = Array.from({ length: 70 }, (_, i) => 50 + i * 3 + Math.cos(i / 5) * 4);
    const rows = buildRows(70, closes);

    // 前 40 根流式算 + 取最后一根的 state
    const part1 = calcIndicatorsStreaming(rows.slice(0, 40));
    const seed = part1[part1.length - 1].state;
    // 后 30 根用种子续算
    const part2 = calcIndicatorsStreaming(rows.slice(40), seed);

    // 拼接后的 roc 值应与一次性批算一致
    const full = calcIndicators(rows);
    for (let i = 0; i < 40; i++) {
      expectRocEqual(part1[i].row.roc10, full[i].roc10, `p1.roc10@${i}`);
      expectRocEqual(part1[i].row.roc20, full[i].roc20, `p1.roc20@${i}`);
    }
    for (let i = 0; i < 30; i++) {
      const fullIdx = 40 + i;
      expectRocEqual(part2[i].row.roc10, full[fullIdx].roc10, `p2.roc10@${i}`);
      expectRocEqual(part2[i].row.roc20, full[fullIdx].roc20, `p2.roc20@${i}`);
      expectRocEqual(part2[i].row.roc60, full[fullIdx].roc60, `p2.roc60@${i}`);
    }
  });
});
