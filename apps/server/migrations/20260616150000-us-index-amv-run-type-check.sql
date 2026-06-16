-- ml_jobs_run_type_check 加入 'us_index_amv_sync'
-- 对应 alembic revision: 20260616_0002_add_us_index_amv_sync_run_type.py
-- 权威执行路径: alembic upgrade head（在 apps/quant-pipeline/ 下执行）。
-- 本脚本供 NestJS 侧迁移规范对齐 + 人工核验 / 即时修复，DDL 与 alembic 一致。
--
-- 历史踩坑：新增 run_type 漏更新本 CHECK → INSERT 撞约束 → HTTP 500、无 job 落库。
-- 美股指数 AMV 同步新增 run_type 'us_index_amv_sync'（Python worker 路由）。
-- 现 15 值（真 DB pg_get_constraintdef 核验）的真超集，DROP IF EXISTS + 重建，幂等。
ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check;
ALTER TABLE ml.jobs ADD CONSTRAINT ml_jobs_run_type_check CHECK (
  run_type IN (
    'noop','sync','quality','factors','labels','features',
    'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep',
    'us_sync','us_index_sync','us_index_amv_sync'
  )
);
