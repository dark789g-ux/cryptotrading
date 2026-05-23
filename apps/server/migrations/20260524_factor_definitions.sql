-- =====================================================================
-- 20260524_factor_definitions.sql
-- 因子元数据单一权威表的 NestJS 侧幂等校验脚本（spec 2026-05-23 §01）
--
-- 用途：
--   - 发布纪录 / 灾难恢复 fallback / CI schema 漂移检测
--   - 正常路径下表由 quant-pipeline 的 Alembic migration
--     (apps/quant-pipeline/.../versions/20260524_0001_factor_definitions.py) 创建
--   - 本脚本仅 IF NOT EXISTS 守护：不重复 DDL，但确保表 / 列 / 索引存在
--
-- CLAUDE.md 硬约束：DB schema 调整须附 docker exec 形式的 .ps1 + .sql 配对
-- 列定义必须与 Alembic migration 完全一致（CI 用 diff 比对两份脚本）
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS factors;

CREATE TABLE IF NOT EXISTS factors.factor_definitions (
  factor_id        VARCHAR(64) NOT NULL,
  factor_version   VARCHAR(16) NOT NULL,
  description      TEXT NOT NULL,
  formula          TEXT NULL,
  data_source      TEXT[] NULL,
  category         VARCHAR(32) NOT NULL,
  pit_window_days  INT NOT NULL,
  pit_anchor       VARCHAR(16) NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  display_order    INT NOT NULL DEFAULT 100,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       VARCHAR(64) NULL,
  CONSTRAINT pk_factor_definitions PRIMARY KEY (factor_id, factor_version),
  CONSTRAINT chk_factor_def_pit_window
    CHECK (pit_window_days BETWEEN 1 AND 400),
  CONSTRAINT chk_factor_def_pit_anchor
    CHECK (pit_anchor IN ('trade_date', 'ann_date')),
  CONSTRAINT chk_factor_def_category
    CHECK (category IN ('price', 'industry', 'fundamental', 'mixed'))
);

CREATE INDEX IF NOT EXISTS idx_factor_definitions_enabled_category
  ON factors.factor_definitions (enabled, category);

-- ---------------------------------------------------------------------
-- 校验脚本（信息性）：表 / 关键列 / 索引存在性 + 行数
-- 缺任何一项 RAISE NOTICE（CI 跟踪），不抛错——本脚本是 fallback，不阻断
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_col_count    INT;
  v_idx_exists   BOOLEAN;
  v_row_count    BIGINT;
BEGIN
  -- 关键列存在性
  SELECT COUNT(*) INTO v_col_count
  FROM information_schema.columns
  WHERE table_schema = 'factors'
    AND table_name   = 'factor_definitions'
    AND column_name  IN (
      'factor_id','factor_version','description','formula','data_source',
      'category','pit_window_days','pit_anchor','enabled','display_order',
      'updated_at','updated_by'
    );
  IF v_col_count <> 12 THEN
    RAISE NOTICE 'factors.factor_definitions 期望 12 个核心列，实际 %（schema 可能漂移）', v_col_count;
  END IF;

  -- 索引存在性
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'factors'
      AND tablename  = 'factor_definitions'
      AND indexname  = 'idx_factor_definitions_enabled_category'
  ) INTO v_idx_exists;
  IF NOT v_idx_exists THEN
    RAISE NOTICE 'factors.factor_definitions 缺索引 idx_factor_definitions_enabled_category';
  END IF;

  -- 行数（信息性输出，发布时人工核对应等于当前 registry 因子数）
  SELECT COUNT(*) INTO v_row_count FROM factors.factor_definitions WHERE factor_version = 'v1';
  RAISE NOTICE 'factors.factor_definitions(v1) 当前行数 = %', v_row_count;
END $$;
