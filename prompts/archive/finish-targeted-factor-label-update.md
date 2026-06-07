# 任务交接：因子/标签「定向更新」入口 —— 收尾（补单测 + 重验 + e2e + finishing）

## 一句话目标
「因子/标签定向更新入口」功能的 **T1/T2/T3 三个任务已全部提交**（功能在），但 SDD 闭环没走完。本任务：**补 T3 前端缺失的单测、重跑静态验证（分支已推进需重验）、真机 e2e、并核对与并发工作的交叉**，最后走 `finishing-a-development-branch`。**不要重做已完成的 T1/T2/T3 实现。**

## 这是什么任务的续作
前序会话用 `/brainstorming` 敲定设计 → `subagent-driven-development` 拆 T1(后端)/T2(Python)/T3(前端) 并行实施。T1/T2 由前序会话提交、各自单测过；T3 前端前序会话因**会话用量上限**中断，后由**并发会话**补到能编译并提交。SDD 的 reviewer 复审、最终 review、真机 e2e、finishing 当时都没做。

## 先读
- spec：`docs/superpowers/specs/2026-06-06-quant-targeted-factor-label-update-design.md`（§11 任务拆分 T1-T4；§8 校验与约束；§5/§6 后端/Python 契约）。
- 记忆：`project_targeted_update_entry`（本功能进度）、`project_labels_features_incremental_prepare`、`project_label_management`、`project_close_adj_skew_label_gain_crash`。
- **姊妹交接文档** `prompts/fix-labels-incremental-window-invariance.md` 第 130-148 行 —— 并发的"增量物化/备料"任务，其中**已记录对本功能（定向更新）做过的静态验证与前端审查结论**（见下「当前状态」），且 finishing 部分把本分支 4 摊交织工作一并列了。
- SDD reviewer 模板：`.claude/skills/subagent-driven-development/reviewer-prompt.md`。

---

## 当前状态（接手必读，均本会话亲查 git/源码坐实）

### 三个任务都已进 git（分支 `feat/quant-strategy-management`）
| 任务 | commit | 内容 | 自带测试 |
|---|---|---|---|
| **T1 后端** | `5f2706b` | `validateCreateJob` 对 `run_type=labels` 要求 `scheme`/`label_ref`/(`strategy_id`+`strategy_version`) 三选一全缺则 400 + 修正 labelRef 误导注释 | ✅ create-job.dto.spec.ts 14 例过 |
| **T2 Python** | `80e2949` | `labels/runner.py::runner_entrypoint` 新增从 `expandForTraining` 注入的 `base_type`/`base_params` 经 `base_scheme_codec` 解析 scheme（优先级 scheme > top-level strategy > base_type/base_params） | ✅ test_labels_runner.py 15 例过 |
| **T3 前端** | `e47fe43`（并发会话提交） | `components/quant/targeted-update/` 三组件 + `QuantJobsView.vue` 接线 | ❌ **无任何单测** |

### T3 接线已确认（`QuantJobsView.vue`）
- 「定向更新」按钮 → `showTargetedUpdate=true`（~line 34-35）；`<QuantTargetedUpdateModal v-model:show=...>`（~line 65）；import（~line 86）、ref（~line 111）。
- 并发会话还另加了**独立的「备料」按钮 + `PrepareModal`**（属增量物化任务，与本功能并存、不冲突）。
- 三组件行数均 < 500（Modal 214 / FactorSelect 133 / LabelSelect 134，提交时计）。

### 并发会话已替本功能做过（但分支之后又推进，需重验）
据姊妹交接文档第 132-133 行：
- **静态验证全套**当时全绿：web type-check ✅ / vite build ✅ / lint:quant-lines ✅ / vitest ✅146 / server jest ✅ / pytest 936→937。**但 vitest 146 不含 targeted-update 专属测试**（该目录无测试文件）。
- **定向更新前端审查**（并发 agent 审过）：✅「可用可合」—— 前端 payload ↔ `create-job.dto` ↔ T1/T2 runner 逐字对齐、admin-only 前后端一致、TZ 用 `getFullYear` 正确、行数 ≤500。**2 个非阻断小瑕疵**：
  - **S1**：因子+标签都选时双 job 提交，前端只跳转/聚焦最后一个 job。
  - **S2**：两条 job 串行提交，无补偿（第 2 条失败时第 1 条已发）。
