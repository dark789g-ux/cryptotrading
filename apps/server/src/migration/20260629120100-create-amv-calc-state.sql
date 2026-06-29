-- 20260629120100 创建 raw.amv_calc_state（个股 AMV streaming 递推状态 checkpoint，③-a）
-- 镜像 raw.indicator_calc_state（entities/raw/indicator-calc-state.entity.ts）。
-- 执行（docker exec 格式）：
--   Get-Content -Raw apps/server/src/migration/20260629120100-create-amv-calc-state.sql |
--     docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -
--
-- 说明：
--   - AMV dirty 续算的 seed / 快照：按 (ts_code, trade_date) 唯一，稀疏写入（每 N 行一 checkpoint）。
--   - 用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，幂等可重跑。

CREATE TABLE IF NOT EXISTS raw.amv_calc_state (
  id bigserial PRIMARY KEY,
  ts_code varchar NOT NULL,
  trade_date varchar(8) NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_amv_calc_state UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_amv_calc_state_ts_code ON raw.amv_calc_state(ts_code);
