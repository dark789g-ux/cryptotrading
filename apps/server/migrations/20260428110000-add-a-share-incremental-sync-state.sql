CREATE TABLE IF NOT EXISTS a_share_indicator_calc_states (
  id bigserial PRIMARY KEY,
  ts_code character varying NOT NULL,
  trade_date character varying(8) NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_a_share_indicator_calc_states_code_date UNIQUE (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_a_share_indicator_calc_states_code_date
  ON a_share_indicator_calc_states (ts_code, trade_date DESC);

CREATE TABLE IF NOT EXISTS a_share_sync_states (
  ts_code character varying PRIMARY KEY,
  qfq_dirty_from_date character varying(8),
  indicator_dirty_from_date character varying(8),
  indicator_calculated_to_date character varying(8),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_a_share_sync_states_qfq_dirty
  ON a_share_sync_states (qfq_dirty_from_date)
  WHERE qfq_dirty_from_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_a_share_sync_states_indicator_dirty
  ON a_share_sync_states (indicator_dirty_from_date)
  WHERE indicator_dirty_from_date IS NOT NULL;
