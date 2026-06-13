# 06 · 测试、零漂移验证、分层发布

> 全设计的验证收口。最高优先级始终是「默认参数 = 现状逐位一致」（零漂移），其次才是新参数行为正确。

## 一、零漂移验证矩阵（必须全绿才算合格）

| 模块 | 验证 | 判据 |
|------|------|------|
| 共享核 | S1~S13 用**默认参数**重跑 | Python/TS 输出与改造前 byte-identical，两侧仍逐位对拍 |
| scheme codec | `canonical_band_lock_scheme({})` / `({max_hold:10})` | 逐字 == `'band_lock'` / `'band_lock__mh10'` |
| scheme codec | 往返 | `parse(canonical(p)) == quantize(p)`，畸形串 → `None` |
| labels | `scheme='band_lock'` 重算 | 与现状 DB 同区间标签逐位一致；`feature_set_id` 哈希不变 |
| kelly | `build_band_lock_grid()` | == 现状 3 个 cfg，且 `_exit_id` 字符串不变 |
| signal-stats | `band_lock_params=null` 方案 run | 结果与改造前一致（migration 后存量行零漂移） |

## 二、单元测试清单

### Python（`pytest`，quant-pipeline `.venv`）

| 测试 | 覆盖 |
|------|------|
| 核扩展对拍 S14~S19 | [03 §4.2](./03-shared-core.md#42-新参数边界样例每个-pythonts-双跑--对拍) 各参数边界，Python 侧 |
| 核默认回归 | S1~S13 默认参数 == 现状（与现有对拍夹具同源） |
| `band_lock_scheme` 三件套 | quantize 范围校验/越界 raise；canonical 默认回 legacy；parse 往返 + 畸形→None |
| 量化跨语言一致 | 中点值（0.0005/0.9985/0.9995）`math.floor(r*1000+0.5)` 与 TS `Math.round(r*1000)` 产出同 NNNN（守对拍逐位） |
| `build_band_lock_grid` | 默认 == 3 cfg；坍缩去重（`fl:[T,F]×fr:[.998,.999]`→3 非 4）；护栏 warn |
| `simulate_band_lock_exit` 透传 | 非默认参数改变 ret（与核直算一致） |
| labels 端到端（小样本） | 非默认 scheme 产出标签 + scheme 列正确落库 |

### TS（`jest`：`pnpm --filter @cryptotrading/server exec jest signal-stats`）

| 测试 | 覆盖 |
|------|------|
| `decideBandLock` S14~S19 | 与 Python 同样例逐位一致（对拍夹具同源）|
| `decideBandLock` 默认回归 | 不传新参数 == 现状 |
| `validateDto` | stopRatio∈(0,1]、floorRatio∈(0,9.999]、布尔校验、非 trailing_lock 误送→400 |

### 前端

- `vite build`（**不只 type-check**，见 vue3-frontend 规则）+ `lint:quant-lines`（kelly 子组件 ≤500 行）。
- 可选 vitest：网格规模预估函数（笛卡尔积 + 坍缩）纯函数单测。

## 三、真机 e2e（改后端必先重启进程，dev 无 watch）

| 链路 | 步骤 |
|------|------|
| signal-stats | ① 建**全默认** trailing_lock 方案 → run → 结果与旧方案一致（零漂移）；② 建非默认（`stopRatio=0.997, floorEnabled=false, floorRatio=1.02`）→ run → 手算 2~3 笔（stop / 锁盈地板拦截 / 无地板跌破成本）逐位吻合；③ 非 trailing_lock 误送 4 字段 → 400 |
| labels | CLI/job 跑 `band_lock__sr0997__md0` → 标签产出非空、`factors.labels.scheme` 落该串、parse 往返自洽 |
| kelly | 前端配 `band_lock_grid`（stop_ratio 3 值 × floor_enabled [T,F]）→ run → 结果行数 = 预估网格 × 入场变体；坍缩生效（无等价重复 exit_id）；top-K 可解读 |

## 四、分层提交计划（按子系统，feedback_layered_commits）

```text
1. feat(quant): band_lock 共享核参数化 + scheme codec + 对拍样例
     band_lock_exit.py / signal-stats.simulator.ts / 新 band_lock_scheme.py
     / dir3_scheme.py codec 分支 / S14~S19 + TS 对拍
2. feat(quant): band_lock labels 参数透传（scheme 单一真值）
     labels/runner.py / band_lock_labels.py / 单测
3. feat(quant): kelly_sweep band_lock 扫描维度（网格收敛 + 坍缩 + 护栏）
     kelly_sweep/exits.py / sweep.py(build_band_lock_grid) / kelly_sweep_runner.py / 单测
4. feat(web): kelly band_lock 候选集编辑器
     KellySweepConfigForm.vue / 新 BandLockGridEditor.vue
5. feat(server): signal-stats band_lock 参数（DTO+校验+entity+migration）
     create-signal-test.dto.ts / signal-stats.service.ts / signal-test.entity.ts
     / migrations/20260613_add_band_lock_params_to_signal_test.sql + .ps1
6. feat(web): signal-stats 波段止损参数表单控件
     SignalTestForm.vue
7. docs(prompts/specs): 波段止损参数化设计 spec
```

> 提交顺序：1（核+codec）是 2/3/5 的依赖，先合；migration（5）合并前先在本地 DB 跑 `.ps1` 验证。
> 各层均「测试绿 + 该层 e2e 点过」再提交。

## 五、Backlog（本次明确不做，留痕可追溯）

- **MA5 离场窗口（现 5）放开**：signal-stats 可（TS 内存滚动），但 labels/kelly 直接吃 DB 固定
  `raw.daily_indicator.ma5`（5 日）/ `_ensure_ma5`（5）；放开须 Python 弃 DB 列自算 + 重核复权基。
- **首日方案一/二切换阈值（现 收盘>开盘）放开**：动初始止损算法内核，回归风险高。
- **kelly 前端网格规模硬上限/二次确认**：当前只软提醒（黄字），未来可加「>N 需确认」交互。
- **floorRatio 锁盈语义**：UI 中文标签是否随 >1 动态提示「锁盈地板」可后续打磨。

## 六、关键风险与对策

| 风险 | 对策 |
|------|------|
| 两套核漂移（对拍崩） | 默认回归 S1~S13 + 新样例 S14~S19 双跑，CI 守门 |
| ratio 浮点跨模块不一致 | 统一量化到 0.001 网格（[03 §3](./03-shared-core.md#三浮点一致性跨模块对拍的隐形地雷)）|
| 现存 band_lock 标签哈希漂移 | scheme 默认 canonical 回 legacy（[02](./02-scheme-codec.md)）+ 哈希不变验证 |
| kelly 网格爆炸 | 候选集默认单值 + 坍缩去重 + 护栏 warn + 前端实时预估 |
| migration 误伤存量 signal_test | nullable 无 DEFAULT，读 null → 全默认（零漂移）|
| 前端 SFC 编译错（type-check 漏） | 合并前 `vite build` + 真机点开页面 |
