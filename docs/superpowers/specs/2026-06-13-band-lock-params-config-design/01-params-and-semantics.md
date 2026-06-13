# 01 · 参数定义与对共享核的精确语义

> 本文是地基：钉死 4 个参数的取值范围、默认值、依赖关系，以及它们**精确控制共享核的哪几行**。
> 所有 file:line 已对照 2026-06-13 代码核实。Python 核 = `strategy/band_lock_exit.py`，
> TS 核 = `apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.ts`。

## 一、参数总表

| 字段（英文）      | 类型   | 默认  | 后端硬校验范围      | 备注 |
|-------------------|--------|-------|---------------------|------|
| `stopRatio`       | number | 0.999 | `[0.001, 1.0]`（量化后 NNNN∈[1,1000]）| 量化到 0.001 网格（见 02）|
| `floorRatio`      | number | 0.999 | `[0.001, 9.999]`（允许 > 1）| `>1` 从「保本」变「锁盈」；量化到 0.001；上界来自 02 §3.1 四位定宽 |
| `floorEnabled`    | bool   | true  | —                   | — |
| `ma5RequireDown`  | bool   | true  | —                   | — |

**依赖**：`floorRatio` 仅在 `floorEnabled=true` 时生效。
- 前端：`floorEnabled=false` 时 `floorRatio` 输入置灰。
- kelly 网格：`floorEnabled=false` 分支不展开 `floorRatio` 候选（坍缩去重，见 05）。
- 核计算：`floorEnabled=false` 时 `floorPrice` 不参与，等价于「方案二也不设地板」。

## 二、参数 → 共享核控制点（精确映射）

```text
                       simulate_band_lock / decideBandLock
   ┌──────────────────────────────────────────────────────────────┐
   │ 初始止损(持仓首日设)                                            │
   │   方案一: floor2(open × stopRatio)      ← stopRatio  [Py139/TS396]│
   │   方案二: floor2(low  × stopRatio)      ← stopRatio  [Py143/TS400]│
   │   地板价: floor2(cost × floorRatio)     ← floorRatio [Py151/TS408]│
   ├──────────────────────────────────────────────────────────────┤
   │ 逐日推进                                                        │
   │   保本地板激活(scheme2 & close>cost)    ← floorEnabled门控[Py200/TS465]│
   │   锁定触发(low>signalHigh):                                     │
   │     stopNext=floor2(low×stopRatio)      ← stopRatio  [Py205/TS471]│
   │     if floorEnabled&active: max(.,地板) ← floorEnabled[Py206/TS472]│
   │   锁定后 MA5 离场:                                              │
   │     close<ma5  (恒判)                                          │
   │     AND ma5<prevMa5  ← ma5RequireDown 门控 [Py217/TS485]        │
   │   未锁定每日:                                                   │
   │     stopNext=floor2(low×stopRatio)      ← stopRatio  [Py235/TS503]│
   │     if floorEnabled&active: max(.,地板) ← floorEnabled[Py236/TS504]│
   └──────────────────────────────────────────────────────────────┘
```

### 2.1 `stopRatio` —— 覆盖 4 处止损基准 ×0.999

四处语义都是「基准价向下留缓冲」，统一为一个参数：

| 处 | Python | TS | 现表达式 → 改后 |
|----|--------|----|----------------|
| 方案一初始 | `band_lock_exit.py:139` | `:396` | `floor2(adj_open*0.999)` → `floor2(adj_open*stopRatio)` |
| 方案二初始 | `:143` | `:400` | `floor2(base_low*0.999)` → `floor2(base_low*stopRatio)` |
| 锁定触发日 | `:205` | `:471` | `floor2(adj_low*0.999)` → `floor2(adj_low*stopRatio)` |
| 未锁定每日 | `:235` | `:503` | `floor2(adj_low*0.999)` → `floor2(adj_low*stopRatio)` |

### 2.2 `floorRatio` —— 成本地板价（1 处）

| 处 | Python | TS | 现 → 改 |
|----|--------|----|---------|
| 地板价常量 | `band_lock_exit.py:151` | `:408` | `floor2(cost*0.999)` → `floor2(cost*floorRatio)` |

> `floorRatio > 1`：地板价高于成本，要求至少锁住 `(floorRatio-1)` 收益才放出，语义为「锁盈地板」。
> `floor2` 截断逻辑不变（仍向下到 0.01）。

### 2.3 `floorEnabled` —— 成本地板总开关

控制三处「地板参与止损下限」的逻辑；`false` 时全部短路（方案二也不设地板）：

| 处 | Python | TS | `false` 时行为 |
|----|--------|----|---------------|
| 激活评估 | `:200` | `:465-467` | 不置 `floor_active`（恒 false）|
| 锁定时取 max | `:206-207` | `:472-474` | 不执行 `max(stopNext, floorPrice)` |
| 每日取 max | `:236-237` | `:504-505` | 不执行 `max(lowStop, floorPrice)` |

实现建议：把现有 `scheme == 2 and floor_active` 的判定统一改为
`floor_enabled and scheme == 2 and floor_active`。`floorEnabled=true`（默认）时三处与现状逐字等价。

### 2.4 `ma5RequireDown` —— 锁定后 MA5 离场是否要求均线下行

| 处 | Python | TS | 说明 |
|----|--------|----|------|
| MA5 离场条件 | `band_lock_exit.py:212-218` | `:480-486` | 现为 `close<ma5 AND ma5<prev_ma5` |

改法：`ma5 < prev_ma5` 这一项由 `ma5RequireDown` 门控：
```text
require_down ? (close<ma5 AND ma5<prev_ma5) : (close<ma5)
```
`ma5RequireDown=false` → 只要收盘跌破 MA5 即离场（更敏感、更早出），不再等 MA5 拐头向下。
`prev_ma5` 仍需维护（供 `require_down=true` 用）。`ma5RequireDown=true`（默认）时与现状逐字等价。

## 三、不变的部分（务必不动）

- `floor2` 截断精度（×100 / floor / ÷100）—— 跨语言逐位一致的根基。
- 方案一/二切换判定（`adj_close > adj_open`）—— 本设计不放开。
- 锁定触发基准（`adj_low > signal_high`）—— 本设计不放开。
- 涨停买不进（`raw_open ≥ up_limit`）/ 封死跌停顺延（`raw_high ≤ down_limit`）—— 字段绑定，不放开。
- MA5 窗口（5）/ MA5 取数（DB 列或滚动）—— 本设计不放开（见 [index 范围边界](./index.md#范围边界明确不做)）。
- 停牌日跳过、退市收口、`max_hold` 兜底 —— 既有口径不变。

## 四、参数命名映射（三模块）

| 概念 | TS / DTO / 前端 | Python 核 & labels | scheme 后缀 | kelly 网格 key |
|------|-----------------|--------------------|-------------|----------------|
| 止损缓冲系数 | `stopRatio`      | `stop_ratio`       | `sr`        | `stop_ratio`   |
| 成本地板系数 | `floorRatio`     | `floor_ratio`      | `fr`        | `floor_ratio`  |
| 启用成本地板 | `floorEnabled`   | `floor_enabled`    | `fl`        | `floor_enabled`|
| MA5 下行要求 | `ma5RequireDown` | `ma5_require_down` | `md`        | `ma5_require_down` |
| （已有）封顶 | `maxHold`        | `max_hold`         | `mh`        | `max_hold`     |
