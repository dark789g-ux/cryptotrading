import type { CooldownState } from '../cooldown';
import { registerExit } from '../cooldown';
import type { BacktestConfig, CandleExitEvent, KlineBarRow, Position, TradeRecord } from '../models';
import { processPositionCandle } from '../position-handler';
import { createTradeRecord, settleSell } from '../trade-helper';

const DATA_GAP_REASON = '数据断流';

/**
 * 处理当根 K 线各持仓，返回：
 *   - 存活的持仓列表
 *   - 更新后的 cash
 *   - 本根 K 线产生的交易记录列表（TradeRecord[]，含完整和半仓）
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
  skipCooldown = false,
): [Position[], number, TradeRecord[]] {
  const surviving: Position[] = [];
  const tradeRecs: TradeRecord[] = [];

  for (const pos of positions) {
    const df = data.get(pos.symbol);
    if (!df) { surviving.push(pos); continue; }
    const idxMap = tsToIdx.get(pos.symbol);
    if (!idxMap) { surviving.push(pos); continue; }
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) { surviving.push(pos); continue; }

    if (ts === pos.entryTime) {
      // 买入当根特殊处理
      const result = processPositionCandle(pos, df, curIdx, config, { isEntryCandle: true, ts });
      cash += result.cashDelta;
      allTrades.push(...result.trades);

      // 收集交易记录
      tradeRecs.push(...result.trades);

      if (result.action === 'exit_full') {
        // 只对非半仓的完整平仓登记冷却
        const last = result.trades[result.trades.length - 1];
        if (last && !last.isHalf && config.enableCooldown && !skipCooldown) {
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
        const [newCash, rec] = forceCloseOnDataGap(
          pos, df, curIdx, ts, cash, allTrades,
          cooldownState, barIdx, config, skipCooldown,
        );
        cash = newCash;
        tradeRecs.push(rec);
        continue;
      }

      surviving.push(pos);
      continue;
    }

    // 常规 K 线处理
    const result = processPositionCandle(pos, df, curIdx, config, { isEntryCandle: false, ts: String(df[curIdx].open_time) });
    cash += result.cashDelta;
    allTrades.push(...result.trades);

    // 收集交易记录
    tradeRecs.push(...result.trades);

    if (result.action === 'exit_full') {
      // 只对非半仓的完整平仓登记冷却
      const last = tradeRecs[tradeRecs.length - 1];
      if (last && !last.isHalf && config.enableCooldown && !skipCooldown) {
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
      const [newCash, rec] = forceCloseOnDataGap(
        pos, df, curIdx, ts, cash, allTrades,
        cooldownState, barIdx, config,
      );
      cash = newCash;
      tradeRecs.push(rec);
      continue;
    }

    surviving.push(pos);
  }

  return [surviving, cash, tradeRecs];
}

/**
 * 数据断流强平：在该 symbol 最后一根可用 K 线收盘价上平掉剩余仓位。
 * 现金回流，生成 trade 记录，登记冷却（如启用）。
 */
function forceCloseOnDataGap(
  pos: Position,
  df: KlineBarRow[],
  curIdx: number,
  ts: string,
  cash: number,
  allTrades: TradeRecord[],
  cooldownState: CooldownState,
  barIdx: number,
  config: BacktestConfig,
  skipCooldown = false,
): [number, TradeRecord] {
  const closePrice = df[curIdx].close;
  const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, closePrice, pos.shares, config);
  const newCash = cash + netProceeds;

  const holdCandles = Math.max(1, curIdx - pos.entryIdx + 1);
  const rec = createTradeRecord(pos, ts, closePrice, pos.shares, pnl, DATA_GAP_REASON, holdCandles, false, entryFeePortion, exitFee);
  allTrades.push(rec);

  if (config.enableCooldown && !skipCooldown) {
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

  return [newCash, rec];
}
