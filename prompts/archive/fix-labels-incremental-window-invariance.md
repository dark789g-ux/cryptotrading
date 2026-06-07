# 任务：修复 labels 增量物化的窗口依赖缺陷（约束 1 逐行等价）

## 一句话目标
labels 增量物化（`compute_labels` force_recompute=False）与"整段重算"（force=True）**目前逐行不一致**，违反 spec 约束 1。真机正确性比对已定位 **4 处根因**（bug1 已修，bug2/3/4 待修）。本任务：用**窗口无关化**修 bug2/3/4，重跑正确性脚本确认 INCR==FULL，再续做真机 e2e 与 finishing。**「边界带重算」方案已评估否决（见下），不要走那条路。**

## 这是什么任务的续作
前序任务 `prompts/verify-and-finish-labels-features-incremental-prepare.md`（labels/features 增量物化 + 备料/训练解耦的真机验证与收尾）。验证阶段做正确性逐行比对时，发现增量结果与整段重算**不一致**，深挖出 4 处根因。前序任务的其余部分（migration、静态验证、定向更新审查）已完成，状态见末尾「前序进度」。

## 先读
- spec：`docs/superpowers/specs/2026-06-06-labels-features-incremental-prepare-design/02-incremental-algorithm.md`（正确性红线；**它的等价性证明漏了"窗口依赖"这一类**，本任务应同步修订该文档）。
- 记忆：`project_labels_features_incremental_prepare`、`project_alembic_drift`。
- 本会话写的正确性比对脚本：`apps/quant-pipeline/tests/integration/verify_incremental_correctness.py`（`verify_` 前缀，pytest 不收集；手动 `uv run python` 跑）。

---

## 当前工作区状态（接手必读）

### 本会话已改未提交（属本任务，保留）
- `apps/quant-pipeline/src/quant_pipeline/labels/runner.py` —— **bug1 已修**：`_compute_end_padded`/`_compute_g0_load` 的 trade_cal 查询补了 `exchange = 'SSE'`（+ docstring）。**已实测生效**（`end_padded(20230331)` 由错误的 20230424 → 正确 20230518）。
- `apps/quant-pipeline/tests/integration/test_factors_runner_pg.py` —— 顺手修了**预存的测试裂缝**：`test_run_factors_smoke_2day_window` 直调 `run_factors` 未预热 meta cache（预热职责已上移 CLI），加了 `ensure_loaded()`。与本任务无关、纯测试侧，独立跑已过。
- `apps/server/src/modules/quant/feature-sets/quant-feature-sets.service.ts` —— Minor S8：改了 `splitIntoCoverageSegments` 的注释（tradingCalendar 为空时实为"每日各自断段"而非旧注释说的"永不断段"）。纯注释。
- `apps/quant-pipeline/tests/integration/verify_incremental_correctness.py` —— **新增**，本任务核心验证脚本。

### 非本任务的遗留改动（别动、别一起提交）
`CLAUDE.md`、`.claude/skills/browser-driving/references/lessons-learned.md`、`apps/quant-pipeline/uv.lock`、`scripts/dev.mjs`、`prompts/README.md`(删)、`prompts/smoke-lgb-multiclass.md`(删)、`prompts/*.md`(其它) —— 进入会话前就在工作区，来源不明，与本任务无关。

### DB 残留（需清理）
正确性脚本 FAIL 时保留了两个 test scheme 供排查，现仍在库里，**修完验证通过后清理**：
```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "DELETE FROM factors.labels WHERE scheme IN ('strategy-aware__incrtest','strategy-aware__fulltest')"
```

### migration 状态
alembic 已 `upgrade head`（`current=20260606_0003`），`factors.feature_sets` 已加 `label_id`/`label_version` 两列。**无需再动 migration**（无 drift）。

---

## 核心发现：约束 1 不成立的 4 处根因（全部亲查 DB/源码坐实，非二手）

根因都是同一类病：**某些计算依赖"加载窗口"，而增量 chunk 的加载窗口（`[g0_load, end_padded]`）与整段重算的窗口（`[date_range.start, ...]`）不同 → 结果分歧。** 治本＝把这些计算改成**窗口无关**。

