# 任务交接：排查 worker 各 run_type 入口的「首次真实调用」初始化缺口（factor 注册表预热为主）

## 一句话目标
刚修的 `b17316b`（`factors/runner.py::runner_entrypoint` 漏 `ensure_loaded()` → 全新 worker 跑 `run_type=factors` 抛 `FactorMetaMissing`）暴露了一类系统性隐患：**某条 worker run_type 路径过去只被间接调用（registry 已被别人预热），从没作为「首个真实调用方」独立跑过，于是入口漏了进程级初始化、潜伏到第一次被独立触发才炸。** 本任务：**系统排查 `worker/dispatcher.py` 全部 run_type 入口**，找出还有哪些入口需要 factor 注册表（或其它进程级 init）却没自己 ensure，逐个坐实「是否真会被独立触发」+「触发时是否已被预热」，补齐缺口 + 回归测试。

## 这是什么任务的背景
前序会话做「因子/标签定向更新入口」(B) 收尾，真机 e2e 时发现：`run_type=factors` 是定向更新带来的**首个真实调用方**（因子以前都在 `prepare` 内算，`prepare_runner` 自己 `reload_from_db`；CLI `quant factors` 也早 `ensure_loaded()`）。该 worker 入口从没被独立跑过 → `_meta_cache` 空 → `Factor.__init__` 抛 `factor meta missing in cache`。已修（入口加 `ensure_loaded()` + 回归测试），见 commit `b17316b`、归档交接 `prompts/archive/finish-targeted-factor-label-update.md`。

**本任务怀疑同一模式还潜伏在别的入口**——尤其 `features`。

---

## 先读（机制）
- `registry.ensure_loaded()`（`src/quant_pipeline/factors/registry.py:365`）= `import_all_factors()`（注册 @factor 类）+ `reload_from_db()`（清空+从 `factors.factor_definitions` 重填 `_meta_cache`，末尾 `_validate_class_db_consistency()`）。**幂等预热入口**，docstring 明写「抽出 helper 统一调用点，避免新增入口又漏掉」。
- `_meta_cache`（`registry.py:71`）：`Factor.__init__` 读它取 meta；缺失则 `base.py:62` 抛 `FactorMetaMissing`（错误文案：`factor meta missing in cache: ... did you forget to call registry.load_from_db()?`）。
- 谁**会**实例化 Factor / 读 `_meta_cache`：凡调用 `list_factors()` / `list_active()` / `get_factor()` 的路径（`get_factor_class()` 只取类、**不**碰 `_meta_cache`，是例外，见 `registry.py:155`）。

## 现状摸底（file:line 为证，本会话亲查）

### dispatcher 路由表（入口清单的唯一真相源）
`src/quant_pipeline/worker/dispatcher.py` 的 `_ROUTES`（约 `:363-369`）覆盖：`noop / sync / quality / factors / labels / features / prepare / train / infer / optuna / seed_avg / monitor`。每个 run_type → 一个 `_runner_xxx(job)` → 各自 `runner_entrypoint`。

### 各入口「是否预热 factor 注册表」现状
| run_type 入口 | 文件:行 | 是否预热 | 备注 |
|---|---|---|---|
| **factors** | `factors/runner.py::runner_entrypoint` | ✅ 已修 (`b17316b`) | 入口加了 `ensure_loaded()`（参数校验后/`run_factors` 前） |
| **prepare** | `worker/prepare_runner.py:685` | ✅ `reload_from_db()` | 模板：try/except → `RuntimeError("factor_definitions unreachable")` |
| CLI `quant factors` | `cli.py:478` | ✅ `ensure_loaded()` | factors 入口的姊妹，对照样板 |
| **features** | `features/runner.py:852 runner_entrypoint` | ❌ **无预热** | ⚠️ 头号嫌疑：`features/runner.py:84` 注释「依赖调用方（**train_e2e_runner**）已 reload_from_db」——**train_e2e 已删**。需查 features 是否会独立触发 + 是否真碰 `_meta_cache` |
| **train** | `training/runner.py:513` | ❌ 无预热 | 消费已建好的 `feature_matrix`，**大概率不碰** factor 注册表——须逐行坐实 |
| **infer** | `inference/runner.py:348` | ❌ 无预热 | 同上，须坐实（但 infer 另有 factor_code_fp 护门读 fm，路径不同） |
| **optuna** | `training/tuning.py:691` | ❌ 无预热 | 同 train |
| **seed_avg** | `training/seed_averaging.py:400` | ❌ 无预热 | 同 train |
| **monitor** | `quality/monitor.py:387` | ❌ 无预热 | 须坐实是否碰注册表 |

> 「无预热」≠「有 bug」：train/optuna/seed_avg/infer 消费 feature_matrix（已物化特征），**多半不实例化 Factor**，所以不需要预热。**关键是逐个坐实「该入口路径上有没有 `list_factors/list_active/get_factor` 或别的 `_meta_cache` 读取」**，有才需补。

---

## 已定方向 + 开放问题（暴露权衡，别假设）

