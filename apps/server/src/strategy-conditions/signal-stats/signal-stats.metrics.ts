/**
 * signal-stats.metrics.ts
 *
 * 指标聚合纯函数：将逐笔前向收益数组聚合为胜率/盈亏比等统计指标。
 * 无副作用、不读 DB、不 import NestJS。
 */

export interface SignalStatsResult {
  sampleCount: number;          // N，有效样本数
  winRate: number | null;       // p = wins/N，0~1
  avgWin: number | null;        // 盈利样本 ret 均值（>0）
  avgLoss: number | null;       // 亏损样本 ret 均值（<0）
  payoffRatio: number | null;   // 赔率 b = avgWin / |avgLoss|
  profitFactor: number | null;  // Σwins / |Σlosses|
  kellyF: number | null;        // 凯利 f* = p - (1-p)/b
  avgHoldDays: number | null;
  worstTradeRet: number | null; // 最差单笔 = min(ret)
  bestTradeRet: number | null;  // 最佳单笔 = max(ret)
}

/**
 * 计算信号前向统计指标。
 *
 * @param rets     每笔前向收益（ret = exit_price/buy_price - 1），与 holdDays 一一对应
 * @param holdDays 每笔持仓交易日数，与 rets 等长
 * @returns        聚合统计结果；任何可能导致除零/NaN/Infinity 的分支均返回 null
 */
export function calcSignalStats(
  rets: number[],
  holdDays: number[],
): SignalStatsResult {
  const N = rets.length;

  // N=0：全部 null
  if (N === 0) {
    return {
      sampleCount: 0,
      winRate: null,
      avgWin: null,
      avgLoss: null,
      payoffRatio: null,
      profitFactor: null,
      kellyF: null,
      avgHoldDays: null,
      worstTradeRet: null,
      bestTradeRet: null,
    };
  }

  // 分组：ret>0 为盈，ret<0 为亏，ret===0 不计入 wins/losses
  const winRets = rets.filter((r) => r > 0);
  const lossRets = rets.filter((r) => r < 0);

  // 辅助：均值（调用前须确认数组非空）
  const mean = (arr: number[]): number =>
    arr.reduce((sum, v) => sum + v, 0) / arr.length;

  // 辅助：求和
  const sum = (arr: number[]): number => arr.reduce((s, v) => s + v, 0);

  // 基础指标
  const winRate = winRets.length / N;
  const avgWin = winRets.length > 0 ? mean(winRets) : null;
  const avgLoss = lossRets.length > 0 ? mean(lossRets) : null;

  // 赔率：avgLoss 为空（无亏损样本）→ null；avgLoss=0 理论不可能（<0 才入 losses），但仍 guard
  const payoffRatio =
    avgWin !== null && avgLoss !== null && avgLoss !== 0
      ? avgWin / Math.abs(avgLoss)
      : null;

  // 盈亏比：losses 为空 → null；有亏损（losses 非空）→ Σwins/|Σlosses|
  // 注：wins 为空时 sum(winRets)=0，结果 0，符合"全亏"口径
  const profitFactor =
    lossRets.length > 0
      ? sum(winRets) / Math.abs(sum(lossRets))
      : null;

  // 凯利：payoffRatio 不可用（null）或 <=0（理论上 >0，但 guard 以防万一）时 → null
  const kellyF =
    winRate !== null && payoffRatio !== null && payoffRatio > 0
      ? winRate - (1 - winRate) / payoffRatio
      : null;

  // 平均持仓天数：N>0（已在上方 early-return 处理过 N=0）
  const avgHoldDays = mean(holdDays);

  // 最差单笔 / 最佳单笔
  // 用线性扫描而非 Math.min(...rets)/Math.max(...rets)：后者把整段数组展开为函数实参，
  // 大样本（实测 ~12.5 万以上）超 V8 实参上限抛 RangeError: Maximum call stack size exceeded。
  // 上方 N===0 已 early-return，故 rets[0] 必存在。
  let worstTradeRet = rets[0];
  let bestTradeRet = rets[0];
  for (let i = 1; i < N; i++) {
    const r = rets[i];
    if (r < worstTradeRet) worstTradeRet = r;
    if (r > bestTradeRet) bestTradeRet = r;
  }

  return {
    sampleCount: N,
    winRate,
    avgWin,
    avgLoss,
    payoffRatio,
    profitFactor,
    kellyF,
    avgHoldDays,
    worstTradeRet,
    bestTradeRet,
  };
}
