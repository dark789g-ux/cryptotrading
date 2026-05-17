# 量化模型训练模块 · 剩余待办

> 代码侧 M0→M4 五个里程碑全部已交付（commit `a9f72f2` ~ `be70e18`）；
> 本文档列出**需要你亲自执行**的环境配置、数据回填、模型训练、运维上线动作。
> 每一段都给出具体命令、预计耗时、风险与验收方式。

---

## 0. 全局准备（5 分钟）

- [ ] 配置 TuShare token（M1 起所有 sync 调用必需）
  ```powershell
  # 持久化到用户环境变量（PowerShell 重启后仍生效）
  [Environment]::SetEnvironmentVariable("TUSHARE_TOKEN", "<你的 token>", "User")
  # 当前会话立即生效
  $env:TUSHARE_TOKEN = "<你的 token>"
  ```

- [ ] 配置 quant-pipeline 的 PG_DSN（指向生产 PG）
  ```powershell
  cp apps\quant-pipeline\.env.example apps\quant-pipeline\.env
  # 编辑 apps\quant-pipeline\.env，填：
  # PG_DSN=postgresql+psycopg2://cryptouser:cryptopass@localhost:5432/cryptodb
  # TUSHARE_TOKEN=<你的 token>
  ```

- [ ] 配置 NestJS SSE 鉴权密钥（M2 触发 UI 必需）
  ```powershell
  # 加到 apps/server/.env 或全局环境变量
  [Environment]::SetEnvironmentVariable("QUANT_SSE_TOKEN_SECRET", "<生成一段 32 字符随机串>", "User")
  ```

- [ ] 重启 NestJS 让 M0 entity 改名生效
  ```powershell
  pnpm --filter @cryptotrading/server dev
  # 验证：起服后调一次既有 A 股同步接口，确认写入 raw.* 成功
  ```

---

## 1. M1 数据回填（约 1-2 小时）

> M0 已完成 schema 迁移；本阶段把 TuShare 数据真实拉进来 + 算出 16 个因子。

### 1.1 小范围 dry-run（**强烈建议先做**，10 分钟）

- [ ] 用 1 个月范围验证全链路无异常
  ```powershell
  cd C:\codes\cryptotrading\apps\quant-pipeline
  uv run quant sync raw --date-range 20240601:20240630 `
    --tables trade_cal,stk_limit,suspend,index_classify,index_member,fina_indicator
  uv run quant factors compute --version v1 --date-range 20240601:20240630
  uv run quant quality check --date 20240628 --strict
  uv run quant quality pit-audit
  ```
- [ ] 观察 `ml.quality_reports` 是否有 critical
  ```powershell
  docker exec crypto-postgres psql -U cryptouser -d cryptodb -c `
    "SELECT level, rule, count(*) FROM ml.quality_reports GROUP BY level, rule ORDER BY level, rule;"
  ```

### 1.2 全量回填（约 1-1.5 小时，可挂机过夜）

