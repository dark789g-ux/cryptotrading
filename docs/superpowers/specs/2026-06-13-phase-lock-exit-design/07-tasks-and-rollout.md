# 07 · SDD 任务切分、依赖序、迁移、验收

[← index](./index.md)

## 任务域（按互不相交文件域切分，避免并行 agent 撞车）

```text
foundational（先行）
├─ D1 Python 纯函数核                      [全新文件，零依赖]
│   strategy/phase_lock_exit.py
│   tests/unit/test_phase_lock_exit.py          ← S1~S15 数值权威源
└─ D6 共享类型 + 实体 + 迁移               [edit/新增，零跨域依赖]
    entities/strategy/signal-test.entity.ts (+phase_lock_params jsonb, exitMode 加 'phase_lock')
    migrations/20260613_add_phase_lock_params_to_signal_test.sql + .ps1
    (packages/shared-types：phase_lock 无需进 ExitRuleType；如有 kelly 共享类型按需)

并行第二批（依赖 D1 / D6）
├─ D2 signal-stats TS（依赖 D1 数值 + D6 实体/DTO 列）
│   signal-stats.simulator.ts (decidePhaseLock + ExitConfig + dispatch + exitReason)
│   signal-stats.simulator.db.ts (左扩 max(5,lookback) + recentLows)
│   dto/create-signal-test.dto.ts (exitMode 'phase_lock' + 扁平参数) + service 校验
│   signal-stats.phase-lock.spec.ts (镜像 D1 数值)
│   apps/web signalStats.ts + signal-stats 表单 vue
├─ D3 labels（依赖 D1）
│   labels/phase_lock_exit 调用方: phase_lock_labels.py + phase_lock_scheme.py
│   labels/runner.py (phase_lock 独立分支, 左扩传 max(5,lookback))
│   tests: test_phase_lock_labels.py / test_phase_lock_scheme.py
├─ D4 kelly Python（依赖 D1 + D3 的 phase_lock_scheme.quantize）
│   research/kelly_sweep/exits.py (simulate_phase_lock_exit)
│   research/kelly_sweep/sweep.py (_KNOWN_EXIT_FAMILIES/build_phase_lock_grid/_run_exit/_exit_id)
│   worker/kelly_sweep_runner.py (_build_exit_grid_from_params 读 phase_lock_grid)
│   tests: test_kelly_phase_lock_exit.py
└─ D5 kelly NestJS + web（依赖 D6；运行期依赖 D4）
    modules/quant/dto/create-job.dto.ts (确认 phase_lock_grid 透传放行)
    api/modules/quant/kellySweep.ts (PhaseLockGrid 类型)
    views/quant/kelly-sweep/KellySweepConfigForm.vue + KellySweepView.vue (开关/清理)
    components/quant/kelly-sweep/PhaseLockGridEditor.vue (新建)
```

### 文件域不相交性核对

- D1：仅 `strategy/phase_lock_exit.py` + 其测试（全新）。
- D2：仅 `signal-stats/**`（TS）+ `apps/web` signal-stats 表单/api。
- D3：仅 `labels/**`（Python，phase_lock_* 新文件 + runner.py 编辑）。
- D4：仅 `research/kelly_sweep/**` + `worker/kelly_sweep_runner.py`。
- D5：仅 `modules/quant/**`（kelly DTO）+ `apps/web` kelly-sweep。
- D6：仅 `entities/strategy/signal-test.entity.ts` + `migrations/**`。

唯一潜在交叉：**D2 与 D6 都碰** `signal-test.entity.ts` 的 `exitMode` 列 / DTO 与实体的耦合。
解法：**D6 先完成实体 + 迁移 + exitMode 枚举值**，D2 再在其上加 DTO/service/simulator。故 D6 列入 foundational 先行批，D2 在第二批。

## 依赖序

```text
D1 ─┬─▶ D3 ─▶ D4 ─┐
    │              ├─▶ (运行期 e2e)
    └─▶ D2         │
D6 ─┬─▶ D2         │
    └─▶ D5 ────────┘
```

- **D1 先行**：D2/D3/D4 都依赖纯函数核语义；D1 的对拍 fixture 是 D2 数值源头。
- **D6 先行**：D2 的 DTO/实体、D5 的前端类型依赖列与枚举值就位。
- D3 → D4：D4 复用 `phase_lock_scheme.quantize_phase_lock_params`（D3 产物）。
- 第二批 D2/D3/D4/D5 文件域不相交，可并行。

> **SDD 派发约束**（来自 brainstorming 规范）：派 agent **不**用 `isolation: worktree`；靠本 spec 的文件域切分从源头避免覆盖。冲突管理由 spec 负责。

## 迁移执行

```powershell
# 迁移文件就位后（镜像 band_lock 配对）
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "ALTER TABLE signal_test ADD COLUMN IF NOT EXISTS phase_lock_params jsonb;"
# 或跑配对 .ps1
```

`IF NOT EXISTS` 幂等；新列默认 NULL，存量零漂移。

## 哈希守门 checklist

- [ ] 全默认 `phase_lock` params → canonical 串 `'phase_lock'`（非展开串）。
- [ ] `phase_lock_scheme` 默认常量 == `phase_lock_exit.py` 默认（同一事实两副本，测试锁住）。
- [ ] kelly `DEFAULT_EXIT_GRID` **未**追加 phase_lock 默认 cfg（全新族，避免污染现存默认扫描 / 哈希）。
- [ ] 跑 band_lock 既有对拍 + scheme 测试，确认 phase_lock 引入零回归。

## 验收（汇总自 [06 验证标准](./06-fixtures-and-testing.md#验证标准)）

1. Python/TS 对拍 S1~S15 全绿（含 S3/S7/S15 区分点）。
2. 四道门禁全绿（server build / web type-check / lint:quant-lines / pytest）。
3. 真机 e2e：signal-stats / kelly / labels-job 三方各跑通（后端改动**重启** server/worker 后验）。
4. 哈希守门 checklist 全勾；存量零漂移。

## 提交规范（建议分层 commit，对齐用户偏好）

按子系统分多个语义清晰 commit（用户偏好分层 commit）：

- `feat(quant): phase_lock 出场纯函数核 + scheme 编解码器`（D1+D3 scheme）
- `feat(quant): phase_lock labels 模块 + runner 路由`（D3）
- `feat(quant): phase_lock kelly 扫描族 + runner 透传`（D4）
- `feat(server): signal-stats 接入 phase_lock 出场 + 迁移`（D2+D6）
- `feat(web): kelly-sweep / signal-stats phase_lock 前端`（D2/D5 前端）

> 本仓约定：spec 文档本身用 `docs(quant): phase_lock 出场设计`。