| # | 问题 | 机制（证据） | 状态 |
|---|------|-------------|------|
| **1** | `_compute_end_padded`/`_compute_g0_load` 查 `raw.trade_cal` **漏 `exchange='SSE'`** | trade_cal 每日历日有多交易所行，`LIMIT n` 实回 ~n/2 个不同日期 → 尾部 padding +15td(应+30)、头部 2td(应4)。实测 `end_padded(20230331)`=20230424(错) | ✅ **已修**（labels/runner.py），实测 →20230518 |
| **2** | `_load_stk_limit(g0_load, **g1**)` 只到 g1 | signal=g1 的 buy_date=next_day(g1)**>g1**；涨停过滤要 buy_date 当天 stk_limit，INCR 没加载到 → 漏剔涨停入场。**实证**：000021.SZ 20230403 close=18.39=up_limit(涨停)，FULL 剔、INCR① 留（20230331 共 46 行） | ⏳ 待修 |
| **3** | `filter_new_listing` 用**加载窗口** `trade_dates_sorted` 算"上市后第N交易日" | 增量 chunk 从 g0_load 起、不含次新股 list_date → `list_idx=NaN`→漏剔；FULL 从更早起→正确剔。**实证**：4 月 only_in_INCR 股(301345/603065/301378…) list_date 全是 20230301-0321（3月次新）。每个4月日 ~28 行泄漏 | ⏳ 待修 |
| **4** | pandas `rolling().mean()` **流式累加、结果依赖序列起点** | INCR②(从0328,53行) vs FULL(从0301,72行) 同位置 MA5 差 1 ULP（78.67645 vs 78.67645000000002）；价格极平时 `MABreakRule` 严格 `close<ma5` 翻转出场。**实证**：600157.SH 20230403 INCR ma5_break day10 vs FULL day2（同 reason 异日）。130 value + 148 hold_days 行(~0.06%) | ⏳ 待修 |

bug1 修复后：最大头的"3 月末 force_close 截断分歧"已消除，`exit_reason` 已 212216 行全一致；残留全在 bug2/3/4。

### 关键代码位置（行号以实际为准，可能因 bug1 修改微移）
- bug2：`apps/quant-pipeline/src/quant_pipeline/labels/runner.py` ~`line 495` `stk_limit = _load_stk_limit(g0_load, g1)`（在 `compute_labels` 的缺口循环里）。
- bug3：`apps/quant-pipeline/src/quant_pipeline/labels/strategy_aware.py` `filter_new_listing`(~line 178) + `compute_strategy_aware_labels` 里 `trade_dates_sorted = sorted(quotes[...].unique())`(~line 381) 与 `filter_new_listing(..., trade_dates_sorted=trade_dates_sorted, ...)`(~line 429) 的调用。
- bug4：`apps/quant-pipeline/src/quant_pipeline/strategy/exit_rules.py` `_ensure_ma`(~line 401-415，`rolling(window, min_periods=window).mean()`)；调用点在 `simulate_exit`(~line 501) —— 注意当前是**每个入场都重算一次 MA**。

---

## 「边界带重算」方案评估 —— 已否决

**方案**：增量扩展时除算缺口外，在 chunk 接缝处回算一段固定宽度边界带，试图对齐整段重算。

**逐根因结论：治标不治本，对 bug2/3/4 都无效。**
- **Bug4（浮点 MA）**：MA(t) 浮点值依赖 rolling 序列**起点**到 t 的全部累加路径。边界带从 `g0-band` 加载 → 起点≠整段的 `start` → 累加路径不同 → 末位仍可能不同 → close≈ma5 仍翻转。除非 band 一路回到 `start`（=退化为整段重算、失去增量意义），否则逐位等价不可达。
- **Bug3（new_listing 日历）**：各股 list_date 不同、可早至窗口前数月，固定 band 覆盖不全；且 FULL 自身也只能剔 ≥start 的次新（同样窗口依赖）。
- **Bug2（stk_limit）**：根本不是接缝问题，是缺口自身 buy_date>g1 的加载范围 bug。

**∴ 不引入边界带复杂度，改走窗口无关化。**

---

## 推荐方案：窗口无关化点修（全部已实测可行）

### Bug2 —— stk_limit 加载到 end_padded
把 `_load_stk_limit(g0_load, g1)` 改为 `_load_stk_limit(g0_load, end_padded)`（与 `quotes`/`suspend` 同口径；`end_padded` 在该循环内已算出）。
- 理由：涨停过滤只看 buy_date（entry_col="buy_date"），buy_date 最大为 next_day(g1)≤end_padded；多加载的日期对入场过滤无害（filter 只查 buy_date）。
- 效果：limit_up_set 覆盖所有 buy_date → 该项 INCR==FULL。
- 改动：1 行 + 注释。零歧义、可立即做。

