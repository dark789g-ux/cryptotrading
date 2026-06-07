# 任务交接：修 bug5（停牌股 MA 窗口依赖）→ 重测探查 → 决策门 → 生产标签口径对齐重算

> 本文是上一会话的**完整交接**。上一会话用 brainstorming 出了 spec、用 subagent-driven-development 建了探查工具并跑了首版探查，**意外发现一个 bug1-4 之外的第 5 类窗口依赖 bug**，用户已批准按 Method A 修复，并要求另开会话执行剩下全部任务。本文即"剩下全部任务"。
> **接手第一件事：按"当前状态快照"重查真 DB / git，别信任何可能过期的数字。**

## 一句话目标
窗口无关化修复（commit `6779c79`）改了 `factors.labels` 口径；现有生产标签是旧码算的、与新码不一致。本任务：**修 bug5 → 重测探查拿可信差异 → 决策门由用户逐 scheme 拍板 → DELETE+月度内存安全重算 labels → 重建 feature_matrix → 评估重训 → 验证**。重算会一并纠正 **bug1-5**。

## 这是什么任务的续作
- 前序1 `prompts/fix-labels-incremental-window-invariance.md`（已完成）：修 bug1-4，commit `6779c79`/`172e5f4`。
- 前序2 `prompts/recompute-production-labels-after-window-fix.md`：原始重算任务书。
- 设计 spec（**先读**）：`docs/superpowers/specs/2026-06-06-recompute-production-labels-design/`（index 入口，6 个子文档；总体流水线/决策门/量化探查/重算级联/验证全在里面）。
- 记忆：`project_labels_features_incremental_prepare`。

---

## 当前状态快照（2026-06-06 末，接手请重查）

### 分支 / 提交（`feat/quant-strategy-management`）
本会话已提交 3 个：
```
347244e feat(quant-pipeline): labels 重算口径对齐探查工具 + fwd scheme 变体支持
0c33c95 docs(quant): spec 自审修订
d03d1b3 docs(quant): 生产标签口径对齐重算 runbook spec
```

### ★工作区未提交（本会话 Wave3 修复，已过 39 针对性测，但**未全量验证、未提交**）
- `apps/quant-pipeline/src/quant_pipeline/labels/runner.py` —— **Fix1**：缺口循环 upsert 前加 `labels_df["scheme"] = scheme`（约 643 行），强制持久化 scheme=传入值。**修的是 fwd 把变体 scheme 误写回规范/生产 scheme 的 footgun**（fwd 计算函数 `fallback.py:161` 用 `base_scheme_codec` 重建规范名当 scheme 列，与 `strategy_aware.py:541` 不对称）。
- `apps/quant-pipeline/tests/integration/_recompute_helpers.py` —— **Fix2**：加 `sse_trading_day_before` + 纯函数 `_trading_day_before_from_caldates`。
- `apps/quant-pipeline/tests/integration/probe_recompute_diff.py` —— **Fix2**：Q1 每窗口加头部缓冲 `head_start=max("20230103", sse_trading_day_before(Ws,10))`，`monthly_drive(full_start=head_start)`，diff 仍只比 `[Ws,We]`。修的是"非原点窗口缺 MA 头部回看 → 伪差异"（W2 报 9% 是这个假象）。
- `apps/quant-pipeline/tests/integration/test_recompute_helpers.py` —— 新增 8 个单测。
- `apps/quant-pipeline/uv.lock` —— **⚠️ 不要提交！** 含会话开始前就存在的 torch/CUDA/nvidia 在途 lock 重生成（非本任务），外加一个 psutil 条目（探查 Q2 用，已 `uv add` 装进 venv 后又把 pyproject 回退了）。psutil 已在 venv 可用。提交会把别人的在途改动裹进来。
- 其它 `M`/`D`（`.claude/.../lessons-learned.md`、`CLAUDE.md`、`scripts/dev.mjs`、删的 `prompts/*.md`、未跟踪的几个 `prompts/*.md`）：**都不是本任务的改动，别动、别提交。**
- 未跟踪 `docs/superpowers/specs/2026-06-06-recompute-production-labels-design/probe-report-20260606.md`：首版探查报告（部分污染，见下）。

