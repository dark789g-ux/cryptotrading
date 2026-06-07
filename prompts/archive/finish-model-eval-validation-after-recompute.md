# 任务交接：生产标签/特征重算后的「模型评估(H) + 验证收尾(I)」

> 本文是上一会话的完整交接。上一会话完成了 **bug5 修复 → 探查 → 决策门 → labels 重算(F) → feature_matrix 重建(G)**，全部已落库并核验。本文即「剩余全部任务」：**任务 H（模型评估/可选重训，含 promote 人工门）+ 任务 I（验证 + finishing 分支）**。
> **接手第一件事：按「当前状态快照」重查真 DB / git，别信任何可能过期的数字。**

## 一句话目标
labels + feature_matrix 已用修正后代码（bug1-5 全修）重算/重建并对齐口径。本任务：**评估校正对 prod 模型的影响（默认只评估、绝不盲换 prod）→ 验证（抽样停牌股/次新股边界、无幽灵行、行数对齐、全量 pytest）→ finishing 分支整合**。

## 这是什么任务的续作
- 前序交接 `prompts/finish-recompute-production-labels.md`（本会话已执行其 A~G）。
- 设计 spec：`docs/superpowers/specs/2026-06-06-recompute-production-labels-design/`（index 入口；04-recompute-and-cascade.md 阶段4 模型 / 05-validation-and-rollback.md = 任务 H/I 细节）。
- 记忆：`project_labels_features_incremental_prepare`（已更新到 bug5 + 重算状态）。

---

## 当前状态快照（2026-06-07，接手请重查）

### 分支 / 提交（`feat/quant-strategy-management`）
本会话已提交 2 个（bug5 修复 + 探查工具）：
```
33f1f2c test(quant-pipeline): 重算探查 Q1 头部缓冲 + trading_day helper + 8单测
1312a42 fix(quant-pipeline): labels 停牌股 MA 窗口依赖(bug5) 增量对齐 FULL  (含 runner 修复 + 任务A单测 + verify_bug5 回归锁)
```

### ★真 DB 现状（已重算完成，接手用 docker exec 复查）
```
factors.labels
  strategy-aware   4,234,258 行  20230103..20260515   (重算前 4,283,513，剔 49,255 幽灵行)
  fwd_ret_h1       2,523,275 行  20230103..20241231   (重算前 2,528,986，剔 5,711 幽灵行)
factors.feature_matrix
  fs_60bc257fb173  4,230,628 行  20230103..20260515   (strategy-aware；⊆ labels 少 3,630)
  fs_9b5ff4d69c1e  2,519,608 行  20230103..20241231   (fwd_ret_h1；⊆ labels 少 3,667)
```
复查命令：
```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT 'labels' t, scheme k, count(*), min(trade_date), max(trade_date) FROM factors.labels GROUP BY scheme UNION ALL SELECT 'fm', feature_set_id, count(*), min(trade_date), max(trade_date) FROM factors.feature_matrix GROUP BY feature_set_id ORDER BY k,t;"
```

### 模型（ml.model_runs，接手复查；本会话未动任何模型）
```
lgb-lambdarank-v1-20260521-seed42   fs_60bc257fb173   prod     有日评分(20260515..28)   ← live 底座
lgb-multiclass-v1-20260605-seed42   fs_9b5ff4d69c1e   shadow   无日评分
```
> **两个模型仍是用「重算前」的 feature_matrix 训练的**。本次校正后，feature_matrix 已就地更新（同 fs id），**但已训练好的模型权重未变**。下次推理会自动用新 fm 的特征（fs id 不变），但历史 scores_daily(20260515..28) 是旧特征算的。

---

## 已完成（A~G，本会话，全部已核验）

