-- ============================================
-- 回填 backtest_trades.trade_phase 历史数据
-- ============================================
-- 说明：
--   旧表结构没有保存 isSimulation / tradePhase，新增列后全部为 NULL。
--   本脚本根据 backtest_runs.config_snapshot 中的 enableKellySizing 和
--   kellySimTrades，按 entry_time 去重后取前 N 个不同的入场时间，把对应
--   交易近似标记为 'simulation'，其余标记为 'live'。
--   由于旧数据没有保存 isHalf，无法精确区分"完整交易"与"半仓交易"，
--   此脚本是最佳近似回填方案。
-- ============================================

-- 1. 确保列已存在
ALTER TABLE backtest_trades ADD COLUMN IF NOT EXISTS trade_phase VARCHAR(20);

-- 2. 先全部设为 live
UPDATE backtest_trades SET trade_phase = 'live' WHERE trade_phase IS NULL;

-- 3. 对启用凯利的回测，把前 kellySimTrades 个不同 entry_time 的交易标记为 simulation
WITH run_configs AS (
  SELECT
    id AS run_id,
    COALESCE((config_snapshot->>'enableKellySizing')::boolean, false) AS enable_kelly,
    COALESCE((config_snapshot->>'kellySimTrades')::int, 0) AS sim_trades
  FROM backtest_runs
  WHERE COALESCE((config_snapshot->>'enableKellySizing')::boolean, false) = true
    AND COALESCE((config_snapshot->>'kellySimTrades')::int, 0) > 0
),
ranked_entries AS (
  SELECT
    t.run_id,
    t.entry_time,
    DENSE_RANK() OVER (PARTITION BY t.run_id ORDER BY t.entry_time) AS entry_rank
  FROM backtest_trades t
  JOIN run_configs rc ON t.run_id = rc.run_id
  GROUP BY t.run_id, t.entry_time
),
sim_entries AS (
  SELECT re.run_id, re.entry_time
  FROM ranked_entries re
  JOIN run_configs rc ON re.run_id = rc.run_id
  WHERE re.entry_rank <= rc.sim_trades
)
UPDATE backtest_trades bt
SET trade_phase = 'simulation'
FROM sim_entries se
WHERE bt.run_id = se.run_id
  AND bt.entry_time = se.entry_time
  AND bt.trade_phase = 'live';

-- 4. 验证结果（可选）
-- SELECT
--   bt.trade_phase,
--   COUNT(*)
-- FROM backtest_trades bt
-- GROUP BY bt.trade_phase;