- [ ] sync 6 张新 raw 表（fina_indicator 最慢，~30-45 min）
  ```powershell
  uv run quant sync raw --date-range 20200101:20260517 `
    --tables trade_cal,stk_limit,suspend,index_classify,index_member,fina_indicator
  ```
  - 中途 Ctrl+C 后重跑会按 PK ON CONFLICT 去重续传，不会重复请求 TuShare

- [ ] factors 全量计算（~30-60 min）
  ```powershell
  uv run quant factors compute --version v1 --date-range 20200101:20260517
  ```
  - 16 因子 × 5500 股 × 1500 日 ≈ 132M 行写 `factors.daily_factors`
  - 预计磁盘占用 10-20 GB（按月分区）

- [ ] 全量 quality 校验
  ```powershell
  uv run quant quality check --date 20240630 --strict
  uv run quant quality check --date 20250630 --strict
  uv run quant quality pit-audit
  ```

### 1.3 M1 验收（5 分钟）

- [ ] 每个因子的 PIT 单测全绿
  ```powershell
  uv run --extra dev pytest tests/unit/test_factors_base.py tests/unit/test_factors_price.py tests/unit/test_factors_industry.py -v
  ```
- [ ] 抽 5 个因子人工核对历史值（如 `momentum_20d` 在 2024-06-28 选 5 支股票）
  ```sql
  SELECT * FROM factors.daily_factors
  WHERE trade_date='20240628' AND factor_id='momentum_20d'
  ORDER BY value DESC LIMIT 5;
  ```
- [ ] 跨表对齐检查
  ```sql
  SELECT (SELECT count(DISTINCT ts_code) FROM raw.daily_quote WHERE trade_date='20240628') AS raw_n,
         (SELECT count(DISTINCT ts_code) FROM factors.daily_factors WHERE trade_date='20240628' AND factor_id='momentum_20d') AS fact_n;
  ```

---

## 2. M2 训练 MVP 通路（约 30 分钟）

> 因子库就绪后，跑出第一个能写 `ml.scores_daily` 的模型。

- [ ] 生成标签
  ```powershell
  uv run quant labels build --scheme strategy-aware --date-range 20200101:20260517
  ```

- [ ] 构建特征矩阵
  ```powershell
  uv run quant features build --factor-version v1 --label-scheme strategy-aware
  # 记下输出的 feature_set_id（形如 fs_xxxxxxxx）
  ```

- [ ] 训练单 fold LightGBM（M2 不接 Walk-Forward）
  ```powershell
  uv run quant train --feature-set fs_xxxxxxxx --model lgb-lambdarank --seed 42
  # 记下输出的 model_version（形如 lgb-lambdarank-v1-20260517-seed42）
  ```

- [ ] 推理一天
  ```powershell
  uv run quant infer --model-version lgb-lambdarank-v1-20260517-seed42 --date 20260516
  ```

- [ ] **M2 验收**：scores 行数严格等于 daily_quote 当日股票数
  ```sql
  SELECT (SELECT count(*) FROM raw.daily_quote WHERE trade_date='20260516') AS raw_n,
         (SELECT count(*) FROM ml.scores_daily WHERE trade_date='20260516') AS scored_n;
  ```

- [ ] **M2 验收**：model.txt 能被 LightGBM CLI 独立加载
  ```powershell
  uv run python -c "import lightgbm as lgb; b=lgb.Booster(model_file='./artifacts/<uuid>/model.txt'); print('trees:', b.num_trees(), 'features:', len(b.feature_name()))"
  ```

---

## 3. M3 Walk-Forward + 三组对照 + 前端 v1（约 2-3 小时）

- [ ] 跑 Walk-Forward 训练（6 折 + embargo 21 日，**会比 M2 慢 6 倍**）
  ```powershell
  uv run quant train --feature-set fs_xxxxxxxx --model lgb-lambdarank --walk-forward
  ```

- [ ] 跑三组对照实验
  ```powershell
  uv run quant evaluate --run-id <model_run_uuid> --ab-baseline linear,gbdt
  # 报告输出到：./artifacts/<run_id>/report.md
  ```

- [ ] **M3 阻塞门槛**（不达不能进 M4）：
  ```
  GBDT vs 线性 OOS NDCG@10 绝对值提升 ≥ 0.015（如 0.500 → ≥ 0.515）
  ```
  - 不达 → 排查方向：标签 5 个坑实现 / 因子覆盖不足 / 中性化没生效
  - 达 → 进 M4

- [ ] 前端三页手测（启动 web dev server）
  ```powershell
  pnpm --filter @cryptotrading/web dev
  # 浏览器：http://localhost:5173/quant
  ```
  逐项验证：
  - [ ] `/quant` Overview：当日 Top-K + OOS 趋势图正常
  - [ ] `/quant/scores` 切换日期 / 模型版本 / top_k，URL 同步刷新
  - [ ] `/quant/runs` 列表 + OOS 指标徽章

- [ ] **M3 验收**：scores 查询 P95 < 500ms（PG EXPLAIN）
  ```powershell
  docker exec crypto-postgres psql -U cryptouser -d cryptodb -c `
    "EXPLAIN ANALYZE SELECT ts_code, score, rank_in_day FROM ml.scores_daily WHERE trade_date='20260516' AND model_version='lgb-lambdarank-v1-20260517-seed42' ORDER BY rank_in_day LIMIT 50;"
  ```

---

## 4. M4 监控 + Optuna + 任务计划（约 1 天 + 3 天观察）

### 4.1 Optuna 调参（数小时，建议过夜）

- [ ] 跑 50 trial Optuna 调参
  ```powershell
  uv run quant tune --feature-set fs_xxxxxxxx --n-trials 50
  # 若中途 kill 进程，再跑一次自动从断点恢复（Optuna PG RDB storage）
  ```

- [ ] **M4 验收**：best_trial 落 `ml.model_runs`
  ```sql
  SELECT model_version, oos_metrics->'ndcg@10' AS ndcg10
  FROM ml.model_runs
  WHERE model_version LIKE 'optuna-best%'
  ORDER BY created_at DESC LIMIT 5;
  ```

### 4.2 Seed Averaging