| 任务 | 结果 |
|---|---|
| A 修 bug5 | `runner._load_daily_quotes` 加 `head_rows_per_code`（LATERAL+索引补每股 g0_load 前 ma_window-1 个在场行）；commit 1312a42 |
| C 全量测试 | `uv run pytest -q` → 984 passed |
| D 探查 | **Q3 PASS**（drive==force 全 0，见 `apps/quant-pipeline/probe_q3.log`）；Q1 可信差异见 `docs/superpowers/specs/2026-06-06-recompute-production-labels-design/probe-report-20260607.md`（strategy-aware W1 幽灵 1.39%/value 0.32%/hold 0.35%；fwd 仅幽灵 0.69%、值全等）|
| E 决策门 | 用户批准**两个 scheme 都重算** |
| F labels 重算 | DELETE+月度重算（先 fwd 后 sa，`date_range.start 恒 20230103`、force=False 幂等）。结果见上表 |
| G feature_matrix 重建 | **fail-fast 护门**：fs_60bc257fb173 是**旧 hash 契约 + 默认 neutralize(industry_l1,mv)/robust_z(True)**（已用 180d180 版公式 hash 重构铁证）→ 用默认参数重建 + `resolve_feature_set_id` 复用回原 fs id；fs_9b5ff4d69c1e 新契约+默认。DELETE+月度重建，写回**原 fs id**。结果见上表 |

**重算正确性 spot-check（已验，可复现）**：停牌股 002499.SZ（停 20230203→20230324）在新 strategy-aware labels 里 20230328 = `value 0.014286 / ma5_break / hold_days 1`，**逐行等于 `verify_bug5_suspended_ma.py` 的 FULL 正确基线**（修复前是错误的 `0.0 / ma5_break / 2`）。证明生产标签的停牌股口径已被实际修正。

---

## ★剩余任务（有序执行）

### 任务 H：模型评估（默认）/ 可选重训 shadow —— **promote 是人工硬门**
spec `04-recompute-and-cascade.md#阶段4-模型` + `02-pipeline-and-gate.md`。要点：
- **默认只评估**：feature_matrix 已就地校正，可重新评估 prod 模型 `lgb-lambdarank-v1-20260521-seed42` 在新 fm 上的 oos_metrics，对比校正前后变化（Q1 差异 <1.5%，预计漂移小）。先查清楚评估入口（CLI / worker run_type / training 模块里的 eval/score 路径——**不要凭记忆，先 grep `oos_metrics` / `model_runs` / training runner**）。
- **可选重训**：若要让模型真正受益于校正，**只新增 shadow 模型**（新 model_run，status='shadow'），比 oos_metrics vs 现 prod，**由用户显式 promote**。
- **绝不盲换 prod**：`lgb-lambdarank` 是 live 日评分底座；`UPDATE ... status='prod'` / 下线旧 prod 属人工确认点，未经用户批准不得执行。
- 重训若涉及 train job：用 `ml.jobs` 的 train_e2e / 或现有训练入口；feature_set_id 不变（fs_60bc257fb173），date_range ⊆ R_F。

### 任务 I：验证 + finishing 分支
spec `05-validation-and-rollback.md`。
1. **数据完整性验证**（部分已做，接手复核）：
   - feature_matrix ⊆ labels（已 ✅：两 fs 各少 ~3.6k 行，正常 inner-join）。
   - 行数对齐、范围对齐（已 ✅，见快照）。
   - **抽样停牌股/次新股边界**：除 002499.SZ 外再抽几只长停牌票，确认新旧值差异符合 bug5 语义（增量==FULL）。可复用 `apps/quant-pipeline/tests/integration/verify_bug5_suspended_ma.py`（单股范式）。
   - 无幽灵行：`only_in_new=0` 已由 Q1 证；重算后 labels/fm 行数都减少（剔幽灵），无新增孤儿。
2. **全量 pytest 绿**：`cd apps/quant-pipeline; uv run pytest -q`（基线 984 passed）。
3. **决定运维脚本是否提交**（见下「工作区未提交」）。
4. **finishing-a-development-branch**：本分支 `feat/quant-strategy-management` 混了**增量物化 + 定向更新 + 本次重算治理**三摊事，需定整合方式（合 main / PR / 拆分）。触发 `finishing-a-development-branch` skill。
5. 更新记忆 `project_labels_features_incremental_prepare`（H/I 完成后）。

---

