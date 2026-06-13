# 两阶段锁定止损出场（phase_lock）设计

> 状态：设计已与用户口头敲定，待 spec 审阅 → SDD 实施。
> 日期：2026-06-13。代号：`phase_lock`。

## 背景与目标

在量化回测系统现有出场规则之外，新增一条**两阶段锁定止损**出场规则 `phase_lock`。
它与现存 `band_lock`（波段跟踪止损 / trailing_lock）**骨架相同、决策核不同**，
是 band_lock 的"兄弟"，**不是**它的再参数化。

新规则的业务语义（用户原文精确化后）：

1. **初始止损（阶段 A）**：建仓后首个交易日（T+1）收盘时，止损价设为
   `floor2( min(最近 lookback 根含 T+1 的非停牌复权 low) × init_factor )`，
   **持仓全程固定不上移**，直到阶段切换。
2. **阶段切换（仅一次）**：某交易日收盘**首次**满足「收盘价 > MA5 且 MA5 > 前一非停牌日 MA5」时，
   止损价上移至 `floor2( MAX(成本价, 当日复权 low) × lock_factor )`，进入阶段 B，**此后止损价冻结**。
3. **阶段 B 清仓**：进入阶段 B 后，某交易日收盘满足「收盘价 < MA5 且 MA5 < 前一非停牌日 MA5」时，按收盘价全部清仓。
4. **优先关系**：止损盘中触发（`low ≤ stop` 即按止损价清仓，跳空低开取开盘价），
   优先于收盘 MA5 判断；同日盘中已触止损则当日不再做收盘判断。

### 范围决定（已与用户确认）

- **全三方对齐 band_lock**：signal-stats（A 股信号前向统计/出场模拟）+ labels/exit_rules（量化训练标签）+ kelly_sweep（凯利上界扫描）。
- 架构选型 **方案 A**：与 band_lock **平行**新建独立纯函数核 + 独立 scheme 编码器 + 独立 kelly 网格，复制（非共享）A 股边界骨架。理由见 [01-algorithm.md](./01-algorithm.md#方案选型与边界复用)。
- **可扫描参数 3 个**：`init_factor` × `lock_factor` × `lookback`。`ma5_require_down`、相位切换的"MA5 上行"要求 —— 按原文**钉死成常量 True**，不暴露。无 `max_hold` 硬上限。

### 关键不变量（硬约束）

- **Python / TS 逐数值对拍**：纯函数核两侧逐 bar 行为必须逐位一致（含 `floor2` 截断、round-half-up 量化）。这是 band_lock 留下的硬纪律，新规则照搬。
- **哈希守门**：全默认 scheme = legacy 别名 `"phase_lock"`，不触发既有 `feature_set_id` 漂移。
- **存量零漂移**：新增 DB 列 `phase_lock_params` 默认 NULL，不影响任何现存 band_lock / 其它行。

## 子文档清单（建议阅读顺序）

1. [01-algorithm.md](./01-algorithm.md) — 算法精确化：方案选型、状态机、逐 bar 优先级、纯函数核接口、A 股边界处理。
2. [02-params-scheme-grid.md](./02-params-scheme-grid.md) — 参数集与默认值、canonical scheme 编码（`phase_lock_scheme`）、kelly 默认网格。
3. [03-python-core-and-labels.md](./03-python-core-and-labels.md) — D1 纯函数核 + D3 labels 模块 / scheme 编码器 / runner 路由（Python）。
4. [04-kelly-sweep.md](./04-kelly-sweep.md) — D4 kelly Python（exits/sweep）+ D5 NestJS 透传 / web 表单接线。
5. [05-signal-stats-ts.md](./05-signal-stats-ts.md) — D2 signal-stats TS 同构核 / DTO / 实体 / 前端表单。
6. [06-fixtures-and-testing.md](./06-fixtures-and-testing.md) — 主样例对拍表、测试落点、验证标准。
7. [07-tasks-and-rollout.md](./07-tasks-and-rollout.md) — D1~D6 SDD 任务切分、依赖序、迁移、哈希守门、验收。

## 跨文档引用约定

统一用相对路径 + 锚点，例如 [`./02-params-scheme-grid.md#canonical-scheme-编码`](./02-params-scheme-grid.md#canonical-scheme-编码)。
锚点用中文标题去空格/标点后的小写形式（GitHub/通用 Markdown 渲染口径）。

## 现状锚点（已落源头核对，file:line 为证）

| 镜像对象 | band_lock 现状位置 | phase_lock 对应产物 |
|----------|-------------------|---------------------|
| 纯函数核 (Py) | `apps/quant-pipeline/src/quant_pipeline/strategy/band_lock_exit.py` | `strategy/phase_lock_exit.py`（新建） |
| 纯函数核 (TS) | `apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.ts` `decideBandLock` | 同文件 `decidePhaseLock`（新增） |
| scheme 编码器 | `apps/quant-pipeline/src/quant_pipeline/labels/band_lock_scheme.py` | `labels/phase_lock_scheme.py`（新建） |
| labels 模块 | `labels/band_lock_labels.py` | `labels/phase_lock_labels.py`（新建） |
| runner 路由 | `labels/runner.py:38-78`（is/parse_band_lock_scheme） | runner 新增 phase_lock 分支 |
| kelly 扫描 | `research/kelly_sweep/sweep.py` `build_band_lock_grid`/`_run_exit`/`_exit_id` | 同文件新增 phase_lock 三件套 |
| kelly 适配 | `research/kelly_sweep/exits.py` `simulate_band_lock_exit` | 同文件 `simulate_phase_lock_exit` |
| kelly runner 桥 | `worker/kelly_sweep_runner.py:57 _build_exit_grid_from_params` | 同文件读 `phase_lock_grid` |
| 实体列 | `entities/strategy/signal-test.entity.ts:43 band_lock_params` | 新增 `phase_lock_params` jsonb 列 + migration |
| 迁移 | `migrations/20260613_add_band_lock_params_to_signal_test.sql/.ps1` | `20260613_add_phase_lock_params_to_signal_test.sql/.ps1` |
| signal DTO | `signal-stats/dto/create-signal-test.dto.ts:27` exitMode | 新增 `'phase_lock'` + 扁平参数 |
| web kelly 表单 | `apps/web/src/views/quant/kelly-sweep/KellySweepConfigForm.vue` + `BandLockGridEditor.vue` | `PhaseLockGridEditor.vue`（新建）+ 表单开关 |
| web kelly API 类型 | `apps/web/src/api/modules/quant/kellySweep.ts:45 BandLockGrid` | 新增 `PhaseLockGrid` |