### Bug3 —— new_listing 改用全局 raw.trade_cal 计数
`filter_new_listing` 当前用加载窗口的 `trade_dates_sorted` 算 list_date/buy_date 的索引差。改成用**全局 `raw.trade_cal`(exchange='SSE', is_open=1)** 计"上市后第N交易日"，使其与加载窗口无关。
- 实现选项：① 给 `filter_new_listing` 传一个覆盖 `[min(list_date), max(buy_date)]` 的全局交易日列表（从 trade_cal 查）替代 `trade_dates_sorted`；或 ② 用 `factors.data_access` 既有的 trade_cal 工具（`count_trade_days_in_window` 等，先查清签名）算每股 list_date→buy_date 的交易日数。
- **注意**：这会让结果比现状 FULL **更严格、更正确**（连 FULL 漏的"≥start 前上市但仍<60交易日"的次新也会剔）。即修后 INCR==FULL 仅当 FULL 也走新逻辑——两条路径都改用全局日历即可一致。
- ⚠️ **生产标签语义变更**：现有 `strategy-aware`(4.28M 行) 用旧窗口依赖逻辑算，改后差异需 force_recompute 才纠正。接手时与用户确认是否要重算生产标签。

### Bug4 —— bit-stable MA + 建议每股预算一次
`_ensure_ma` 的 `rolling(w).mean()` 改为**逐窗独立求和**：`rolling(w, min_periods=w).apply(lambda x: x.sum()/w, raw=True)`。已实测：改后 600157 在两窗口 MA5 **逐位一致**（都 78.67645000000002）。
- **性能坑**：`_ensure_ma` 现在在 `simulate_exit` 里**每个入场都重算一次**（已偏低效）；apply 比向量化 mean 慢，per-entry 重算会雪上加霜。**强烈建议借机重构**：在 `compute_strategy_aware_labels` 里**每股预算一次 MA**（grouped 字典构造时算好 `ma` 列），`simulate_exit` 接收预算好的 ma 列、不再自己 `_ensure_ma`。既修 bug4 又提速。但这动 `simulate_exit` 签名 —— 小心 773 单测基线（exit_rules 有大量单测）。
  - 备选（更轻但改语义）：MABreakRule 用容差 `close < ma5 - eps`（eps~1e-6 相对），避开末位翻转、不动 MA 计算。但会让"close 恰等于 ma5"不触发，属语义微调，需用户拍板。**默认走 bit-stable，不走容差**（除非性能不可接受）。
- ⚠️ 同 bug3，bit-stable 也会**改变现有生产标签**（close≈ma5 点，~0.06%）。

### 实现纪律
- bug3/bug4 动核心 label 计算，**先按 TDD/小步走**：每改一处，跑相关单测（`uv run pytest tests/unit/test_labels_runner.py tests/unit -q -k "label or exit or ma or new_listing"`）+ 全量 `uv run pytest -q`（基线 936 passed + 本会话修的 factors 测试 = 937，0 failed）。
- 改 `simulate_exit` 签名要同步改所有调用方与单测。
- 改 worker/runner 代码后**删 `__pycache__` 重启 worker**（如要真机）。

---

## 验证方法（约束 1 头号）
跑本会话写的脚本（真 DB，strategy-aware 含 ma5_break，gap 落历史中段验头部 padding）：
```powershell
cd apps/quant-pipeline
uv run python tests/integration/verify_incremental_correctness.py
```
脚本逻辑：scheme `strategy-aware__incrtest` 走增量(20230301:20230331 → 再 20230301:20230428)，`strategy-aware__fulltest` 走 force 整段(20230301:20230428)，导出 `[20230301,20230428]` 逐行比对 `value/exit_reason/hold_days/行集合`，并打印 4 月 gap 边界 ma5_break 计数。**通过标准：脚本输出 `RESULT: ✅ PASS`（行集合 + 三列逐行逐值完全一致）**。脚本 PASS 时自动清理 test scheme，FAIL 时保留。
> 注意：该脚本耗时约 12-17min（3 次全市场 strategy_aware compute）。每次跑前它会自动清理旧 test scheme。

修完 bug2/3/4 后，若仍有极少数残差，逐条核到具体股坐实属哪类（理论上窗口无关化后应 0 残差；若 bug4 选了容差方案，close==ma5 的边界点可能仍有定义差异，需判断可接受性）。

