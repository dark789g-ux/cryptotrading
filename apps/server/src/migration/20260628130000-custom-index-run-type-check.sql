-- ml_jobs_run_type_check 加入 'custom_index_compute'
-- spec: docs/superpowers/specs/2026-06-28-custom-index-create-design/02-data-model.md
--
-- 历史踩坑：新增 run_type 漏更新本 CHECK → INSERT 撞约束 → HTTP 500、无 job 落库。
-- DROP IF EXISTS + 重建，幂等。
ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check;
ALTER TABLE ml.jobs ADD CONSTRAINT ml_jobs_run_type_check CHECK (
  run_type IN (
    'noop','sync','quality','factors','labels','features',
    'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep',
    'us_sync','us_index_sync','us_index_amv_sync','us_one_click_sync',
    'custom_index_compute'
  )
);
