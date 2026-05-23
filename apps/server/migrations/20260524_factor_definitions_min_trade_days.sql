-- =====================================================================
-- 20260524_factor_definitions_min_trade_days.sql
--
-- PIT 窗口护门（spec 2026-05-23-pit-window-guard-design §02-data-model.md）：
--   - 给 factors.factor_definitions 增加 min_trade_days 列（业务上"最少交易日数"）
--   - 回填现有 16 个因子的 min_trade_days（值来源：源文件 compute() 内硬检查）
--   - 把 pit_window_days 不足 min_trade_days * 2 的行抬高到 min_trade_days * 2
--   - 加跨字段 CHECK pit_window_covers_min_trade_days：pit_window_days >= min_trade_days * 2
--
-- CLAUDE.md 硬约束：DB schema 调整须附 docker exec 形式的 .ps1 + .sql 配对
-- 与 Alembic migration 20260525_0001_add_min_trade_days.py 内容必须等价
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 新增 min_trade_days 列（先用 DEFAULT 1 占位，下面 UPDATE 回填真实值）
-- ---------------------------------------------------------------------
ALTER TABLE factors.factor_definitions
  ADD COLUMN min_trade_days INTEGER NOT NULL DEFAULT 1
  CHECK (min_trade_days BETWEEN 1 AND 250);

-- ---------------------------------------------------------------------
-- 2. 回填 16 个现有因子的 min_trade_days（值来源见 spec §2.5）
--    注意：factor_id 必须照 spec §2.5 表里的 "DB factor_id" 列
--    - industry_neutral_momentum 的 DB factor_id = momentum_20d_neu
--    - industry_rank_in_sector 的 DB factor_id = industry_rank_in_sector_mom20
--    - rsi_14 的 min_trade_days = 15（源码硬检查 len < _N + 1, _N = 14）
-- ---------------------------------------------------------------------

-- ---- 价格类（11 个） ----
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'momentum_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'volatility_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'volume_ratio_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'amihud_illiq_20d';
UPDATE factors.factor_definitions SET min_trade_days = 20 WHERE factor_id = 'ma_ratio_20d';
UPDATE factors.factor_definitions SET min_trade_days = 20 WHERE factor_id = 'turnover_mean_20d';
UPDATE factors.factor_definitions SET min_trade_days = 20 WHERE factor_id = 'bollinger_position_20d';
UPDATE factors.factor_definitions SET min_trade_days = 15 WHERE factor_id = 'rsi_14';
UPDATE factors.factor_definitions SET min_trade_days = 61 WHERE factor_id = 'momentum_60d';
UPDATE factors.factor_definitions SET min_trade_days = 60 WHERE factor_id = 'close_to_high_60d';
UPDATE factors.factor_definitions SET min_trade_days = 60 WHERE factor_id = 'price_max_drawdown_60d';

-- ---- 行业类（5 个） ----
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'industry_momentum_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'momentum_20d_neu';                  -- 类: IndustryNeutralMomentum
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'industry_rank_in_sector_mom20';    -- 类: IndustryRankInSector
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'industry_relative_strength';
UPDATE factors.factor_definitions SET min_trade_days = 1  WHERE factor_id = 'sector_volume_concentration';

-- ---------------------------------------------------------------------
-- 回填覆盖校验：期望 16 行命中（min_trade_days > 1 OR factor_id = 'sector_volume_concentration'）
-- sector_volume_concentration 期望值就是 1，与 DEFAULT 1 不可分，故单独 OR 检测
-- 命中 < 16 → factor_id 拼错或 DB 缺行，立刻 RAISE EXCEPTION
-- ---------------------------------------------------------------------
DO $$
DECLARE
  expected INTEGER := 16;
  actual   INTEGER;
BEGIN
  SELECT COUNT(*) INTO actual
  FROM factors.factor_definitions
  WHERE min_trade_days > 1
     OR factor_id = 'sector_volume_concentration';
  IF actual < expected THEN
    RAISE EXCEPTION 'min_trade_days 回填覆盖不足: 期望 %, 实际 %（factor_id 可能拼错）', expected, actual;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. 落跨字段约束前，把 pit_window_days 不足的行抬高到 min_trade_days * 2
--    （CLAUDE.md 反静默吞错：抬高时记 NOTICE 暴露副作用）
-- ---------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT factor_id, factor_version, pit_window_days, min_trade_days
    FROM factors.factor_definitions
    WHERE pit_window_days < min_trade_days * 2
  LOOP
    RAISE NOTICE 'Lifting pit_window_days for %/%: % -> %',
      r.factor_id, r.factor_version, r.pit_window_days, r.min_trade_days * 2;
  END LOOP;
END $$;

UPDATE factors.factor_definitions
  SET pit_window_days = min_trade_days * 2
  WHERE pit_window_days < min_trade_days * 2;

-- ---------------------------------------------------------------------
-- 4. 添加跨字段 CHECK 约束（DB 层兜底；系数 2.0 由 Python factors/constants.py 单点定义，
--    CHECK 用整数 * 2 等价 ceil(min_trade_days × 2.0)，避免 PG CHECK 浮点）
-- ---------------------------------------------------------------------
ALTER TABLE factors.factor_definitions
  ADD CONSTRAINT pit_window_covers_min_trade_days
  CHECK (pit_window_days >= min_trade_days * 2);
