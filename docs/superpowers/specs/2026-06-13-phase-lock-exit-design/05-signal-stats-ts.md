# 05 · signal-stats TS 同构 + DTO + 实体 + 前端

[← index](./index.md) · 算法见 [01](./01-algorithm.md) · 对拍样例见 [06](./06-fixtures-and-testing.md)

涵盖 **D2**（signal-stats 全链路 TS）与 **D6 的实体/迁移部分**（任务归属见 [07 任务域](./07-tasks-and-rollout.md)）。
镜像对象：`signal-stats.simulator.ts` `decideBandLock` / `signal-stats.simulator.db.ts` /
`dto/create-signal-test.dto.ts` / `entities/strategy/signal-test.entity.ts` / 前端 signal-stats 表单。

## decidePhaseLock 纯函数核（D2）

**编辑** `apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.ts`：

1. 新增 `PhaseLockOptions` 接口：`{ initFactor: number; lockFactor: number; lookback: number }`。
2. 新增 `decidePhaseLock(bars: HoldingDaySnapshot[], recentLows: number[], opts: PhaseLockOptions): ExitDecision`，**逐行镜像 Python `simulate_phase_lock`**（[01 逐 bar 算法](./01-algorithm.md#逐-bar-算法伪代码基于精确化语义)）。
   - `floor2(x) = Math.floor(x*100)/100`（复用现有 `floor2`，与 Python 逐位一致）。
   - 字段映射（与 band_lock 现状一致）：`adj_open→qfqOpen`、`adj_high→qfqHigh`、`adj_low→qfqLow`、`adj_close→qfqClose`、`raw_open→rawOpen`、`raw_high→rawHigh`、`up_limit→upLimit`、`down_limit→downLimit`、`ma5→ma5`。
3. `ExitConfig` 联合（127-141 行，**现状为 `fixed_n | strategy | trailing_lock`**）新增 variant：`{ mode: 'phase_lock'; initFactor; lockFactor; lookback }`。
4. `simulateTradeCore` dispatch（simulator.ts:195-213）**现状为 `if fixed_n / else if strategy / else(trailing_lock 兜底)`**——trailing_lock 走最后的 `else` 兜底（:199，**非**显式 `=== 'trailing_lock'`）。新增 phase_lock 须先把该 `else` **改为显式** `else if (exit.mode === 'trailing_lock')`，再加 `else if (exit.mode === 'phase_lock') { decision = decidePhaseLock(...) }`——否则 phase_lock 会落进 trailing_lock 兜底分支而**不可达**。
5. `SimulatedTrade.exitReason`（33 行）类型新增 `'phase_lock_stop' | 'phase_lock_ma5'`。

## 数据层 recentLows 组装（D2）

**编辑** `signal-stats.simulator.db.ts`：

- 现状 `attachMa5`（368-383 行）在非停牌 `qfqClose` 序列上滚动算 MA5，窗口左扩。phase_lock 需把左扩根数提到 `max(5, lookback)`。
- 新增：从左扩窗口切 `recentLows`（含 T+1 的最近 `lookback` 个非停牌 `qfqLow`，升序），传给 `decidePhaseLock`。
- `signalHigh` 现状已左扩预取（192-195 行）——phase_lock 不需要 `signalHigh`，但 lookback 左扩要确保覆盖。

## DTO（D2）

**编辑** `dto/create-signal-test.dto.ts`：

1. `exitMode` 联合（27 行）新增 `'phase_lock'`，补 JSDoc：
   > `phase_lock`：两阶段锁定止损（初始止损固定 → 收盘站上 MA5↑ 锁定上移 → 阶段 B 收盘破 MA5↓ 清仓 + 跌停顺延）；无 horizonN、无 exitConditions、无 maxHold。
2. 新增 3 个**扁平可选**参数（仅 `exitMode='phase_lock'` 可送，误送其它模式 → 400）：

```ts
/** 初始止损系数（仅 phase_lock）。留空=0.999；量化到 0.001。 */
initFactor?: number;
/** 锁定止损系数（仅 phase_lock）。留空=0.999；量化到 0.001。 */
lockFactor?: number;
/** 初始止损回看根数（仅 phase_lock）。留空=10；正整数。 */
lookback?: number;
```

3. service 层校验（fail-fast，对齐 band_lock 现状）：phase_lock 模式下三参数可选、量化校验；其它模式误送 phase_lock 参数 → 400。

## 实体 + 迁移（D6，此处列接口，任务归属见 07）

**编辑** `entities/strategy/signal-test.entity.ts`：

1. `exitMode` 列类型（28 行）联合新增 `'phase_lock'`（varchar(16) 无 CHECK，新枚举值无需迁移）。
2. 新增 `phase_lock_params` jsonb nullable 列（镜像 `band_lock_params`，43-49 行）：

```ts
/** phase_lock 额外参数（仅 phase_lock）；null = 全默认（存量行零漂移）。
 *  存入已量化（round-half-up 到 0.001）的网格点；runner 直接透传给核。 */
@Column({ type: 'jsonb', nullable: true, name: 'phase_lock_params' })
phaseLockParams: { initFactor: number; lockFactor: number; lookback: number } | null;
```

**新建迁移** `apps/server/migrations/20260613_add_phase_lock_params_to_signal_test.sql` + 同名 `.ps1`（镜像 `20260613_add_band_lock_params_to_signal_test.*`）：

```sql
ALTER TABLE signal_test ADD COLUMN IF NOT EXISTS phase_lock_params jsonb;
```

`.ps1` 内置 `docker exec crypto-postgres psql -U cryptouser -d cryptodb -f ...`（对齐现有 migration 配对模式）。

> **schema 变更走 migration**（`synchronize:false`）。新列默认 NULL，存量行零漂移。

## 前端 signal-stats 表单（D2）

**编辑** `apps/web/src/api/modules/strategy/signalStats.ts`：`SignalTestExitMode`（9 行）新增 `'phase_lock'`，补对应可选参数字段类型。

**编辑** signal-stats 创建表单 Vue（出场模式下拉所在组件，从 `signalStats.ts` 消费方追踪）：

- 出场模式下拉新增"phase_lock（两阶段锁定止损）"选项；
- 选中时展开 3 个参数输入（initFactor / lockFactor / lookback，带默认 placeholder 0.999/0.999/10）；
- 复用 trailing_lock 现有参数输入区的样式/校验风格。

> 具体表单组件路径在实现期由 `SignalTestExitMode` 与 `exitMode` 的消费点定位（与 trailing_lock 选项同处）；受 `lint:quant-lines` 约束，注意行数。

## D2 TS 测试

见 [06 测试落点](./06-fixtures-and-testing.md#测试落点)。要点：
- `signal-stats.phase-lock.spec.ts` — **镜像 D1 `test_phase_lock_exit.py` 的逐数值期望**（D2 依赖 D1 已提交的 fixture 数值）。
- `create-signal-test.dto`/service 校验 spec — phase_lock 参数校验、误送拒绝。
