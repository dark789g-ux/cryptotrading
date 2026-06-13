# 04 · kelly_sweep：Python 扫描 + NestJS 透传 + web 表单

[← index](./index.md) · 参数/网格见 [02](./02-params-scheme-grid.md) · Python 核见 [03](./03-python-core-and-labels.md)

涵盖 **D4**（kelly Python：exits/sweep）与 **D5**（NestJS 透传 + web 表单）。
镜像对象：`research/kelly_sweep/{exits.py,sweep.py}` / `worker/kelly_sweep_runner.py` /
`apps/web/.../kelly-sweep/{KellySweepConfigForm.vue,BandLockGridEditor.vue}` /
`apps/web/src/api/modules/quant/kellySweep.ts`。

## presence-driven 机制（已落源头核对）

band_lock 在 kelly **不进** `exit_families` 白名单，而是由 `config.band_lock_grid` 是否存在驱动：

```text
web 勾选 band_lock                Python worker                   sweep.py
─────────────────                ─────────────                   ────────
config.band_lock_grid = {        kelly_sweep_runner.py:57         build_band_lock_grid(
  stop_ratio_list, ...     ─▶    _build_exit_grid_from_params  ─▶   **candidates)
}                                 见 band_lock_grid → 生成段          → [{type:'band_lock',...}]
不勾选 → 删除该 key              不见 → 现状（无 band_lock）
```

phase_lock **完全镜像**：新增 `config.phase_lock_grid` 字段，presence-driven，不进 `exit_families`。

## D4 · Python kelly

### exits.py

**编辑** `research/kelly_sweep/exits.py`，新增 `simulate_phase_lock_exit(path, *, init_factor, lock_factor, lookback, same_day_rule) -> trade | None`，镜像 `simulate_band_lock_exit`：

- 从 `ForwardPath` 组装 `PhaseLockBar` 序列 + 切 `recent_lows`（含 buy_bar 的最近 lookback 根非停牌低）。
- 调 `simulate_phase_lock(...)`；`no_entry` / 缺 bar → 返回 None（无交易）。
- 复用 path 已有的复权 / 限停板 / 停牌字段（与 band_lock 同源，确认字段齐备）。

### sweep.py

**编辑** `research/kelly_sweep/sweep.py`：

1. import：`from quant_pipeline.research.kelly_sweep.exits import simulate_phase_lock_exit`；
   `from quant_pipeline.labels.phase_lock_scheme import quantize_phase_lock_params`。
2. `_KNOWN_EXIT_FAMILIES`（当前 `{fixed_n,tp_sl,trailing,atr_stop,band_lock}`）→ 加 `"phase_lock"`。
3. 新增 `build_phase_lock_grid(*, lookback_list=None, init_factor_list=None, lock_factor_list=None) -> list[dict]`，镜像 `build_band_lock_grid`：
   - 各 ratio 候选进笛卡尔积前经 `quantize_phase_lock_params` 量化；
   - 笛卡尔积 `lookback × init_factor × lock_factor` + 去重；
   - cfg 字典：`{"type":"phase_lock", "lookback":N, "init_factor":r, "lock_factor":r}`；
   - 默认候选集 = [02 kelly 默认网格](./02-params-scheme-grid.md#kelly-默认网格)（4×4×3=48）；
   - 超软阈值（200）→ `logger.warning`。
4. `_run_exit`（sweep.py:448 dispatch）→ 新增 `elif t == "phase_lock": trade = simulate_phase_lock_exit(...)` 分支。
5. `_exit_id`（sweep.py:389）→ 新增 `if t == "phase_lock": return _phase_lock_exit_id(cfg)`，示意形如 `phase_lock(lb=10,if=0.99,lf=0.999)`；ratio 格式化（去尾零/定宽）**镜像 `_band_lock_exit_id` + `_fmt_ratio`（sweep.py:408/439）现状**，实现期对齐并以测试锁定。
6. `DEFAULT_EXIT_GRID`：**不动**（band_lock 在此追加 3 个默认 cfg 是历史零漂移约束；phase_lock 是全新族，默认不进 DEFAULT_EXIT_GRID，只在 grid 提供时生成——避免污染现存默认扫描结果 / 哈希）。

### kelly_sweep_runner.py

**编辑** `worker/kelly_sweep_runner.py`，镜像 band_lock_grid 透传（57-126 行区块）：

- `_build_exit_grid_from_params`：读 `params.get("phase_lock_grid")`；为 dict → `build_phase_lock_grid(**_normalize_phase_lock_candidates(raw))` 并合并进 exit_grid；非 dict → ValueError。
- 新增 `_normalize_phase_lock_candidates`：仅透传 3 个候选集键（`lookback_list / init_factor_list / lock_factor_list`），未知键 → ValueError。

## D5 · NestJS 透传 + web 表单

### NestJS（create-job.dto.ts）

> **核对要点**：当前 `create-job.dto.ts` 无任何 `band_lock` 引用——`band_lock_grid` 是作为 kelly `params` 的**透传字段**进 job.params 的（不走 `exit_families` 校验）。实现 D5 时**先确认** `phase_lock_grid` 同样能透传不被剥离；若 DTO 对 params 做了 key 白名单/strip，则按 band_lock_grid 的放行方式同步放行 `phase_lock_grid`。
> `KELLY_SWEEP_EXIT_FAMILIES`（`{fixed_n,tp_sl,trailing,atr_stop}`）**不加** phase_lock（与 band_lock 一致，presence-driven 不进白名单）。

### web API 类型（kellySweep.ts）

**编辑** `apps/web/src/api/modules/quant/kellySweep.ts`，镜像 `BandLockGrid`（45 行）：

```ts
/** phase_lock 出场族候选集（各维度多值），提交时拼进 job.params.phase_lock_grid。
 *  透传给 build_phase_lock_grid(**candidates) 的 3 个 kwargs（必须带 _list 后缀）。 */
export interface PhaseLockGrid {
  lookback_list: number[]
  init_factor_list: number[]
  lock_factor_list: number[]
}
// kelly config 接口加：phase_lock_grid?: PhaseLockGrid
```

### web 表单（KellySweepConfigForm.vue + PhaseLockGridEditor.vue）

**编辑** `KellySweepConfigForm.vue`，镜像 band_lock 独立开关区块（181-193、326-389 行）：

- 新增独立开关 `phaseLockEnabled = computed(() => config.value.phase_lock_grid !== undefined)`；
- 勾选 → 写 `config.phase_lock_grid = makeDefaultPhaseLockGrid()`；取消 → 解构删除该 key；
- `v-model` 桥接 `phaseLockGridModel`（getter 兜底默认，setter 写回 config）；
- 组合数预估 `estimatePhaseLockGridSize` 计入总数（与 band_lock 同口径）。

**新建** `apps/web/src/components/quant/kelly-sweep/PhaseLockGridEditor.vue`（镜像 `BandLockGridEditor.vue`）：3 个候选集多值输入（lookback / init_factor / lock_factor）。

**编辑** `KellySweepView.vue`（133-136 行同款）：切换历史 job 时，若新 config 无 `phase_lock_grid` 则显式 `delete store.config.phase_lock_grid`（防残留展开）。

> **行数红线**：`apps/web/src/views/quant/**` 与 `components/quant/**` 受 `lint:quant-lines` 约束（单文件 ≤500 行）。`KellySweepConfigForm.vue` 已较大，新增区块后须跑 `pnpm --filter @cryptotrading/web lint:quant-lines`；若超限，把 phase_lock 区块逻辑抽进 `PhaseLockGridEditor.vue` 或 composable。
