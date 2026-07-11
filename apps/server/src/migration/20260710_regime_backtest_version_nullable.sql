-- Allow regime_backtest_run without a linked config version (inline config create).
ALTER TABLE regime_backtest_run
  ALTER COLUMN regime_config_version DROP NOT NULL;
