/**
 * signal-stats.histogram.ts
 *
 * 收益率分档（直方图）纯函数。
 * 无副作用、不读 DB、不 import NestJS，仿 signal-stats.metrics.ts 风格。
 */

export interface RetHistogramBin {
  lo: number;
  hi: number;
  count: number;
  sign: 'win' | 'loss';
}

export interface RetHistogramResult {
  runId: string;
  sampleCount: number;
  binWidth: number | null;
  bins: RetHistogramBin[];
}

/**
 * niceStep：取 {1, 2, 2.5, 5} × 10^k 中 >= raw 的最小值。
 * 例：raw=0.0067 → 0.01；raw=0.025 → 0.025；raw=0.034 → 0.05
 */
function niceStep(raw: number): number {
  if (raw <= 0) return 0.01;
  const k = Math.floor(Math.log10(raw));
  const base = Math.pow(10, k);
  // 候选：1×base, 2×base, 2.5×base, 5×base, 10×base
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * base);
  for (const c of candidates) {
    // 用相对容差判断，避免浮点误判（例：raw=0.025，c=0.025，0.025/0.025=1.0）
    if (c / raw >= 1 - 1e-9) return c;
  }
  // 理论不可达，兜底
  return candidates[candidates.length - 1];
}

/**
 * buildRetHistogram：将 rets 数组分桶，生成直方图结果。
 *
 * @param runId  所属 run UUID
 * @param rets   每笔收益率数组（number[]），已转换为 JS number
 * @param bins   期望桶数（前端传入，实际受 clamp [5,60] 约束）
 */
export function buildRetHistogram(
  runId: string,
  rets: number[],
  bins: number,
): RetHistogramResult {
  // 空数据兜底
  if (rets.length === 0) {
    return { runId, sampleCount: 0, binWidth: null, bins: [] };
  }

  // 线性求 min/max：避免 Math.min(...rets)/Math.max(...rets) 在大样本下把整段数组展开为
  // 函数实参超 V8 上限抛 RangeError（同 signal-stats.metrics.ts）。
  // 上方 rets.length===0 已 early-return，故 rets[0] 必存在。
  let lo = rets[0];
  let hi = rets[0];
  for (let i = 1; i < rets.length; i++) {
    const v = rets[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo;

  // 确定桶宽
  let w: number;
  if (range === 0) {
    // 全部相等，单档兜底
    w = 0.01;
  } else {
    const clampedBins = Math.min(Math.max(bins, 5), 60);
    const raw = range / clampedBins;
    w = niceStep(raw);
  }

  // 分桶计数
  // 浮点护栏：ret/w 可能因二进制浮点末位偏移（如 0.06/0.02 → 2.9999...）
  // 加 epsilon=1e-9 再 floor，确保恰好在边界上的 ret 归属确定。
  const EPSILON = 1e-9;
  const bucketMap = new Map<number, number>();
  for (const r of rets) {
    const bucket = Math.floor(r / w + EPSILON);
    bucketMap.set(bucket, (bucketMap.get(bucket) ?? 0) + 1);
  }

  // 补齐空档：从 lo 对应的 bucket 到 hi 对应的 bucket 连续遍历
  const bucketLo = Math.floor(lo / w + EPSILON);
  const bucketHi = Math.floor(hi / w + EPSILON);

  const resultBins: RetHistogramBin[] = [];
  for (let b = bucketLo; b <= bucketHi; b++) {
    const binLo = b * w;
    const binHi = (b + 1) * w;
    // sign：lo >= 0 → 'win'（含 bucket 0 精确下边界 0.0）；否则 'loss'
    const sign: 'win' | 'loss' = binLo >= 0 ? 'win' : 'loss';
    resultBins.push({
      lo: binLo,
      hi: binHi,
      count: bucketMap.get(b) ?? 0,
      sign,
    });
  }

  const sampleCount = resultBins.reduce((s, b) => s + b.count, 0);

  return { runId, sampleCount, binWidth: w, bins: resultBins };
}
