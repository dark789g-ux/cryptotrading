-- 新增动量（ROC）指标列：roc10 / roc20 / roc60（变化率百分比，double precision nullable）。
-- A 股落 raw.daily_indicator，加密落 klines（指标列与行情同表）。
-- 由 calcIndicators / calcIndicatorsStreaming 计算并随同步流程写入；历史数据靠回填补齐。
-- 不足周期（序列 < N+1 根）或脏数据（prev=0/NaN）写 NULL。

-- A 股：raw.daily_indicator
ALTER TABLE raw.daily_indicator
  ADD COLUMN IF NOT EXISTS roc10 double precision,
  ADD COLUMN IF NOT EXISTS roc20 double precision,
  ADD COLUMN IF NOT EXISTS roc60 double precision;

-- 加密：klines
ALTER TABLE klines
  ADD COLUMN IF NOT EXISTS roc10 double precision,
  ADD COLUMN IF NOT EXISTS roc20 double precision,
  ADD COLUMN IF NOT EXISTS roc60 double precision;