- ⚠️ **重要**：上述验证是并发会话某时点跑的，**之后分支又落了多笔**（close_adj 错配修复、label_gain 截面分位分桶、**factor_code_fp 因子代码指纹护门**等）。**本任务必须重跑静态验证**，不能直接采信旧绿。

### 工作区现状
当前工作区**无任何定向更新相关未提交文件**（T1/T2/T3 都已提交）。只剩 ambient 改动（`CLAUDE.md`、`uv.lock`、`scripts/dev.mjs`、`prompts/*` 增删、`.claude/scheduled_tasks.lock` 等），与本任务无关，**别动、别一起提交**。

---

## 本会话进度（2026-06-07，接手会话更新）

**代码侧已全部完成并提交**（分支 `feat/quant-strategy-management`，提交时 HEAD 已被并发推进到 `6233560`，本会话叠在其上）：
- ✅ **任务 1（T3 补单测）** → commit `da3f9d2`：`components/quant/__tests__/QuantTargetedUpdateModal.spec.ts`，8 例覆盖 §8 全部校验 + S1/S2。
- ✅ **任务 2（重跑静态验证）**：type-check / lint:quant-lines(Modal 232<500) / vitest 154 / server jest create-job.dto 40 / pytest test_labels_runner.py 36 / **vite build** 全绿。
- ✅ **任务 3（S1/S2 轻量修）** → commit `d51a8a1`：双 job 报「已提交 N 条」+ 高亮首个(因子)job；标签失败时提示因子已提交。
- ✅ **并发交叉核对**：① T1 真正同域的是 `d39c276`（非 `425365d`——后者纯 Python `training/runner.py`，**没碰** create-job.dto.ts）。d39c276 把 `labels` 收进 `LABEL_REF_RUN_TYPES` 硬要求 label_ref，使 T1 的「三选一」块成**良性死代码**（到达时 hasLabelRef 恒真），是 d39c276 按 spec 03-backend-decoupling 的有意收紧、40 测锁定，**对本功能 B 无影响**（定向更新 labels job 必带 label_ref）。② factor_code_fp 护门只接入 features/training/inference runner，`factors/` 目录零指纹引用，**与定向更新 factors 重算正交、不会误拦**（e2e 再跑一次坐实运行时）。

- ✅ **真机 e2e 全过**（commit `b17316b` 修了暴露的 bug）：三场景 wire payload 全对 + 日期无漂 + 未闭合提示渲染 + DB 落表且 feature_matrix/feature_sets 不动。**e2e 暴露并修复**：factors worker 入口漏 `ensure_loaded()`（「定向更新」是 `run_type=factors` 首个真实调用方→FactorMetaMissing），959 unit 全绿。

**剩下只有 finishing**（见下「未完成清单」6，e2e 已过，与用户定整合）。任务 4（reviewer 复审）T1 已借交叉核对深查，T2 单测过、风险低，按需可补。

> 本会话 4 提交（叠在并发 `6233560` 上）：`d51a8a1` fix(web) S1/S2、`da3f9d2` test(web) 单测、`b17316b` fix(quant-pipeline) factors 注册表预热。worker 本会话临时起、验完已停（需自行 `uv run quant worker run`）。

---

## 未完成清单（按优先级）

### 1. T3 前端补单测（TDD 缺口，**必做**）—— ✅ 已完成（commit `da3f9d2`）
`targeted-update/` 零测试。按 spec §8 校验规则补 vitest（参考 web 既有 `*.spec.ts` 约定，mock HTTP 断言 payload）：
- 因子和标签都没选 → 提交禁用 / 不发请求。
- 只选因子 → 只发 1 条 `factors` job，body 含**非空** `factor_ids`、正确 `date_range`、`version`。
- 只选标签 → 只发 1 条 `labels` job，body 含 `label_ref`、`date_range`，**不含** `scheme`。
- 两者都选 → 发 2 条请求。
- 日期：选定日期正确转 `YYYYMMDD:YYYYMMDD`，**用本地日历日不漂移**（CST 下 `getFullYear/getMonth/getDate`，非 UTC）。
- ⚠️ **factor_ids 绝不发空数组**（后端 Python `run_factors` 把空数组当"全量 16 因子"，`factors/runner.py` `list(factor_ids) if factor_ids else None`）。