### 真 DB 现状（本地 crypto-postgres，alembic 已 head `20260606_0004`，无 drift）
```
factors.labels
  strategy-aware   4,283,513 行  812 天  20230103..20260515
  fwd_ret_h1       2,528,986 行  484 天  20230103..20241231
factors.feature_matrix
  fs_60bc257fb173  4,285,271 行  813 天  20230103..20260528  (strategy-aware)
  fs_9b5ff4d69c1e  2,525,225 行  484 天  20230103..20241231  (fwd_ret_h1)
ml.model_runs
  lgb-lambdarank-v1-20260521-seed42  fs_60bc257fb173  prod    有日评分(20260515..28)
  lgb-multiclass-v1-20260605-seed42  fs_9b5ff4d69c1e  shadow  无日评分
feature_sets 参数: 两者 factor_version=v1, new_listing_min_days=60, factor_ids 长度=16
```
重查命令：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT scheme,count(*),min(trade_date),max(trade_date) FROM factors.labels GROUP BY scheme;"`
> **注**：feature_matrix fs_60bc257fb173 dmax=20260528 比 labels strategy-aware dmax=20260515 晚 13 天——已查清非 bug：是 M4 每日推理 left-join(label 可空) 写的推理日特征行（label=NULL，对应 scores_daily 20260515..28）。重算范围 labels 用 `[20230103, 真实dmax]` 动态取。

---

## 关键发现（本会话产出，直接用）

### ★bug5：停牌股 MA 窗口依赖（根因已用真 DB 逐值复现，置信度高）
`strategy/exit_rules.py::_ensure_ma` 用**位置性** `close.shift(j)`（按每股 DataFrame 行下标），但 head_pad 按**日历交易日**回看（`runner.py::_compute_g0_load`，回看 `ma_window-1=4` 个 SSE 交易日）。两者**只在该股回看窗内无缺行时等价**；**停牌股缺行** → 4 个日历日凑不够 4 个"前序在场行" → MA5 取行更少甚至 NaN → `MABreakRule` 翻转 → hold/value/exit_reason 分歧。
- 铁证 `20230328 / 002499.SZ`（停牌 20230203→20230324，缺 36 天）：其前 5 个在场行回溯到 `20230202`。FULL（从 20230103 加载）有该行 → MA5=2.39 → ma5_break day1 → value 0.0143；增量（gap 头部只到 20230223）→ 没加载到 → 第5行 NaN → MA5=NaN → 拖到 day2 → value 0.0。
- **更深的点**：之前 `verify_incremental_correctness.py` PASS 是因为它让 INCR/FULL 用同一 start → 两路对 start 前停牌的股"一样地错"。**FULL 本身也是窗口依赖的**。真·正确 MA5 = 该股最近 ma_window 个**在场行** close_adj 均值，与加载窗口无关。**所以生产现有 strategy-aware 标签里、停牌股边界附近本就带这个错值**，重算会纠正。
- fwd 系不受影响（head_pad=0、不经 MA）。

### 首版探查结果（probe-report-20260606.md；W1 有效，W2/fwd/Q3 见说明）
```
strategy-aware W1 (20230103:20230630)  ✓有效（起点=全局原点）
   仅在prod 8302 (1.39%) / value变 1913 (0.33%) / exit_reason 14 (0.00%) / hold 2116 (0.36%)
strategy-aware W2 (2024-06)            ✗污染：探查窗口依赖(已 Fix2 修，待重跑)；报的 9.09% 是假象
fwd_ret_h1 W1                          ✗污染：fwd 写回了生产(已 Fix1 修，待重跑)；recheck=0
Q3 驱动自证                            ❌ FAIL：bug5，月度增量≠单次force 差 4 行(0.0014%)
```
> **fwd 生产数据**：首版探查 fwd recheck 误 upsert 进了生产 `fwd_ret_h1`，但**实质无损**——fwd_ret_h1 是确定性次日收益，行数仍 2528986、only_in_new=0、存活行值不变。接手可不处理；真要洁癖就在最终 fwd 重算时整段覆盖。Fix1 已堵住此路径。

---

## ★剩余任务（有序执行）