### 方向（建议）
1. **枚举真实触发面**：`_ROUTES` 里每个 run_type，查它**实际会不会被独立触发**——前端按钮（`apps/web` grep `run_type:`/`createJob`）、cron（`CronList` / NestJS 定时任务）、API。只被 `prepare` 等内部串联调用、永不独立入队的，风险低（但仍要确认串联调用方已预热）。
2. **逐入口判定是否需要注册表**：对每个 entrypoint 路径，grep 是否（直接或间接）调 `list_factors/list_active/get_factor` 或读 `_meta_cache`。需要 + 没预热 + 会被独立触发 = 真缺口。
3. **补齐**：缺口入口按 `factors/runner.py`（`b17316b`）/ `prepare_runner.py:685` 的样板加 `ensure_loaded()`（幂等，重复调零副作用），每补一个加一条「入口预热」回归测试（参考 `tests/unit/test_factors_runner.py::test_runner_entrypoint_preheats_registry_before_run_factors`）。
4. **考虑根治**：是否该把预热**上移到 worker 启动期**（`worker/loop.py` worker_started 时一次 `ensure_loaded()`），让所有入口免疫？权衡：① 启动期预热对「跑完一个 job 后 factor_definitions 被 UI 改了」的新鲜度不如 per-job `reload_from_db`；② 但 per-entry `ensure_loaded` 每个 job 都重拉一次 DB（prepare 已经这么做）。**与用户/架构权衡**：启动期一次 + 关键入口 per-job reload，还是统一某一种。别单方面定。

### 开放问题（需坐实，别猜）
- **features 能独立触发吗？** `prepare`（labels→features 串联）走的是 `prepare_runner.run_prepare`（已 `reload_from_db`），**还是**会把 `features` 单独入队走 `features/runner.py::runner_entrypoint`？若后者且该路径碰注册表 → 与 factors 同款 bug。**这是最高优先验证项。**
- features/runner.py 那条引用已删的 `train_e2e_runner` 的注释（`:84`）是否说明 features 的独立预热责任**已随 train_e2e 删除而悬空**？
- train/infer/optuna/seed_avg/monitor 路径里到底有没有 Factor 实例化？（大概率没有，但要 grep 坐实，不凭「消费 feature_matrix 就一定不碰」假设。）

---

## 硬约束 / 坑（务必带走）
- **不假设、暴露权衡、用中文**（CLAUDE.md）。多解读都列出。
- **进硬断言/SQL 前自查实体或真 DB 一条**（`.claude/rules/data-integrity.md`）；**子代理/摸底报告 = 二手，不得直接进硬断言**——本交接表里的 file:line 也请落代码复核再用。
- **Python runner 改动必删 `__pycache__` 重启 worker**才生效（CLAUDE.md）：`Get-ChildItem -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force` 后 `uv run quant worker run`。
- **提交纪律**：分支 `feat/quant-strategy-management` 有大量并发在途改动，任何提交**只 `git add <精确路径>`，禁 `git add -A/.`**；提交前 `git log --oneline -5` 看 HEAD 有没有被并发推进。
- **TDD**：先写「入口预热」失败测试（红）→ 补 `ensure_loaded()`（绿）→ 跑全量 `uv run pytest tests/unit -q`（基线本会话 **959 passed**）。
- 终端 Windows PowerShell（禁 `&&` 用 `;`）；源文件 UTF-8；`git commit -m` 中文消息走单引号 here-string `@'...'@`，消息里别放 ASCII 双引号。
- 真机验证某入口需起 worker + 该 run_type 的真实 job；factors/labels 的 e2e 驱动法见归档交接 + `browser-driving`/`kimi-webbridge` skill（设组件 exposed ref + fetch 录制 wire body）。

## 验证标准
- 每个判定「需要预热」的入口：① 有红→绿回归测试锁 `ensure_loaded` 在实际工作前被调；② 真机起 worker 提一个该 run_type 的真实 job 跑到 `success`（不是 `FactorMetaMissing`）。
- 全量 `uv run pytest tests/unit -q` 全绿（≥959）。
- 若选「worker 启动期统一预热」方案：worker 启动日志出现 `factor_meta_loaded_from_db`，且各入口去掉/保留预热的决定有测试覆盖。
- 验证全绿前别说「完成」（`verification-before-completion`）。

## 参考文件位置
- 范例修复：commit `b17316b`（`factors/runner.py::runner_entrypoint` + `tests/unit/test_factors_runner.py`）。
- 预热机制：`src/quant_pipeline/factors/registry.py`（`ensure_loaded:365` / `reload_from_db:287` / `load_from_db:234` / `_meta_cache:71` / `get_factor_class:155`）、`factors/base.py:62`（FactorMetaMissing）。
- 入口清单：`src/quant_pipeline/worker/dispatcher.py`（`_ROUTES` ~`:363`）。
- 样板调用方：`worker/prepare_runner.py:685`、`cli.py:478`。
- 头号嫌疑：`src/quant_pipeline/features/runner.py`（`:84` 悬空注释、`:852` runner_entrypoint）。
- 归档前序交接（定向更新 B + e2e + 本 bug 发现经过）：`prompts/archive/finish-targeted-factor-label-update.md`。

## 注意事项
- 接手第一步：`git -C C:\codes\cryptotrading log --oneline -10` + `git status --short` 确认 HEAD/工作区（分支并发在动）。
- 本任务**纯排查 + 按需补缺口**，不碰定向更新（B 已收尾合规）。若排查下来其余入口都不需要预热（只 factors/features 这条），如实结论即可，不必为补而补。
