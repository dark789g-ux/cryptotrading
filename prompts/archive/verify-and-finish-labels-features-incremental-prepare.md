# 任务：labels/features 增量物化 + 备料/训练解耦 —— 真机验证与收尾

## 一句话目标
代码已**全栈实现并提交**（分支 `feat/quant-strategy-management`），你来完成 **真机端到端验证**（头号是约束 1 正确性逐行比对）、按需修已知 Minor、最后走 `finishing-a-development-branch` 整合分支。**不要重写已完成的代码**，先验证、再按发现修补。

## 先读这两个（建立上下文）
- **设计 spec**：`docs/superpowers/specs/2026-06-06-labels-features-incremental-prepare-design/`（`index.md` 入口；`02-incremental-algorithm.md` 是正确性红线，`06-testing-verification.md` 是验证方案）。
- **记忆**：`project_labels_features_incremental_prepare`（含正确性坑 + 实施进度 + 已知 Minor，会在 recall 里出现）。

## 背景：这次改造做了什么
1. **增量物化**：`compute_labels` / `build_feature_matrix` 从"按整段 date_range 重算 + upsert 覆盖"改成"查已物化 trade_date → 只算缺口子区间"。新增 `force_recompute` 参数（默认 `False`=增量；`True`=整段重算覆盖，等价旧行为）。
2. **备料/训练解耦**：新增 `prepare` run_type（labels→features 增量串联备料），**废弃 `train_e2e`**；训练（train/optuna/seed_avg）不再现算料，只吃 `feature_set_id` + `date_range`，且 `date_range` 必须落在该 feature_set 已物化覆盖区间 `R_F` 内（前端 disable + 后端 400 兜底）。
3. **底座**：`feature_matrix` = features inner join labels，训练只认 `R_F`（= `feature_matrix[fs]` 覆盖区间）一个量。

## 已完成（代码全提交，勿重做）
12 个任务全栈完成，每个过独立审查 + 最终端到端 review。关键模块：
- `apps/quant-pipeline/src/quant_pipeline/labels_features_incremental.py`（gap_subranges/coverage_ranges/query_*）
- `labels/runner.py`、`features/runner.py`（`compute_labels`/`build_feature_matrix` 加 `force_recompute` + 缺口循环）
- `worker/prepare_runner.py`（`run_prepare`）、`worker/dispatcher.py`（注册 prepare、删 train_e2e 路由）
- `db/migrations/versions/20260606_0003_feature_sets_label_ref.py`（feature_sets 加列，**尚未 upgrade**）
- server：`modules/quant/feature-sets/*`（feature-sets API + coverage）、`dto/create-job.dto.ts` + `services/quant-jobs.service.ts`（run_type 契约 + ⊆R_F 校验）
- web：`PrepareModal.vue`、`QuantTrainTriggerModal.vue`+`train-modal/*`（选已备 fs + date_range disable）、`QuantJobsView.vue`（备料入口）

## ★必做：真机验证（子代理/CI 做不了，需 docker DB + 重启常驻进程）

### 步骤 0 — 应用 migration（先防 alembic drift）
```powershell
cd apps/quant-pipeline
uv run alembic current        # 必须先确认 current 对齐 head，否则 drift（见 project_alembic_drift 教训）
uv run alembic upgrade head   # 应用 feature_sets 加 label_id/label_version
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.feature_sets"  # 验证两列已加
```

### 步骤 1 — 重启常驻进程（代码已改，不热加载）
- worker：删 `__pycache__` 后重启（`uv run quant worker run` 或项目惯例）。
- server：重启（`nest start` 无 watch，改了代码必重启）。
- web：`vite` HMR 自动，无需重启。

### 步骤 2 — 端到端功能（前端真机点）
- **备料**：QuantJobsView「备料」按钮 → 选命名标签 + factor_version + 区间 + 备料参数 → 提交 → 看 prepare job 跑 `labels→features` 增量物化、成功。
- **增量省时**：再用**更大区间**对同一标签+版本备料一次 → 日志应出现 `skipped_dates`（重叠跳过）、labels/features 耗时显著少于第一次的等比例。
- **训练翻转**：「触发训练」→ 选「已备 feature_set」下拉（显示标签名+覆盖区间）→ date_range 选择器只能选覆盖区间内（空洞/越界日期 disable）→ 提交 train → 出模型。
- **越界拦截**：尝试选超出覆盖的 date_range → 前端应 disable 选不出；若直接 POST（绕前端）→ 后端 400 带"请先 prepare 备料"提示。

### 步骤 3 — ★正确性逐行比对（约束 1 头号，真 DB，别只信单测）
**必须用 strategy_aware（含 ma_break 出场规则）的命名标签**——只有它走 `simulate_exit` 的 MA、能验头部 padding；纯 fwd_ret scheme 测不到这条。

