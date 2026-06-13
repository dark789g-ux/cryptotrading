# 06 · 主样例对拍表 + 测试落点 + 验证标准

[← index](./index.md) · 算法见 [01](./01-algorithm.md)

## 对拍纪律（硬约束）

Python `test_phase_lock_exit.py`（D1）与 TS `signal-stats.phase-lock.spec.ts`（D2）必须对**同一组场景**断言**逐数值一致**的结果（`kind/reason/exit_index/exit_price/hold_days/locked`）。

> **数值源头 = D1**：本表给**场景设计**（输入序列 + 期望定性结果 + 出场价公式），但**精确出场价由 D1 先实现并跑出、提交为权威 fixture**；D2 镜像 D1 已提交的数值，**不**从本表自行手算（避免 spec 手算误差被双份复制）。这是 [07 任务依赖](./07-tasks-and-rollout.md#依赖序)中 D2 fixture 依赖 D1 的原因。

约定：`lookback=3`、`init_factor`/`lock_factor` 见各场景；价格用整洁数避免浮点歧义；`cost = T+1 复权 open`。`recent_lows` = 含 T+1 的最近 3 个非停牌复权 low（升序）。

## 主场景表（设计）

| ID | 场景 | 关键输入 | 期望 reason | 期望要点 |
|----|------|----------|-------------|----------|
| S1 | 阶段A盘中止损 | recent_lows=[10.0,9.8,9.5], if=1.0 → init_stop=9.50；T+2 low=9.4, open=9.6 | `phase_lock_stop` | exit_index=1, price=floor2(min(9.50,9.60))=9.50, hold=1, locked=false |
| S2 | 阶段A跳空低开止损 | 同 S1；T+2 open=9.30(<stop), low=9.20 | `phase_lock_stop` | price=min(9.50,9.30)=9.30（取开盘价） |
| S3 | **阶段A止损固定不上移（关键差异）** | init_stop=9.50；T+2 涨(low=10.5,close≤MA5 未锁)；T+3 low=9.6(>9.50,介于T+2低与init之间) | `no_exit`(或后续) | 证明 stop 仍=9.50 未跟随 T+2 抬升；T+3 不止损（band_lock 会因 trailing 出场，phase_lock 不会） |
| S4 | 阶段切换 + 次日生效 | T+2 close>MA5 且 MA5>prevMA5 → lock；新 stop=floor2(MAX(cost,T+2 low)×lf) | — | locked=true；切换当日不出场；新 stop 自 T+3 盘中生效 |
| S5 | 阶段B止损 | S4 后 T+3 low ≤ 锁定 stop | `phase_lock_stop` | price=min(stop, T+3 open) |
| S6 | 阶段B MA5清仓 | S4 后 T+k close<MA5 且 MA5<prevMA5 | `phase_lock_ma5` | exit price=该日 close；优先级低于盘中止损 |
| S7 | 同日止损优先于MA5 | 阶段B某日 low≤stop **且** close<MA5↓ | `phase_lock_stop` | 出止损不出 MA5（当日不评估收盘） |
| S8 | 不足lookback根降级 | T+1 为次新股，仅 2 根可用，lookback=3 | 视后续 | init_stop=floor2(min(2根低)×if)，不 no_entry |
| S9 | 停牌跨越 | 持仓中插一个停牌 bar | 视后续 | 停牌日不计 hold、不动 stop、不动 prev_ma5 |
| S10 | 封死跌停顺延（止损） | 止损应触发当日 raw_high≤down_limit | `phase_lock_stop` | pending→次个非封死跌停日 open 出场 |
| S11 | 封死跌停顺延（MA5） | 阶段B MA5清仓应触发当日封死跌停 | `phase_lock_ma5` | pending→次个非封死跌停日 open 出场 |
| S12 | 涨停开盘不入场 | T+1 raw_open ≥ up_limit | `no_entry`/`limit_up` | kind=no_entry |
| S13 | 窗口耗尽 | 全程不触止损/不锁/不清仓 | `no_exit` | exit_index=None |
| S14 | 两个独立factor生效 | if=0.98, lf=1.005 | — | init_stop 用 0.98；锁定 stop 用 1.005；互不串用 |
| S15 | 切换当日盘中先止损 | T+2 盘中 low≤init_stop **且**若不止损则会满足切换条件 | `phase_lock_stop` | 止损优先，当日不锁定（locked=false） |

> 实现 D1 时为每个场景补全完整 `bars` 序列（OHLC/ma5/限停板/停牌）与精确期望数值，确保覆盖上述定性要点；S3/S7/S15 是与 band_lock 区分的核心回归点，必须有。

## 测试落点

### Python（pytest，新建）

| 文件 | 覆盖 |
|------|------|
| `tests/unit/test_phase_lock_exit.py` | 主场景 S1~S15（**数值权威源**）+ 边界 |
| `tests/unit/test_phase_lock_scheme.py` | canonical 串 / 默认回 legacy `'phase_lock'` / 量化 round-half-up / 畸形拒绝 / 顺序校验 |
| `tests/unit/test_phase_lock_labels.py` | recent_lows 切片 / 左扩 max(5,lookback) / 不足根降级 / 停牌跳过 |
| `tests/unit/test_kelly_phase_lock_exit.py` | `simulate_phase_lock_exit` 适配层 + `build_phase_lock_grid` 默认 48 组 / 去重 / 护栏 / `_exit_id` 格式 |

### TS（vitest，新建/编辑）

| 文件 | 覆盖 |
|------|------|
| `signal-stats.phase-lock.spec.ts`（新建） | **镜像 D1 S1~S15 逐数值** + `simulateTradeCore` phase_lock 分支 + 左扩/recentLows |
| `create-signal-test.dto`/service spec（编辑） | phase_lock 三参数校验、误送其它模式拒绝(400) |
| kelly DTO/前端校验 spec（按需） | `phase_lock_grid` 透传、估算组合数 |

## 验证标准

1. **对拍绿**：`test_phase_lock_exit` 与 `phase-lock.spec` 同组 S1~S15 全过，含 S3/S7/S15 区分点。
2. **门禁全绿**：
   - `pnpm --filter @cryptotrading/server build`
   - `pnpm --filter @cryptotrading/web type-check`
   - `pnpm --filter @cryptotrading/web lint:quant-lines`
   - quant-pipeline pytest（phase_lock 全部 + 不破坏 band_lock 既有）
3. **真机 e2e**（后端改动须**重启** server/worker 后验）：
   - signal-stats 选 phase_lock 模式跑一段真实 A 股信号，胜率/盈亏比/直方图正常、出场原因含 phase_lock_stop/phase_lock_ma5；
   - kelly 勾选 phase_lock 跑一次网格，结果落 research 表，`_exit_id` 含 `phase_lock(...)`；
   - labels-job 用 phase_lock scheme（全默认 + 一个非默认变体）跑通，写 `factors.labels`。
4. **哈希守门**：全默认 scheme = `'phase_lock'`（legacy 别名）；**不触发**任何既有 band_lock / 其它 `feature_set_id` 漂移（跑 band_lock 既有对拍与 scheme 测试确认零回归）。
5. **存量零漂移**：`phase_lock_params` 列默认 NULL；既有 signal_test / labels 行不受影响。
