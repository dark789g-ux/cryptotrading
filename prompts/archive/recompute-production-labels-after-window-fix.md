# 任务：窗口无关化修复后，生产存量标签的口径对齐重算

## 一句话目标
窗口依赖修复（commit `6779c79`）改变了 labels 的计算口径；现有生产标签用**旧码**算、与**新码**不一致。本任务：**先量化差异规模**，再决定是否/如何重算，并处理 `feature_matrix` 级联，最后验证。
**先评估差异，别盲目重算 ~680 万行（可能大半是 0 差异）。**

## 这是什么任务的续作
前序 `prompts/fix-labels-incremental-window-invariance.md`（已完成）：修了 labels 增量物化的 4 处"窗口依赖"缺陷（bug1-4），commit：
- `6779c79` fix(quant-pipeline): labels 增量物化窗口无关化，约束1 逐行等价
- `172e5f4` fix(quant-pipeline): ml.jobs run_type CHECK 约束补 'prepare'

当时用户决定「**先落代码，重算另议**」。本任务即"另议"的重算。

## 先读
- 上面两个 commit 的 diff（看清口径怎么变的）。
- spec `docs/superpowers/specs/2026-06-06-labels-features-incremental-prepare-design/02-incremental-algorithm.md` 的「⚠️ 补漏：窗口依赖」节（bug1-4 表 + 窗口无关原则）。
- 记忆 `project_labels_features_incremental_prepare`（含本系列全过程 + e2e + 重算待办）。
- 正确性比对脚本 `apps/quant-pipeline/tests/integration/verify_incremental_correctness.py`（diff 思路可复用）。

---

## 当前生产状态（2026-06-06 快照，接手请重查，可能已变）
```
factors.labels:
  strategy-aware  4,283,513 行  812 交易日  20230103..20260515   ← 受 bug2/3/4 影响
  fwd_ret_h1      2,528,986 行  484 交易日  20230103..20241231   ← 受 bug3 影响
factors.feature_matrix（= features ⋈ labels，下游级联）:
  fs_60bc257fb173  4,285,271 行  813天  scheme=strategy-aware  new_listing_min_days=60
  fs_9b5ff4d69c1e  2,525,225 行  484天  scheme=fwd_ret_h1      new_listing_min_days=60
```
重查命令：
```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT scheme,count(*),min(trade_date),max(trade_date) FROM factors.labels GROUP BY scheme;"
```

## 哪些口径变了（每个 bug 对每个 scheme 的影响）
| bug | 影响 scheme | 口径变更 | 预估规模 |
|---|---|---|---|
| **bug3** new_listing 改用**全局 SSE 日历**计"上市后第N交易日" | strategy-aware + fwd_ret_h1 | **更严格**：次新股 list_date 早于"当初计算时的加载窗口起点"的，旧码漏剔、新码剔 | 取决于旧标签怎么算的（见下），可能小可能可观 |
| **bug4** `_ensure_ma` 改 bit-stable 逐窗求和 | 仅 strategy-aware | close≈ma5 边界点出场判定可能翻转 | ~0.06%（前序实测） |
| **bug2** stk_limit 加载到 end_padded | 仅 strategy-aware | 区间末尾 signal 的 buy_date 涨停过滤；旧码若**分段**算则接缝处漏剔 | 取决于旧标签怎么算的 |

## ★第一步：量化差异，别盲算
**差异规模强依赖"旧标签当初是怎么算的"：**
- 若旧标签是**一次性整段**算的（单个 train_e2e / 单个全区间 labels job）→ bug2/bug3 几乎没触发（窗口从最早起、无分段接缝）→ 只剩 bug4 的 ~0.06% MA 边界差异 → **重算价值很小**。
- 若旧标签是**分段/增量**累积算的 → bug2/bug3 在每个接缝漏剔 → 差异可能可观。

**做法**：用新码把（一小段或全段）算进**临时 scheme**，与生产逐行 diff，量化真实差异行数/占比，再决定。
```python
# 在 apps/quant-pipeline 下 uv run python，复用 verify 脚本的 diff 逻辑
from quant_pipeline.labels.runner import compute_labels
# 用临时 scheme（避免污染生产），新码、force 整段算一小段先探：
compute_labels(scheme="strategy-aware__recheck", date_range="20230103:20231231", force_recompute=True)
# 再 SQL diff 'strategy-aware__recheck' vs 'strategy-aware' 在 [20230103,20231231]
# 逐行比 value/exit_reason/hold_days + 行集合差（only_in_old = 被新码剔的幽灵行）
# 探完删临时 scheme：DELETE FROM factors.labels WHERE scheme='strategy-aware__recheck'
```
**通过此步才知道要不要重算、值不值。**

---