思路（用 `force_recompute` 做基准对照，避免另造 scheme）：
```powershell
# 设 scheme=S（某 strategy_aware 命名标签展开值），区间 2023:2024
# 1) 增量路径：prepare S, 2023:2023  → 再 prepare S, 2023:2024（第二次增量只算 2024）
# 2) 导出增量结果（重叠区 2023 + 新增 2024 全量）：
docker exec crypto-postgres psql -U cryptouser -d cryptodb -A -F',' -c "
  SELECT trade_date,ts_code,value,exit_reason,hold_days FROM factors.labels
  WHERE scheme='S' AND trade_date BETWEEN '20230101' AND '20241231'
  ORDER BY trade_date,ts_code" > incr.csv
# 3) 基准路径：prepare S, 2023:2024 且勾选 force_recompute（整段重算覆盖）
# 4) 再次导出 → full.csv；逐行 diff：
#    Compare-Object (gc incr.csv) (gc full.csv)   # 应无差异
```
**通过标准**：`incr.csv` 与 `full.csv` **逐行逐值完全一致**（value/exit_reason/hold_days/行集合）。
**重点验头部 padding**：确认缺口起点落历史中段（前面有已物化）时，边界几日的 `exit_reason`（尤其 `ma5_break`）与整段算一致——这是设计里最容易错、被 spec self-review 抓出过的点（漏头部 padding 会让边界 label 不一致）。
feature_matrix 同理比 `features/label`（场景见 `06-testing-verification.md`）。

## 验证标准（全绿才算完成）
1. migration 应用成功、feature_sets 两列在。
2. 增量第二次备料 `skipped_dates` 可见、耗时显著少。
3. 训练能选已备 fs + 在覆盖区间内选 date_range 出模型；越界被拦。
4. **正确性逐行比对完全一致**（增量 == force 整段），头部 padding 边界一致。
5. python 全量单测仍绿（基线 ~900+；`cd apps/quant-pipeline; uv run pytest -q`）；server jest、web type-check + **vite build**（不只 type-check）绿。

## 硬约束 / 坑（接手必读）
- **头部 padding**：strategy_aware 缺口加载起点 `g0_load = max(date_range.start, g0 − (ma_window−1)交易日)`，`ma_window`=该 scheme ma_break 的 period。漏则违约束 1。详见 `02-incremental-algorithm.md` 与 memory。
- **alembic drift**：upgrade 前必先 `alembic current` 确认对齐 head（项目踩过 drift）。
- **重启**：改 worker/server 代码必重启（删 `__pycache__`）；前端 `.vue` 改动合并前必跑 `pnpm --filter @cryptotrading/web build`（vite），type-check 查不出 SFC 编译错。
- **缺口判定基准**用 `raw.trade_cal(is_open=1)`：trade_cal 有但 daily_quote 无行情的日子会被反复试算空缺口（A 股几乎不触发，已知可接受、勿为它加复杂度）。
- **日期选择器本地 TZ**：n-date-picker 提取日历日用 `getFullYear/getMonth/getDate`（禁 `getUTC*`，否则 CST 漂前 1 天）；date_range 发后端格式 `YYYYMMDD:YYYYMMDD`。

## 已知 Minor（非阻塞，按需补）
- P2：strategy_aware 中段缺口的"只 upsert [g0,g1]"缺直接断言（逻辑已对，代码有双过滤）。
- P3：缺"缺口中间洞"（labels 覆盖 {d1,d2,d4,d5} 缺 d3）的自动化测试；`skipped_dates` log 计数未含"缺口内缺 labels 跳过"的天（那些天已由 `features_missing_labels` warn 单独 log，非静默）。
- P5：prepare 的 `_validate_params` 用 model sentinel `"lgb-lambdarank"`（prepare 不需 model）；`test_prepare_runner` 缺纯字符串返回值兼容测试。
- S8：`quant-feature-sets.service.ts` 注释（tradingCalendar 为空时"永不断段" vs 实现"保守断段"）与实现不符，改注释。

## ⚠️ 并发会话遗留：定向更新前端
分支 `feat/quant-strategy-management` 同时承载**另一个会话的"因子/标签定向更新"工作**（后端 T1/T2 已提交；前端 `components/quant/targeted-update/` + `QuantJobsView.vue` 的"定向更新"按钮）。其前端原本 broken（缺 `auth`/`showTargetedUpdate` 声明），本次为让分支可编译**补了声明并连带提交**，但**未审查、未验证**。真机时一并确认"定向更新"功能是否正常，否则回退该部分。详见 memory `project_targeted_update_entry`。

## finishing-a-development-branch
真机验证全绿后，分支混了"增量物化 + 定向更新"两摊工作，需决定整合方式（合 main / 开 PR / 拆分）。建议用 `finishing-a-development-branch` skill 走结构化收尾。

## 注意事项
- 终端 Windows PowerShell；`uv run` / `docker exec` / `alembic` 可能需绕 sandbox。源文件一律 UTF-8。
- 行号以实际为准（本文件 commit 时点近似）；进硬断言/SQL 前自查实体或真 DB 一条（`.claude/rules/data-integrity.md`）。
