# 05 · labels 透传 + kelly_sweep 网格

> 两条「训练/扫描」链路。labels 把参数随 scheme 串穿透；kelly 把 4 参数作为**扫描维度**
> （候选集笛卡尔积），并解决网格爆炸。路径前缀 `apps/quant-pipeline/src/quant_pipeline/`。

## 一、labels 链路（scheme 串 = 单一真值）

### 1.1 参数流

```text
job.params { base_type:'band_lock',
             base_params:{max_hold, stop_ratio, floor_ratio, floor_enabled, ma5_require_down},
             date_range }
        │  _resolve_*  (labels/runner.py:800-867)
        ▼  base_scheme_codec('band_lock', base_params) → canonical_band_lock_scheme(02)
   scheme = 'band_lock__...'   ← 单一真值（往返可复现）
        │  compute_labels(scheme=, date_range=)  (runner.py:483)
        ▼  band_lock 分支: params = parse_band_lock_scheme(scheme)   ← 解码回 dict
   compute_band_lock_labels(scheme=scheme, **params)  (band_lock_labels.py:186)
        ▼
   simulate_band_lock(bars, signal_high, max_hold=, stop_ratio=, floor_ratio=,
                      floor_enabled=, ma5_require_down=)
```

### 1.2 落点

| 文件 | 改造 |
|------|------|
| `labels/runner.py:69-76` | 删 `_BAND_LOCK_MH_RE` 手写正则；改用 `band_lock_scheme.is_band_lock_scheme` / `parse_band_lock_scheme`。|
| `labels/runner.py:533-552` | band_lock 分支：`parse_band_lock_scheme(scheme)` 拿全部 params（含 max_hold），替代仅解析 mh。畸形 scheme → 既有「未知 scheme」ValueError。|
| `labels/runner.py:560-564` | `head_pad = MA_WINDOW-1` **不变**（MA5 窗口未放开；`ma5_require_down` 不影响 MA5 计算/预热）。|
| `labels/runner.py:850-867` | job params：把 `stop_ratio`/`floor_ratio`/`floor_enabled`/`ma5_require_down` 并入 `base_params`，统一经 `base_scheme_codec` 编码进 scheme（不再单独透传 `band_lock_max_hold`，max_hold 也并入 base_params 走 scheme，消除现状双路径重复）。|
| `labels/runner.py:687-708` | `compute_band_lock_labels(...)` 调用补 4 个解析出的 params（替代仅 `max_hold=`）。|
| `labels/band_lock_labels.py:186-208` | `compute_band_lock_labels` 签名加 `stop_ratio/floor_ratio/floor_enabled/ma5_require_down`（默认=现状），`:357-359` 调核处透传。`_ensure_ma5` 不变。|

> 向后兼容：`scheme='band_lock'` parse → 全默认 → 与现状逐字一致；`'band_lock__mh10'` → 仅 max_hold=10 → 与现状一致。`feature_set_id` 哈希因 02 的 canonical 回 legacy 而不漂移。

## 二、kelly 核调用（`research/kelly_sweep/exits.py`）

`simulate_band_lock_exit`（现 `:319-323` `(path, *, max_hold=None)`）扩展 4 参数，透传给核（`:376`）：

```python
def simulate_band_lock_exit(path, *, max_hold=None,
        stop_ratio=0.999, floor_ratio=0.999,
        floor_enabled=True, ma5_require_down=True):
    ...
    outcome = simulate_band_lock(core_bars, path.signal_bar_high,
        max_hold=max_hold, stop_ratio=stop_ratio, floor_ratio=floor_ratio,
        floor_enabled=floor_enabled, ma5_require_down=ma5_require_down)
```

`_to_band_lock_bar`（`:305`）、退市/窗口耗尽收口（`:362-419`）逻辑不变。

## 三、kelly 网格收敛（`research/kelly_sweep/sweep.py`）

### 3.1 候选集 → 笛卡尔积（默认单值 = 退化成现状）

```text
band_lock 网格 = max_hold × stop_ratio × floor_ratio × floor_enabled × ma5_require_down

默认候选集（不传 = 今天）:
  max_hold:[None,10,20]  stop_ratio:[0.999]  floor_ratio:[0.999]
  floor_enabled:[true]   ma5_require_down:[true]
  ⇒ 3×1×1×1×1 = 3 个 cfg，与现状 DEFAULT_EXIT_GRID(:121-122) 逐一致

扫止损系数: stop_ratio:[0.997,0.998,0.999] ⇒ 3×3 = 9，可控
```

### 3.2 依赖坍缩去重

```text
floor_enabled 候选含 false 时：
  · floor_enabled=true  分支：正常展开 floor_ratio 候选
  · floor_enabled=false 分支：floor_ratio 不影响结果 → 不展开 floor_ratio 候选（取占位默认 0.999）
  → 按「有效参数指纹」去重：
     指纹 = (max_hold, stop_ratio, ma5_require_down, floor_enabled,
             floor_enabled ? floor_ratio : None)   ← false 时 floor_ratio 从指纹剔除

双维例: floor_enabled:[T,F] × floor_ratio:[0.998,0.999] × max_hold:[None]
   → T+0.998 / T+0.999 / F(floor_ratio剔除) = 3 个（非 4）
```