- [ ] 5 seed 平均
  ```powershell
  uv run quant seed-avg --base lgb-lambdarank-v1-20260517-seed42 --seeds 42,123,456,789,999
  ```

### 4.3 监控

- [ ] 跑一次每日监控
  ```powershell
  uv run quant quality monitor --model-version <ensemble_model_version> --date 20260516
  ```

- [ ] **M4 验收**：模拟特征漂移触发 critical
  ```sql
  -- 手动插入一条假漂移
  INSERT INTO ml.quality_reports (trade_date, level, rule, detail)
  VALUES ('20260517', 'critical', 'feature_drift_psi',
          '{"feature_id":"momentum_20d","psi":0.42,"bins":[]}'::jsonb);
  -- 然后刷新 /quant 顶部应出现红色告警条
  ```

### 4.4 训练 UI 全流程

- [ ] 浏览器手测：
  - [ ] `/quant/jobs` 点"触发训练" → 选 train + 填 feature_set → 提交
  - [ ] 跳转 `/quant/jobs?highlight=<id>` 看进度条 < 2 秒延迟
  - [ ] 完成后跳 `/quant/runs/:id` 看 SHAP top-20 柱状图

### 4.5 任务计划注册（运维上线）

- [ ] 注册 Windows 任务计划（22:00 sync→quality→infer 链）
  ```powershell
  pwsh -File C:\codes\cryptotrading\scripts\quant-daily\register-task.ps1
  schtasks /Query /TN CryptoQuantDaily /V /FO LIST
  ```

- [ ] 干跑确认命令拼装正确
  ```powershell
  pwsh -File C:\codes\cryptotrading\scripts\quant-daily\daily-sync-quality-infer.ps1 -DryRun
  ```

- [ ] **M4 验收**：连续 3 个交易日无人值守
  - 每日 22:30 前 `ml.scores_daily` 行数 = `raw.daily_quote` 行数
  - 任意一天 `ml.jobs.status='failed' OR 'blocked'` 且无人介入 → 失败
  ```sql
  -- 每日早上跑一遍
  SELECT trade_date,
         (SELECT count(*) FROM ml.scores_daily s WHERE s.trade_date=j.params->>'date') AS scored,
         (SELECT count(*) FROM raw.daily_quote q WHERE q.trade_date=j.params->>'date') AS raw_n,
         status, error_text
  FROM ml.jobs j
  WHERE run_type='infer' AND created_at > now() - interval '3 days'
  ORDER BY created_at DESC;
  ```

### 4.6 复盘报告

- [ ] 写 M4 复盘报告（本机 CPU 实测时延 + 是否需要扩容判断）
  - 模板：`doc/m4-capacity-review.md`（已由 M4 agent 留 stub）
  - 决策：当前规模本机 CPU 是否够用？扩到 100+ 因子是否需要迁 Linux server？

---

## 5. 仓库收尾

- [ ] 推送所有 commit 到 remote
  ```powershell
  git push origin main
  git push origin quant-migration-base   # rollback tag
  ```

- [ ] 把 `TODO.md` 在做完后转成 `doc/quant-runbook.md`（作为长期运维手册）

---

## 风险提醒

| 风险 | 预案 |
|---|---|
| TuShare 7000 积分单日耗尽 | fina_indicator 回填分批跑（按年）；其它每分钟限频 500-800 已在 `tushare_client.py` 内做了 |
| factors 回填中途崩溃 | 重跑会按 (trade_date, ts_code, factor_id, factor_version) PK 去重；继续即可 |
| GBDT vs 线性 NDCG@10 < 0.015 | 不通过 M3 验收，回到 M2 排查标签 5 个坑或 M1 加因子；spec 明确这是阻塞门槛 |
| Walk-Forward 报 `min_train_days≥252` | 历史数据不足，回到 M1 扩大 `--date-range` 到 2018 |
| SSE 进度条不动 | 检查 `QUANT_SSE_TOKEN_SECRET` 已配；检查 Python worker 是否在跑；检查 `ml.jobs.heartbeat_at` 是否在更新 |
| Optuna 中断后不恢复 | 验证 `ml.studies / ml.trials` 表存在；同 study_name 再跑会 `load_if_exists=True` 续传 |

---

## 参考文档

- spec 入口：`doc/specs/2026-05-17-quant-model-training/00-index.md`
- 方法论：`doc/量化/00-index.md` ~ `10-术语表.md`
- 项目硬约束：`CLAUDE.md`
- 任务计划脚本：`scripts/quant-daily/README.md`
- pipeline 工程文档：`apps/quant-pipeline/README.md`