## ★★最大的坑：force_recompute 是 upsert、不删行 → 必须 DELETE 后重算
`_upsert_labels` 是 `INSERT ... ON CONFLICT DO UPDATE`（`labels/runner.py`）。bug3 修复让新码**产出更少行**（多剔了次新股）。纯 `force_recompute` 只 upsert 新码**算得出**的行，那些"旧码有、新码不再产出"的 (trade_date, ts_code) **旧行不会被删** → 残留**幽灵旧行**，结果不干净、行集合错。
> **∴ 要得到正确结果，必须先 `DELETE FROM factors.labels WHERE scheme=...`（按区间）再重算，不能纯 force 覆盖。**

## ★第二个坑：别用"分年 force"——它是 window-dependent 的（正是本系列修的 bug 反向重现）
- `force_recompute` over `[A,B]`：`g0_load` 夹到 `A`（无头部回看）→ `A` 起 `ma_window-1` 天 MA=NaN、new_listing 计数也从 A 起。
- 分年 force（force [2023]、force [2024]…）→ 每年初 4 天 MA NaN、次新股计数错位，与"单次整段算"**不等价**。
- **整段等价**的重算只有两条正确路：
  1. **单次 force 全区间**（最简单、口径对）：`compute_labels(scheme=..., date_range=全区间, force_recompute=True)`。一次大 load+compute。
     - ⚠️ **内存/耗时**：strategy-aware 812 交易日全市场，按 verify 脚本 1.5 月≈530s 外推约**数小时** + 数 GB 内存，dev 机注意 OOM。
  2. **删旧 + 逐年增量推进**（内存分摊、口径仍对）：先 `DELETE` 全 scheme；force 算**第一年**（`force=True, [2023.start, 2023.end]`，年初 NaN 边界本就该有，因无更早历史）；之后**逐年增量**：`compute_labels(force=False, date_range=[全区间起点, 当年末])`——增量只算未物化的当年（gap），且 `g0_load` 会**回看进上一年的真实行情**（head_pad），从而年初 MA 非 NaN、口径=整段。**关键：date_range.start 必须传全区间起点**（否则 g0_load 夹不回去）。
     - 这条兼顾内存与口径，但实现要小心，建议先在临时 scheme 上验证逐年推进 == 单次整段（复用 verify 脚本思路）。

## ★级联：labels 变了，feature_matrix + 模型也 stale
- `feature_matrix = features ⋈ labels`（inner join on (trade_date,ts_code)）。现有 `fs_60bc257fb173`(strategy-aware) / `fs_9b5ff4d69c1e`(fwd_ret_h1) **join 的是旧标签值**。
- labels 重算后，这些 feature_matrix 的 label 列仍是旧值 → 必须**重建 feature_matrix**（features force_recompute；同样有上面的 DELETE/分段口径坑）。
- 在这些 fs 上训过的模型 → 用旧标签训的 → 评估是否重训（确认模型注册表真实表名：`factors.model_runs` 不存在，查 `ml.*` / model registry）。
- **推荐顺序**：labels（DELETE+整段重算）→ features（同 fs 重建）→ 评估重训。
- 前端「备料」勾"强制重算"可一步 labels+features，但**它的 force 也是单次整段 force**（注意是整段、且仍有 upsert-不删行的坑——若新 new_listing 更严格，备料前也应先 DELETE 旧 labels/feature_matrix）。

## 验证标准
1. **重算前**：临时 scheme diff 量化差异（决定要不要做、做哪些 scheme）。
2. **重算后**：
   - 抽样核对受影响股：次新股（list_date 早于区间起点但 <60 交易日）被正确剔；close≈ma5 边界点 reason 用新值。
   - 行集合无幽灵旧行（confirm DELETE 生效）；总行数变化合理（new_listing 更严格 → 略减）。
   - feature_matrix 重建后行数/coverage 与 labels 对齐（features ⋈ labels 行数 ≤ labels）。
3. python 全量单测仍绿（基线 **941 passed**；`cd apps/quant-pipeline; uv run pytest -q`）。

## 前置条件 / 硬约束
- **目标库/环境必须已应用**：alembic `20260606_0004`（prepare 约束）+ 部署 `6779c79` 新码 + **删 `__pycache__` 重启 worker**（worker 跑旧码则白算）。生产：`uv run alembic upgrade head`（先 `alembic current` 防 drift）+ 部署 + 重启常驻进程。
- **重算是大操作**（数百万行、数小时、覆盖写有副作用）：先小范围验证流程，确认 worker 跑新码，再全量。
- trade_cal 一律 `exchange='SSE'` 过滤（A 股标准口径，bug1 教训）。
- 进硬断言/SQL 前自查实体或真 DB 一条（`.claude/rules/data-integrity.md`）。
- 终端 Windows PowerShell；`uv run`/`docker exec`/`alembic` 可能需绕 sandbox；源文件一律 UTF-8。

## 注意事项
- 这是**口径对齐 + 数据治理**任务，不是改代码（代码已对、已验证 210001 行 INCR==FULL）。核心是：量化差异 → 选对重算策略（DELETE+整段等价，避开 upsert-残留 / 分年-window-dependent 两坑）→ 处理 feature_matrix/模型级联 → 验证。
- 派发 Explore subagent 时显式传 `model: sonnet`（CLAUDE.md）。