### 2. 重跑静态验证（分支已推进，**必做**）—— ✅ 已完成（全绿，含 vite build）
```powershell
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web lint:quant-lines
pnpm --filter @cryptotrading/web test           # 含新补的 targeted-update 测试
pnpm --filter @cryptotrading/server exec jest create-job.dto   # T1
cd apps/quant-pipeline; uv run pytest tests/unit/test_labels_runner.py   # T2
```
全绿才算。改动后受影响部分重验。

### 3. （可选）修 S1/S2 小瑕疵 —— ✅ 已完成（commit `d51a8a1`，用户确认轻量修）
非阻断。S1（双 job 只跳最后一个）可改成提示"已提交 N 条任务"并跳列表；S2（串行无补偿）可在第 2 条失败时提示第 1 条已发。**先读 `QuantTargetedUpdateModal.vue` 提交逻辑坐实再决定是否值得改**，与用户确认。

### 4. （可补）SDD reviewer 复审 T1/T2
前端已被并发 agent 审过；T1（后端）/T2（Python）的"独立 reviewer 一次审 spec 合规 + 代码质量"没正式做。可按 `reviewer-prompt.md` 各派一个审查者（给任务全文 + 改动文件 + spec 摘录）。其单测都过、风险低，按需补。

### 5. 真机 e2e（**需用户配合**：重启 server + 起 worker）—— ✅ 已完成（2026-06-07，暴露并修 factors 注册表预热 bug `b17316b`）

> e2e 结论：三场景 wire payload 全对（只因子 1 条/只标签 1 条 params 无 scheme/都选 2 条 + S1 toast）、日期无漂移、未闭合提示渲染（需先展开默认折叠的「命名标签」区）、labels job success、daily_factors 落表、feature_matrix/feature_sets 不动。**暴露潜伏 bug**：`factors/runner.py::runner_entrypoint` 漏 `ensure_loaded()`，全新 worker 跑 `run_type=factors`→FactorMetaMissing（「定向更新」是该 run_type 首个真实调用方）；已修+回归测试（与 factor_code_fp 护门无关，护门未拦）。
- 前置：`nest start` 无热加载 → **重启 server**（:3000）；**worker 必须在跑**（`cd apps/quant-pipeline; uv run quant worker run`，姊妹文档提示可能无 worker 在跑）；web :5173。
- 用 **admin 账号** 打开 `/quant/jobs`，点「定向更新」：
  - 只选因子 → 只发 1 条 `factors` job；只选标签 → 1 条 `labels` job；都选 → 2 条。
  - 日期不漂（选 20260509 实际就是 20260509）。
  - 落表：`factors.daily_factors` / `factors.labels` 被 upsert，**特征矩阵 `feature_set` 不动**。
  - 标签近端日期未闭合提示文案是否出现（strategy-aware 只能闭合到 ~T-30）。