### 任务 A：实现 bug5 修复（Method A，生产代码，用户已批准）
**目标**：让 strategy-aware 的 MA5 真正窗口无关（每股拿到足够"在场行"）。
- 改 `apps/quant-pipeline/src/quant_pipeline/labels/runner.py::_load_daily_quotes`：除主窗口 `[g0_load, end_padded]` 外，对**每个 ts_code** 再补该股 `trade_date < g0_load` 的最近 `ma_window-1` 个**在场行**（`ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date DESC) <= ma_window-1`，UNION 主窗口）。给 `_load_daily_quotes` 加可选 `head_rows_per_code: int` 参数；`compute_labels` 缺口循环把 `ma_window` 传进去。
- **只喂 MA、绝不进 entries/不写库**：现有 `entries = quotes ∩ [g0,g1]` 已按日期夹，须复核补进的早期行不被 `_augment_quotes_for_exit`/grouped 污染 entries。
- `_compute_g0_load` 可保留作主窗口下界，但 MA 正确性不再依赖它。
- **不碰 `simulate_exit` 签名**（避开 773 单测风险）；`_ensure_ma`（shift 求和、已 bit-stable）喂够在场行即对，**不改它**。
- Method B（放大整数 head_pad）已否：停牌最长 76 天，保证不了不变性还撑爆内存。
- **影响**：strategy-aware MA5 语义更正确（窗口无关）= 生产标签语义变更（同 bug3/4 性质）→ 重算纠正。`test_labels_runner.py` 里几条加载范围断言（`daily_quotes_starts`、`_compute_g0_load` 调用断言）需同步更新（预期内、非回归）。
- TDD：造一只"g0_load 前长停牌、g0_load 后复牌"的 fake 股，断言加载结果含其 g0_load 前 `ma_window-1` 个在场行。

### 任务 B：提交工作区未提交的 Fix1+Fix2+任务A（分层 commit，**不含 uv.lock**）
- 用户偏好按子系统分层 commit（见记忆 `feedback_layered_commits`）。建议：①Fix1+任务A（runner 生产修复，一个 commit）②Fix2+helper+测试（探查脚本修复，一个 commit）。
- `git add` **显式列文件**，**绝不 `git add uv.lock`**。commit message 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

### 任务 C：全量验证零回归
`cd apps/quant-pipeline; uv run pytest -q`。基线：本会话引入前 941 passed；本会话已加 21(探查helper)+10(scheme分发)+8(trading_day)=39，任务A 会再加若干 + 改几条加载断言。确认全绿、simulate_exit 单测零变化。

### 任务 D：重跑修正版探查 → Q3 必须 PASS + 拿最终可信差异
```powershell
cd C:\codes\cryptotrading\apps\quant-pipeline
$env:PYTHONPATH="."
uv run python tests/integration/probe_recompute_diff.py --only q3        # 先验 bug5 修复：必须全 0 PASS
uv run python tests/integration/probe_recompute_diff.py --only q1 --out <报告路径>   # 拿 W1+W2(修正)+fwd(进__recheck) 可信差异
```
- **Q3 必须 PASS（drive==full 全 0）**，否则 bug5 没修干净，回任务 A。
- 另建议加一版 verify：`C0` 早于 gap start（如 C0=20230103、第一段到 20230228、gap=20230301:20230331）+ 把 002499.SZ 等 4 只票纳入断言，锁死"start 早于 gap g0_load + 跨长停牌"这条原先漏测路径，防回归。
- 内存：单月 chunk 实测峰值 **~439 MB**（Q2 已测）；本机 16G、空闲 2~4G、页面文件 35G 兜底 → **月度粒度安全**，无需分片。q1 全跑约 30-50 分钟，建议 `run_in_background`。
- 探查只写临时 `__recheck*` scheme、收尾 DELETE、prod 只读（Fix1 后 fwd 也安全）。

### 任务 E：★决策门（人工，硬停）
把每个 scheme 的可信差异（only_in_old/value/exit_reason/hold_days 计数与占比）摆给用户，**逐 scheme 由用户决定重算/跳过**。判据见 spec `02-pipeline-and-gate.md#决策门判据`。**未经用户逐 scheme 批准不得 DELETE/重算生产。**