---

## 验证标准（全绿才算完成）
1. `verify_incremental_correctness.py` 输出 `RESULT: ✅ PASS`（INCR==FULL 逐行逐值）。
2. python 全量单测绿（基线 937：936 原 passed + 本会话修的 factors 测试；0 failed）；新增逻辑全覆盖。
3. server jest（feature-sets/create-job/quant-jobs）、web type-check + **vite build** + lint:quant-lines + vitest 全绿（本会话已验过一轮全绿，改动后重验受影响部分）。
4. 清理 DB 残留 test scheme。
5. spec `02-incremental-algorithm.md` 同步修订：补"窗口依赖"这一类等价性前提（MA 浮点/new_listing 日历/limit 数据范围必须窗口无关），并记录 bug1-4 与修法。

---

## 硬约束 / 坑
- **trade_cal 必须按 `exchange='SSE'` 过滤**（A 股交易日历标准口径；漏则跨交易所重复计数，bug1 教训）。
- **窗口无关原则**：任何"逐 signal_date 的计算"都不得依赖加载窗口 `[g0_load, end_padded]` 的起点/长度，否则增量 chunk 与整段重算分歧。已知三类：rolling MA 浮点、new_listing 日历、limit/suspend 数据范围。
- **生产标签语义变更**：bug3/bug4 修复会改变现有 4.28M 行 `strategy-aware` 标签（更正确但属行为变更）；与用户确认是否 force_recompute 重算。
- 改 `simulate_exit` 签名须同步全部调用方 + exit_rules 单测；保护 773/937 基线。
- 改 worker/server 代码不热加载，真机前删 `__pycache__` 重启 worker、重启 server。
- 进硬断言/SQL 前自查实体或真 DB 一条（`.claude/rules/data-integrity.md`）；agent 报告=二手，不得直接进硬断言（本会话两次抓到 agent 转述不准）。

---

## 前序进度（已完成，勿重做）
- **migration**：已 upgrade head，feature_sets 两列在，无 drift。
- **静态验证全套**（agent 跑过一轮）：type-check ✅ / vite build ✅(11.25s) / lint:quant-lines ✅ / vitest ✅146 / jest ✅(feature-sets 20 + create-job 40 + quant-jobs 70) / pytest 936 passed（唯一红是 factors 预存裂缝，本会话已修→937）。
- **定向更新前端审查**（并发遗留，agent 审过）：✅ 可用可合——前端 payload ↔ create-job.dto ↔ T1/T2 runner 逐字对齐、权限前后端一致(admin-only)、TZ 用 getFullYear 正确、行数全 ≤500。2 个非阻断小瑕疵（S1 双 job 提交只跳最后一个；S2 串行无补偿）。真机点验清单见下「待续」。

## 待续（修完 bug2/3/4 + 正确性 PASS 后）
1. **真机 e2e**（需重启 server + 启动 worker `uv run quant worker run`，当前**无 worker 在跑**；web 在 5173、server 在 3000）：
   - 备料 prepare → 扩区间看 `skipped_dates` 增量省时 → 训练选已备 fs + date_range disable 越界 → 越界直接 POST 验后端 400。
   - 定向更新：admin 账号 `/quant/jobs` 见「定向更新」按钮 → 只发该发的 job（只因子=1个 factors job / 只标签=1个 labels job / 都选=2个）→ TZ 不漂日 → 落表只动基础表不动 feature_matrix。
2. **finishing**：分支 `feat/quant-strategy-management` 混了 **4 摊交织工作**且深度互依（拆分困难）：
   - A 增量物化+备料/训练解耦（本系列，~17 commits）
   - B 定向更新（T1/T2+前端，~4 commits）
   - C 量化策略管理（strategy_definitions/CRUD/前端，~7 commits）
   - D close_adj 纯后复权（2 commits）
   A 依赖 C 的 strategy_definitions 表、依赖 D 的 apply_hfq。建议用 `finishing-a-development-branch` skill，与用户定整合方式（合 main / PR / 是否拆分），并决定 C/D 是否在本次范围（它们由其它会话做、未在本任务验证）。

## 注意事项
- 终端 Windows PowerShell；`uv run`/`docker exec`/`alembic` 可能需绕 sandbox。源文件一律 UTF-8。
- 派发 Explore subagent 时显式传 `model: sonnet`（CLAUDE.md）。