- 抽查：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "..."` 看目标日期、目标 factor_id/scheme 的行确被更新（`updated`/行数）。

### 6. finishing（**与用户定，跨分支协调**）
分支 `feat/quant-strategy-management` 已是**多摊交织工作**（姊妹文档第 139-144 行列了 A 增量物化 / B 本功能定向更新 / C 策略管理 / D close_adj，本会话又见 close_adj_skew/label_gain/factor_code_fp 等更多笔），深度互依、难拆。走 `finishing-a-development-branch`，与用户定整合方式（合 main / PR / 是否拆分），并明确**本任务范围只到 B（定向更新）收尾**，A/C/D 等由其它会话负责、不在本任务验证范围。

---

## 并发交叉要核对（暴露权衡，别假设）—— ✅ 静态部分已核完（结论见上「本会话进度」；e2e 时再坐实 factor_code_fp 运行时正交）
- **T1 与并发 `425365d`「三训练类入口 fail-fast」同域**：两者都动 `create-job.dto.ts` / run_type 契约。T1 是叠在 425365d 之上做的（当时测试过），但**意图是否重叠/重复**没眼校 —— 复审 T1 时顺带 `git show 425365d -- apps/server/src/modules/quant/dto/create-job.dto.ts` 比对，确认 labels 校验与训练类 fail-fast 不打架、不冗余。
- **factor_code_fp 因子代码指纹护门（并发 `39f7ffa`，problem2）**：它拦"因子计算代码 vs 已物化指纹漂移"。定向更新的 factors job 是**按需重算单个 factor_id** —— e2e 时确认重算不会被指纹护门误拦/或确认行为符合预期（大概率正交，但要亲验一次，别假设）。

---

## 硬约束 / 坑（务必带走）
- **不假设、暴露权衡、用中文**（CLAUDE.md）。多解读都列出，不悄悄选一个。
- **进硬断言/SQL 前自查实体或真 DB 一条**（`.claude/rules/data-integrity.md`）；**子代理报告 = 二手，不得直接进硬断言**。
- **提交纪律**：工作区有 ambient/并发在途改动，任何提交**只暂存自己文件**（`git add <精确路径>`，禁 `git add -A/.`）。本分支有并发会话在动，提交前 `git log --oneline -5` 看 HEAD 有没有被推进。
- **factor_ids 空数组 = 全量重算**：前端绝不发空数组。
- **naive-ui `n-date-picker` daterange 是本地午夜 ms**：日历日用 `getFullYear/getMonth/getDate`（**禁 UTC 方法**，否则 CST 漂前 1 天）。
- **Vue 单文件 ≤500 行**（`lint:quant-lines` CI 强制 quant 目录）。
- **后端 `nest start` 无热加载**：改 `apps/server` 必重启 server；改 worker/runner 代码删 `__pycache__` 重启 worker。
- **标签闭合窗口**：date_range 是入场日 T；strategy-aware/fwd_ret 出场要 T 之后 ~20 交易日未来数据，近端日期标签未闭合（spec §8 约束 1）。
- 终端 Windows PowerShell（禁 `&&` 用 `;`）；终端 GBK 但**所有源文件 UTF-8**。
- `git commit -m` 的中文消息走单引号 here-string `@'...'@`（`'@` 顶格），**消息里别放 ASCII 双引号**（PS 5.1 传 native git 会拆参数，本系列踩过）。
- 派 Explore 子代理显式传 `model: sonnet`（CLAUDE.md）。

## 参考文件位置
- spec：`docs/superpowers/specs/2026-06-06-quant-targeted-factor-label-update-design.md`
- T1：`apps/server/src/modules/quant/dto/create-job.dto.ts`（`validateCreateJob` 的 labels 校验块）+ `dto/__tests__/create-job.dto.spec.ts`
- T2：`apps/quant-pipeline/src/quant_pipeline/labels/runner.py`（`runner_entrypoint`）+ `tests/unit/test_labels_runner.py`；codec 在 `labels/dir3_scheme.py::base_scheme_codec`
- T3：`apps/web/src/components/quant/targeted-update/{QuantTargetedUpdateModal,TargetedFactorSelect,TargetedLabelSelect}.vue` + `views/quant/QuantJobsView.vue`
- 后端展开逻辑（已可用，无需改）：`apps/server/src/modules/quant/services/quant-jobs.service.ts::create()`（凭 `dto.labelRef` 展开）+ `labels/labels.service.ts::expandForTraining`
- 姊妹交接（并发任务 + finishing 协调）：`prompts/fix-labels-incremental-window-invariance.md`

## 注意事项
- 接手第一步：`git -C C:\codes\cryptotrading log --oneline -10` + `git status --short` 确认 HEAD 与工作区现状（分支并发在动，可能又变）。
- 验证全绿前别说"完成"（`verification-before-completion`）；reviewer 发现 spec 缺口 = 没做完。