### 任务 F~I：（决策门批准后）重算 → 重建 → 评估重训 → 验证 → 收尾
全部细节在 spec `04-recompute-and-cascade.md` 与 `05-validation-and-rollback.md`，照做。要点：
- **labels 重算**（仅批准的 scheme，顺序 fwd_ret_h1 → strategy-aware）：先 `DELETE FROM factors.labels WHERE scheme='X'`（唯一不可逆步、二次确认），再月度幂等循环 `compute_labels(scheme='X', date_range=f"20230103:{m_end}", force_recompute=False)`（**date_range.start 恒 20230103**）。可复用 `_recompute_helpers.monthly_drive`。崩溃重跑跳过已物化、自收敛；禁忌：别重跑 DELETE。
- **feature_matrix 重建**（仅批准的 fs，顺序 fwd → strategy-aware）：`DELETE WHERE feature_set_id='<fs>'` → 月度 `build_feature_matrix(force_recompute=False)`。**fail-fast 护门**：重建前从 `factors.feature_sets`+原始 prepare/train job 的 `ml.jobs.params` 还原全部 6+overlay 参数，dry-run `build_feature_set_id(...)` 断言 == 目标 fs，相符才跑。注意 fs_60bc257fb173 的 13 天 NULL-label 推理行（重建后会丢，下次推理自会重生，无碍）。
- **模型**：默认评估；重训只增 shadow、比 oos_metrics、由用户 promote，**绝不盲换 prod**（lgb-lambdarank 是 live 底座）。
- **验证**：抽样次新股/停牌股边界、无幽灵行、行数对齐、feature_matrix ⊆ labels、全量 pytest 绿。
- **收尾**：`finishing-a-development-branch`（本分支混了增量物化+定向更新+本次重算治理，需定整合方式）；更新记忆 `project_labels_features_incremental_prepare`。

---

## 硬约束 / 坑（务必带走）
- **不假设、暴露权衡、用中文**（CLAUDE.md）。派 Explore subagent 显式传 `model: sonnet`。
- **内存**：16G、空闲紧（2~4G）；月度 chunk 峰值实测 ~439MB；页面文件 35G 兜底。**月度粒度足够安全，不要做 ts_code 分片**（与增量缺口检测冲突、改动大）。
- **probe 调用必须** `cd apps/quant-pipeline; $env:PYTHONPATH="."; uv run python tests/integration/probe_recompute_diff.py ...`（脚本 `from tests.integration...` 需 PYTHONPATH=. ；直接 `python 路径` 会 ModuleNotFoundError）。`uv`/`docker`/`alembic` 可能需绕 sandbox（`dangerouslyDisableSandbox`）。
- **DELETE 必须先于重算**（`_upsert` 不删行 + bug3/5 新码产出更少/不同行 → 不删留幽灵行）。labels 与 feature_matrix 两处都要。**用户选了不备份 → 临时 scheme 探查(任务D)是唯一安全网，Q3 PASS 是 DELETE prod 的前置硬门。**
- **trade_cal 一律 `exchange='SSE'` 过滤**（bug1 教训）。进硬断言/SQL 前自查实体或真 DB 一条（子代理报告=二手，不直接进硬断言）。
- 终端 Windows PowerShell（禁 `&&`，用 `;`）；源文件一律 UTF-8、文件 I/O 显式 `encoding='utf-8'`。
- PowerShell 工作目录在工具调用间**会持久**（别重复 `Set-Location` 相对路径，会叠加路径报错；用绝对路径或不重设）；env 变量**不持久**（每次重设 `$env:PYTHONPATH`）。
- 决策门、模型 promote、DELETE prod 均为**人工确认点**，不自动越过。

## 参考文件位置
- spec：`docs/superpowers/specs/2026-06-06-recompute-production-labels-design/`（index.md 入口）
- 探查工具：`apps/quant-pipeline/tests/integration/{probe_recompute_diff.py,_recompute_helpers.py,test_recompute_helpers.py}`
- 正确性比对范式：`apps/quant-pipeline/tests/integration/verify_incremental_correctness.py`
- 关键源码：`labels/runner.py`（compute_labels / _upsert_labels:370 / _compute_g0_load:202 / _load_daily_quotes / fwd 分支:595 / scheme 覆盖:643）、`strategy/exit_rules.py`（_ensure_ma / simulate_exit）、`labels/fallback.py:156-161`（fwd scheme 重建）、`labels/strategy_aware.py:541`、`features/builder.py`（merge_with_labels:448 / build_feature_set_id:62）
- 首版探查报告：`docs/superpowers/specs/2026-06-06-recompute-production-labels-design/probe-report-20260606.md`
