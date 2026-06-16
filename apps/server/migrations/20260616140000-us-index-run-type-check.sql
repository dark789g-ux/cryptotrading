-- ml_jobs_run_type_check 加入 'us_sync' 与 'us_index_sync'
-- 对应 alembic revision: 20260616_0001_add_us_sync_us_index_sync_run_types.py
-- 权威执行路径: alembic upgrade head（在 apps/quant-pipeline/ 下执行）。
-- 本脚本供 NestJS 侧迁移规范对齐 + 人工核验 / 即时修复，DDL 与 alembic 一致。
--
-- 历史踩坑：新增 run_type 漏更新本 CHECK → INSERT 撞约束 → HTTP 500、无 job 落库。
-- us-stocks 当时只改 TS 侧 run_type 联合 / DTO 白名单、未补本约束 → us_sync 也缺失，
-- 一并补回（旧 13 值约束的真超集，DROP IF EXISTS + 重建，幂等）。
ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check;
ALTER TABLE ml.jobs ADD CONSTRAINT ml_jobs_run_type_check CHECK (
  run_type IN (
    'noop','sync','quality','factors','labels','features',
    'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep',
    'us_sync','us_index_sync'
  )
);