### 3.3 落点

| 文件/函数 | 改造 |
|-----------|------|
| **新增** `build_band_lock_grid(max_hold_list, stop_ratio_list, floor_ratio_list, floor_enabled_list, ma5_require_down_list)` | 笛卡尔积 + 3.2 坍缩去重；各参数默认候选集 = 上表。返回 `[{type:'band_lock', max_hold, stop_ratio, floor_ratio, floor_enabled, ma5_require_down}, ...]`。|
| `DEFAULT_EXIT_GRID` `:121-122` | **不动**（仍 3 个，只含 `max_hold`）。`_run_exit` 用 `.get(k, 默认)` 兜底缺失字段 → 现状 cfg 零漂移。|
| `_exit_id` `:284-286` | 全默认 → **id 不变**（`band_lock(mh=X)`，守现存结果可比对）；非默认参数按固定顺序 sr→fr→fl→md 追加，**fr 省略规则与坍缩指纹同口径**：`fl=1`(默认)且 fr 非默认 → 含 fr（如 `band_lock(mh=10,fr=1.020)`）；`fl=0` → 省 fr（如 `band_lock(mh=10,fl=0,md=0)`）。保证唯一、无碰撞。|
| `_run_exit` `:314-319` | band_lock 分支透传 `stop_ratio/floor_ratio/floor_enabled/ma5_require_down`（`exit_cfg.get(k, 默认)`）。|
| `build_exit_grid` `:133-159` | 不变（仍按 family 过滤 DEFAULT）；自定义候选集走新 `build_band_lock_grid` 注入。|

### 3.4 网格爆炸护栏（不静默截断）

- 复用 `_COMBO_WARN_THRESHOLD=5000`（`:125`，总组合 warn，`:694-699`）。
- `build_band_lock_grid` 内：band_lock 族 cfg 数 **> 200** → `logger.warning`（含各维度候选数），不拒绝、不截断（尊重用户意图，遵 data-integrity「no silent caps」）。

## 四、kelly runner（`worker/kelly_sweep_runner.py`）

- 现状从 `job.params.get("exit_families", [...])`（默认四族不含 band_lock）取族 → `build_exit_grid`。
- 新增：读 `job.params.band_lock_grid`（各维度候选集 dict）。若提供 → `build_band_lock_grid(**candidates)`
  生成 band_lock 部分，与其它族 `build_exit_grid` 结果**合并** → `run_sweep(exit_grid=合并)`
  （`run_sweep` `sweep.py:639/663` 已支持注入自定义 exit_grid）。
- 若未提供 band_lock_grid 但 families 含 band_lock → 用 DEFAULT 的 3 个（现状）。

## 五、kelly 前端候选集编辑器

主表单 `apps/web/src/views/quant/kelly-sweep/KellySweepConfigForm.vue`（受 `lint:quant-lines` ≤500 行强制）
→ 候选集编辑器拆**独立子组件** `apps/web/src/components/quant/kelly-sweep/BandLockGridEditor.vue`。

```text
┌─ 波段跟踪止损 出场维度（仅当出场族勾选 band_lock 时展开）──────┐
│ 最长持有 max_hold   [None] [10] [20]            (+ 增 / × 删)  │
│ 止损缓冲系数        [0.999]                      (+ 增 / × 删)  │
│ 成本地板系数        [0.999]                      (+ 增 / × 删)  │
│ 启用成本地板        [✓ true] [  false ]          (多选)         │
│ MA5 需下行才离场    [✓ true] [  false ]          (多选)         │
│ ───────────────────────────────────────────────────────────── │
│ 预估：将生成 9 个 band_lock 出场配置  ⚠(>100 黄字提醒)          │
└────────────────────────────────────────────────────────────────┘
```

- 每个数值维度：可增删的多值输入（默认单值=现状）；布尔维度：true/false 多选框。
- **实时网格规模预估**：前端按 3.1/3.2（含坍缩）算笛卡尔积大小并显示；超软阈值（如 100）黄字提醒。
- 提交：拼成 `band_lock_grid` job param。
- 出场族未勾 band_lock 时编辑器隐藏（`v-if`）。

## 六、验证点（进 06）

- 默认候选集 `build_band_lock_grid()` == 现状 3 个 cfg（exit_id 不变）。
- 坍缩去重：`floor_enabled:[true,false] × floor_ratio:[0.998,0.999]` → 不是 4 个而是 3 个（false 分支只 1 个）。
- labels：`scheme='band_lock'` 重算结果与现状逐位一致；非默认 scheme 真机 CLI 跑通。
- kelly：自定义 band_lock_grid 跑通，结果行数 = 预估网格数 × 入场变体数。
