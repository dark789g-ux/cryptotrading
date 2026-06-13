# 03 · 共享核同构改造（Python 核 + TS 核）

> band_lock 行为的**唯一真值**是 Python `simulate_band_lock`；TS `decideBandLock` 是同构镜像，
> 二者用同组样例逐位对拍。**放一个参数 = 两套核同步改 + 对拍样例覆盖该参数**，否则对拍崩。

## 一、签名扩展（keyword-only，默认值=现状）

### Python（`strategy/band_lock_exit.py`）

```python
def simulate_band_lock(
    bars, signal_high, *,
    max_hold: int | None = None,
    stop_ratio: float = 0.999,
    floor_ratio: float = 0.999,
    floor_enabled: bool = True,
    ma5_require_down: bool = True,
) -> BandLockOutcome:
```

`BandLockBar` dataclass **不变**（参数是行为旋钮，不是逐 bar 数据）。

### TS（`signal-stats.simulator.ts`）

`ExitConfig` 的 trailing_lock 变体（现 `:127-130`）扩展：

```ts
| { mode: 'trailing_lock'; maxHold?: number;
    stopRatio?: number; floorRatio?: number;
    floorEnabled?: boolean; ma5RequireDown?: boolean }
```

`BandLockOptions`（现 `:350-357`）与 `decideBandLock`（现 `:380`）同步加这 4 个可选字段；
函数体内对 `undefined` 落默认（`stopRatio ?? 0.999` 等），保证不传时与现状逐字等价。

`simulateTradeCore`（`:193-197`）构造 `BandLockOptions` 时把 `exit.*` 透传。

## 二、逐处改造对照

| 控制点 | Python | TS | 改法 |
|--------|--------|----|------|
| 方案一初始止损 | `:139` | `:396` | `*0.999` → `*stop_ratio` |
| 方案二初始止损 | `:143` | `:400` | `*0.999` → `*stop_ratio` |
| 地板价常量 | `:151` | `:408` | `*0.999` → `*floor_ratio` |
| 保本激活评估 | `:200` | `:465-467` | 加 `floor_enabled and` 前置门控 |
| 锁定触发日止损 | `:205` | `:471` | `*0.999` → `*stop_ratio` |
| 锁定时地板 max | `:206-207` | `:472-474` | `scheme==2 and floor_active` → `floor_enabled and scheme==2 and floor_active` |
| MA5 离场 | `:212-218` | `:480-486` | `ma5<prev_ma5` 项由 `ma5_require_down` 门控（见下）|
| 未锁定每日止损 | `:235` | `:503` | `*0.999` → `*stop_ratio` |
| 每日地板 max | `:236-237` | `:504-505` | 同「锁定时地板 max」加 `floor_enabled and` 门控 |

### MA5 离场门控（伪码，两侧同构）

```text
ma5_ok = (bar.ma5 is not None and bar.adj_close is not None
          and bar.adj_close < bar.ma5)
if ma5_require_down:
    ma5_ok = ma5_ok and (prev_ma5 is not None and bar.ma5 < prev_ma5)
if locked and ma5_ok:
    ... 离场（含封死跌停顺延，逻辑不变）
```

`prev_ma5` 仍照常维护（`require_down=true` 时需要）。

## 三、浮点一致性（跨模块对拍的隐形地雷）

⚠️ ratio 是浮点，三模块取数路径不同：signal-stats 从 DTO number 直接拿；labels/kelly 经 scheme
量化（`round(NNNN/1000, 3)`）还原。若不统一精度，「同一个标称 0.997」可能在两侧落不同 double，
`floor2` 后漂移、对拍/全链路结果不一致。

**唯一量化算法（两语言逐位一致）**：`NNNN = round_half_up(ratio*1000)`，`ratio = NNNN/1000`
（Python `math.floor(r*1000+0.5)`、TS `Math.round(r*1000)`；均正数 round-half-up，**非** Python 内建
`round()` 的 banker's，否则中点值如 0.0005/0.9995 两语言分叉）。**所有入口入核前都走它**：
- scheme 侧：`band_lock_scheme.quantize_band_lock_params`（见 02）。
- signal-stats：DTO 校验时量化；前端 `n-input-number :precision="3"` 锁输入精度。
- kelly：`build_band_lock_grid` 对每个候选 ratio 先量化再进笛卡尔积（见 [05 §3.3](./05-labels-and-kelly.md#33-落点)）。
- 网格点 `NNNN/1000` 在两语言是同一除法 → 同一 double；中点值靠统一 round-half-up 收敛。
06 §二补一条「中点值两语言量化一致」单测守此约束。

## 四、对拍样例扩充

### 4.1 默认值回归（最高优先级护门）

现有 S1~S13 全部用**默认参数**重跑：
- Python `simulate_band_lock(bars, signal_high)`（不传新参数）输出与改造前逐字段一致；
- TS 同样；
- 两侧仍逐位对拍。这是「零漂移」的核心证据。

### 4.2 新参数边界样例（每个 Python+TS 双跑 + 对拍）

| 样例 | 配置 | 预期验证点 |
|------|------|-----------|
| S14 | `stop_ratio=0.997` | 止损价更低 → 出场日/出场价与默认不同（可手算） |
| S15 | `stop_ratio=1.0` | 止损=floor2(基准×1.0)：1.0 仅去缓冲，floor2 截断仍生效（非等于基准），更易触发 |
| S16 | `floor_ratio=1.02, floor_enabled=true`（方案二盈利后回落）| 锁盈地板拦截出场，stop ≥ floor2(cost*1.02) |
| S17 | `floor_enabled=false`（方案二）| 不设地板，止损可跌破成本，出场价/日与 S(默认) 不同 |
| S18 | `ma5_require_down=false`（锁定后收盘跌破 MA5 但 MA5 未下行）| 立即 ma5_exit；默认参数下该日不出场 → 直接对比 |
| S19 | 组合 `mh=10 + sr=0.997 + fl=false + md=false` | 多参数交互，逐位对拍 |

样例数据沿用现有对拍夹具构造方式（见
[2026-06-09 spec 02-shared-core-and-contracts](../2026-06-09-trailing-lock-exit-design/02-shared-core-and-contracts.md)）。
TS 侧新样例加在 `signal-stats.band-lock.spec.ts`、Python 侧加在共享核对拍测试（与现有 S1~S13 同夹具）。

## 五、不变量自检（实现后必过）

- 默认参数下 S1~S13 输出 byte-identical（4.1）。
- Python 与 TS 对全部 S1~S19 逐位一致。
- `floor2` 实现一字未改。
- 入场过滤 / 停牌跳过 / 退市收口 / `max_hold` 兜底逻辑一字未改。
