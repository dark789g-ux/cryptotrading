-- 信号滚动指标派生表 + 同步态脏列（复刻"底部放天量涨停"用）
CREATE TABLE IF NOT EXISTS signal_rolling_indicator (
  id                bigserial PRIMARY KEY,
  ts_code           character varying NOT NULL,
  trade_date        character varying(8) NOT NULL,
  pos_120           double precision,
  pos_60            double precision,
  close_ma60_ratio  double precision,
  vol_ratio_60      double precision,
  vol_ratio_120     double precision,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_signal_rolling_indicator_code_date UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_signal_rolling_indicator_code_date
  ON signal_rolling_indicator (ts_code, trade_date DESC);

-- 滚动指标基于 qfq，qfq 回算时需重算；按 ts_code 记脏起点（与 indicator_dirty_from_date 并列）
ALTER TABLE a_share_sync_states
  ADD COLUMN IF NOT EXISTS signal_rolling_dirty_from_date character varying(8);