## 工作区未提交（接手处置）
- **运维驱动脚本（未跟踪，建议作为 runbook 工具提交，单独一个 commit）**：
  - `apps/quant-pipeline/tests/integration/run_recompute_labels.py`（labels 月度幂等重算，不含 DELETE）
  - `apps/quant-pipeline/tests/integration/run_recompute_features.py`（feature_matrix 月度幂等重建，含 `registry.ensure_loaded()` 预热、不含 DELETE）
  - 用户偏好分层 commit（记忆 `feedback_layered_commits`）。
- **临时日志（不要提交，可删 / 进 .gitignore）**：`apps/quant-pipeline/{probe_q3.log,probe_q1.log,recompute_fwd.log,recompute_sa.log,rebuild_fm_fwd.log,rebuild_fm_sa.log}`。
- **探查报告（未跟踪，按需提交）**：`docs/superpowers/specs/2026-06-06-recompute-production-labels-design/probe-report-20260607.md`（本次可信差异）、`probe-report-20260606.md`（首版，部分污染，可删）。
- **⚠️ 绝不 `git add uv.lock`**：含他人在途 torch/CUDA lock（非本任务）。
- 其它 `M`/`D`（CLAUDE.md、scripts/dev.mjs、删的/新增的 prompts/*.md、.claude/.../lessons-learned.md）：**都不是本任务改动，别动别提交。**

## 硬约束 / 坑（务必带走）
- **不假设、暴露权衡、用中文**（CLAUDE.md）。派 Explore subagent 显式传 `model: sonnet`。进硬断言/SQL 前自查实体或真 DB 一条（子代理/历史报告=二手）。
- **promote prod 模型 / DELETE prod = 人工硬门**，未经用户批准不自动越过。
- **docker exec 多 `-c` 在 Windows 会卡客户端**（DELETE 已提交但 verify SELECT 卡住、进程挂 5min+）：**DELETE 用单 `-c`，验证另起一条**。
- 运维脚本调用：`cd apps/quant-pipeline; $env:PYTHONPATH="."; uv run python tests/integration/xxx.py ...`（脚本 `from tests.integration...` 需 PYTHONPATH=.）。**CLI 跑 feature 构建前必须 `registry.ensure_loaded()`**（否则 `FactorMetaMissing`；`run_recompute_features.py` 已内置）。`uv`/`docker` 可能需 `dangerouslyDisableSandbox`。
- **长任务用 Bash `run_in_background`**（harness 按真实退出码回调），**别用 `nohup &`**（会 detach 失控——上会话踩过：误把 wrapper exit 0 当完成、抢跑并发任务，靠落盘日志/退出码才纠正）。**以落盘日志 + 退出码为准，不采信滚动文本**。
- 终端 Windows PowerShell（禁 `&&`，用 `;`）；源文件 UTF-8；文件 I/O 显式 `encoding='utf-8'`。
- PowerShell/Bash 工作目录跨调用可能漂移：用绝对路径或在命令内 `cd`；`$env:PYTHONPATH` 每次重设。

## 参考文件位置
- spec：`docs/superpowers/specs/2026-06-06-recompute-production-labels-design/`（index.md 入口；04 阶段4 模型 / 05 验证回滚）
- bug5 回归锁：`apps/quant-pipeline/tests/integration/verify_bug5_suspended_ma.py`（单股 INCR+head==FULL、无 head 复现 bug）
- 重算驱动：`apps/quant-pipeline/tests/integration/{run_recompute_labels.py,run_recompute_features.py}`
- 探查工具：`apps/quant-pipeline/tests/integration/{probe_recompute_diff.py,_recompute_helpers.py}`（monthly_drive / diff_labels）
- 关键源码：`features/runner.py:build_feature_matrix`（resolve 复用 + overlay + force_recompute）、`features/builder.py:build_feature_set_id`（hash 契约，旧版见 git 180d180）、`labels/runner.py`（compute_labels / _load_daily_quotes head_rows_per_code）、`factors/registry.py:ensure_loaded`
- 探查报告：`docs/superpowers/specs/2026-06-06-recompute-production-labels-design/probe-report-20260607.md`
