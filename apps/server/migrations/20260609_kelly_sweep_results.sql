-- research.kelly_sweep_results 结果表迁移
-- 对应 alembic revision: 20260609_0001_add_kelly_sweep.py
-- 权威执行路径: alembic upgrade head（在 apps/quant-pipeline/ 下执行）
-- 本脚本供 NestJS 侧迁移规范对齐与人工核验，两者 DDL 内容一致。
--
-- 动作 1：ml_jobs_run_type_check 加入 'kelly_sweep'（DROP + 重建，幂等）
-- 动作 2：建 research schema + kelly_sweep_results 表 + 两个索引（全部 IF NOT EXISTS）

-- ── 动作 1：CHECK 约束 ──────────────────────────────────────────────────────
ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check;
ALTER TABLE ml.jobs ADD CONSTRAINT ml_jobs_run_type_check CHECK (
  run_type IN (
    'noop','sync','quality','factors','labels','features',
    'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep'
  )
);

-- ── 动作 2：research schema + 结果表 + 索引 ─────────────────────────────────
CREATE SCHEMA IF NOT EXISTS research;

CREATE TABLE IF NOT EXISTS research.kelly_sweep_results (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              UUID NOT NULL REFERENCES ml.jobs(id) ON DELETE CASCADE,
  window_group        TEXT NOT NULL,           -- 'with_rs' | 'no_rs'
  variant_id          TEXT NOT NULL,
  variant_filters     JSONB NOT NULL,          -- [[feature,op,value],...]
  exit_id             TEXT NOT NULL,
  exit_cfg            JSONB NOT NULL,          -- {type,...参数}
  n_train             INTEGER NOT NULL,
  kelly_train         DOUBLE PRECISION,        -- 可空(n=0)
  win_rate_train      DOUBLE PRECISION,
  payoff_b_train      DOUBLE PRECISION,
  profit_factor_train DOUBLE PRECISION,
  n_valid             INTEGER NOT NULL,
  kelly_valid         DOUBLE PRECISION,        -- OOS 主排序指标, 可空
  win_rate_valid      DOUBLE PRECISION,
  payoff_b_valid      DOUBLE PRECISION,
  profit_factor_valid DOUBLE PRECISION,
  below_floor         BOOLEAN NOT NULL,        -- n_valid<min_samples
  kelly_ci_low        DOUBLE PRECISION,        -- 仅 top-K 行非空
  kelly_ci_high       DOUBLE PRECISION,
  is_frontier         BOOLEAN NOT NULL DEFAULT FALSE,  -- compute_pareto_frontier 标
  is_topk             BOOLEAN NOT NULL DEFAULT FALSE,  -- rank_top_k 入选标
  same_day_rule       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ksr_job_group
  ON research.kelly_sweep_results (job_id, window_group);
CREATE INDEX IF NOT EXISTS idx_ksr_job_topk
  ON research.kelly_sweep_results (job_id, is_topk, kelly_valid DESC);
