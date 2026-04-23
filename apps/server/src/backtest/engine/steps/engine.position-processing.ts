import type { CooldownState } from '../cooldown';
import { registerExit } from '../cooldown';
import type { BacktestConfig, CandleExitEvent, KlineBarRow, Position, TradeRecord } from '../models';
import { processCandle, processEntryCandle } from '../position-handler';
import { createTradeRecord } from '../trade-helper';

const DATA_GAP_REASON = '数据断流';

/**
 * 处理当根 K 线各持仓，返回：
 *   - 存活的持仓列表
 *   - 更新后的 cash
 *   - 本根 K 线产生的出场事件列表（CandleExitEvent[]，含完整和半仓）
 */
export function processPositions(
  positions: Position[],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  allTrades: TradeRecord[],
  cooldownState: CooldownState,
  barIdx: number,
  config: BacktestConfig,
): [Position[], number, CandleExitEvent[]] {
  const surviving: Position[] = [];
  const exitEvents: CandleExitEvent[] = [];

  for (const pos of positions) {
    const df = data.get(pos.symbol);
    if (!df) { surviving.push(pos); continue; }
    const idxMap = tsToIdx.get(pos.symbol);
    if (!idxMap) { surviving.push(pos); continue; }
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) { surviving.push(pos); continue; }

    if (ts === pos.entryTime) {
      // 买入当根特殊处理
      const [newCash, tradeRecs, exited] = processEntryCandle(
        pos, df, curIdx, ts, cash, config,
      );
      cash = newCash;
      allTrades.push(...tradeRecs);

      // 收集出场事件
      for (const rec of tradeRecs) {
        exitEvents.push({
          symbol: rec.symbol,
          price: rec.exitPrice,
          shares: rec.shares,
          amount: rec.shares * rec.exitPrice,
          pnl: rec.pnl,
          reason: rec.exitReason,
          isHalf: rec.isHalf,
        });
      }

      if (exited) {
        // 只对非半仓的完整平仓登记冷却
        const last = tradeRecs[tradeRecs.length - 1];
        if (last && !last.isHalf && config.enableCooldown) {
          registerExit(
            cooldownState,
            last.pnl > 0,
            false,
            barIdx,
            config.consecutiveLossesThreshold,
            config.maxCooldownCandles,
            config.cooldownExtendOnLoss,
            config.cooldownReduceOnProfit,
          );
        }
        continue;
      }

      // 入场当根未退出：若该 symbol 已无下一根 K 线，按 close 强平（数据断流）
      if (curIdx === df.length - 1) {
        cash = forceCloseOnDataGap(
          pos, df, curIdx, ts, cash, allTrades, exitEvents,
          cooldownState, barIdx, config,
        );
        continue;
      }

      surviving.push(pos);
      continue;
    }

    // 常规 K 线处理
    const [action, cashDelta, tradeRecs] = processCandle(pos, df, curIdx, config);
    cash += cashDelta;
    allTrades.push(...tradeRecs);

    // 收集出场事件
    for (const rec of tradeRecs) {
      exitEvents.push({
        symbol: rec.symbol,
        price: rec.exitPrice,
        shares: rec.shares,
        amount: rec.shares * rec.exitPrice,
        pnl: rec.pnl,
        reason: rec.exitReason,
        isHalf: rec.isHalf,
      });
    }

    if (action === 'exit_full') {
      // 只对非半仓的完整平仓登记冷却
      const last = tradeRecs[tradeRecs.length - 1];
      if (last && !last.isHalf && config.enableCooldown) {
        registerExit(
          cooldownState,
          last.pnl > 0,
          false,
          barIdx,
          config.consecutiveLossesThreshold,
          config.maxCooldownCandles,
          config.cooldownExtendOnLoss,
          config.cooldownReduceOnProfit,
        );
      }
      continue;
    }

    // 常规根未完整出场：若该 symbol 已无下一根 K 线，按 close 强平（数据断流）
    if (curIdx === df.length - 1) {
      cash = forceCloseOnDataGap(
        pos, df, curIdx, ts, cash, allTrades, exitEvents,
        cooldownState, barIdx, config,
      );
      continue;
    }

    surviving.push(pos);
  }

  return [surviving, cash, exitEvents];
}

/**
 * 数据断流强平：在该 symbol 最后一根可用 K 线收盘价上平掉剩余仓位。
 * 现金回流，生成 trade 与 exit 事件，登记冷却（如启用）。
 */
function forceCloseOnDataGap(
  pos: Position,
  df: KlineBarRow[],
  curIdx: number,
  ts: string,
  cash: number,
  allTrades: TradeRecord[],
  exitEvents: CandleExitEvent[],
  cooldownState: CooldownState,
  barIdx: number,
  config: BacktestConfig,
): number {
  const closePrice = df[curIdx].close;
  const proceeds = pos.shares * closePrice;
  const pnl = proceeds - pos.shares * pos.entryPrice;
  const newCash = cash + proceeds;

  const holdCandles = Math.max(1, curIdx - pos.entryIdx + 1);
  const rec = createTradeRecord(pos, ts, closePrice, pos.shares, pnl, DATA_GAP_REASON, holdCandles, false);
  allTrades.push(rec);

  exitEvents.push({
    symbol: rec.symbol,
    price: closePrice,
    shares: pos.shares,
    amount: proceeds,
    pnl,
    reason: DATA_GAP_REASON,
    isHalf: false,
  });

  if (config.enableCooldown) {
    registerExit(
      cooldownState,
      pnl > 0,
      false,
      barIdx,
      config.consecutiveLossesThreshold,
      config.maxCooldownCandles,
      config.cooldownExtendOnLoss,
      config.cooldownReduceOnProfit,
    );
  }

  return newCash;
}
