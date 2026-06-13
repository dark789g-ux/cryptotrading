# 03 · Python：纯函数核 + labels + scheme + runner

[← index](./index.md) · 算法见 [01](./01-algorithm.md) · 参数/编码见 [02](./02-params-scheme-grid.md)

涵盖 **D1**（纯函数核）与 **D3**（labels 模块 / scheme 编码器 / runner 路由）。
镜像对象：`band_lock_exit.py` / `band_lock_labels.py` / `band_lock_scheme.py` / `runner.py`。

## phase_lock_exit.py 纯函数核（D1）

**新建** `apps/quant-pipeline/src/quant_pipeline/strategy/phase_lock_exit.py`。

导出：

```text
@dataclass(frozen) PhaseLockBar:           # 对齐 BandLockBar 字段
    adj_open, adj_high, adj_low, adj_close   # 后复权 OHLC
    ma5                                      # 该 bar 的 MA5（None 表不可用）
    raw_open, raw_high                        # 未复权（限停板判定）
    up_limit, down_limit                      # 当日涨跌停价（未复权，可 None）
    is_suspended                              # 停牌标志

@dataclass(frozen) PhaseLockOutcome:
    kind: Literal['exit','no_exit','no_entry']
    reason: str | None    # phase_lock_stop | phase_lock_ma5 | suspended | limit_up
    exit_index: int | None
    exit_price: float | None
    hold_days: int
    locked: bool

def floor2(x: float) -> float:   # math.floor(x*100)/100，与 TS 逐位一致

def simulate_phase_lock(
    bars: list[PhaseLockBar],
    recent_lows: list[float],     # 含 T+1 的最近 lookback 个非停牌复权 low（升序，数据层切好）
    init_factor: float,
    lock_factor: float,
) -> PhaseLockOutcome
```

算法完全按 [01 逐 bar 算法](./01-algorithm.md#逐-bar-算法伪代码基于精确化语义)。`recent_lows` 由调用方（labels / kelly / signal-stats 数据层）切好传入；core 只做 `min × init_factor`，**不**自己读 lookback 之外的历史（保持纯）。

> **不足 lookback 根**：core 收到的 `recent_lows` 可能短于 lookback（数据层已据可用根数截断），core 直接 `min(recent_lows)`，不报错。空 `recent_lows`（理论上不会，T+1 至少一根）→ 视为无初始止损（`stop_next=None`），由阶段切换接管。

**纯计算**：不连 DB、不读文件、无副作用（与 band_lock_exit.py 同）。

## phase_lock_scheme 编码器（D3）

**新建** `apps/quant-pipeline/src/quant_pipeline/labels/phase_lock_scheme.py`，**逐函数镜像** `band_lock_scheme.py`：

导出（对齐 band_lock_scheme `__all__` 风格）：

```text
DEFAULT_INIT_FACTOR = 0.999      # 钉死 phase_lock_exit.py 默认
DEFAULT_LOCK_FACTOR = 0.999
DEFAULT_LOOKBACK    = 10
RATIO_GRID = 1000
INIT_FACTOR_NNNN_MIN/MAX, LOCK_FACTOR_NNNN_MIN/MAX, LOOKBACK_MIN/MAX
LEGACY_PHASE_LOCK = "phase_lock"

quantize_phase_lock_params(params: dict) -> dict     # 量化+校验+默认回填
canonical_phase_lock_scheme(params: dict) -> str     # → 'phase_lock' | 'phase_lock__lb..__if..__lf..'
parse_phase_lock_scheme(scheme: str) -> dict | None  # 串 → params（默认回填）；畸形/非家族 → None
is_phase_lock_scheme(scheme: str) -> bool            # = parse(...) is not None
```

**校验纪律**（搬 band_lock_scheme 的硬约束）：

- **先量化后校验**：ratio 先 round-half-up 量化，再查 NNNN 范围。
- 默认值显式入串（如 `if0999`）视为**畸形** → parse 返回 None（默认值被 legacy 省略抢占）。
- 后缀顺序固定 `lb→if→lf`；乱序 / 重复 / 未知后缀 / 空段 → None。
- `lookback` 后缀 `lb{N}`：`N` 正整数，等于默认 10 不入串。
- 量化算法 `_round_half_up_nnnn`：`math.floor(ratio*RATIO_GRID + 0.5)`（禁内建 round）。

## phase_lock_labels.py（D3）

**新建** `apps/quant-pipeline/src/quant_pipeline/labels/phase_lock_labels.py`，镜像 `band_lock_labels.py`：

```text
def compute_phase_lock_labels(
    df,                  # 已注入 hfq 复权列的 daily_quote 主窗口（+ 左扩 head 行）
    entries,             # 各 (ts_code, signal_date) 入场点
    *, init_factor, lock_factor, lookback,
    stk_limit_map, suspended_set, ...,   # 与 band_lock_labels 同源
) -> labels_df
```

职责：

1. 对每个入场点，组装持仓窗口 `bars`（从 T+1 起，每根附 `ma5`/限停板/停牌标志）。
   - **MA5**：复用 band_lock_labels 的 `_ensure_ma5`（行位移 `close_adj.shift`，5 个非停牌在场行）。
   - **左扩**：主窗口下界需回看 `max(lookback, 5)-1` 个在场行（既供 MA5 的 `shift`，也供 `recent_lows`）。沿用 runner 的 `head_rows_per_code` 左扩机制（见下）。
2. 切 `recent_lows`：T+1 及其前 `lookback-1` 个**非停牌在场行**的 `low_adj`（升序），不足则用现有。
3. 调 `simulate_phase_lock(bars, recent_lows, init_factor, lock_factor)`，把 `Outcome` 转标签行。

> **MA5 窗口 vs lookback 窗口的左扩取大**：band_lock 现状左扩按 `MA_WINDOW`(=5)；phase_lock 需 `max(MA_WINDOW, lookback)`。runner 的 `_load_daily_quotes(head_rows_per_code=...)` 调用处须传足够大的值（见 runner 路由）。

## runner.py 路由（D3）

**编辑** `apps/quant-pipeline/src/quant_pipeline/labels/runner.py`：

1. import phase_lock 三件套：

```python
from quant_pipeline.labels.phase_lock_labels import compute_phase_lock_labels
from quant_pipeline.labels.phase_lock_scheme import (
    is_phase_lock_scheme, parse_phase_lock_scheme,
)
```

2. 在 `compute_labels` 的 scheme dispatch 链中（band_lock 分支同级）新增 phase_lock 独立有状态分支：
   - `is_phase_lock_scheme(scheme)` → `parse_phase_lock_scheme(scheme)` 取 `{init_factor, lock_factor, lookback}`
     → `_load_daily_quotes(head_rows_per_code = max(MA_WINDOW, lookback) - 1 + 缓冲)`
     → `compute_phase_lock_labels(...)`。
   - 与 band_lock 一样**绕开** strategy_aware 的 `build_exit_rules`。
3. dispatch 顺序：phase_lock 判定放在 band_lock 判定**之后、strategy_aware 之前**（两个家族前缀不重叠：`phase_lock*` vs `band_lock*`，互不误吞，顺序不敏感，但保持显式）。

> **判定单一源**：phase_lock 家族判定/解析只走 `phase_lock_scheme.py`（is/parse），**禁**在 runner 手写正则（与 band_lock 现状一致，runner.py:73-78 注释明确"判定与解析的单一源是 band_lock_scheme.py"）。

## D1 / D3 Python 测试

见 [06 测试落点](./06-fixtures-and-testing.md#测试落点)。要点：
- `tests/unit/test_phase_lock_exit.py` — 主对拍样例（D1，数值源头，TS 镜像它）。
- `tests/unit/test_phase_lock_scheme.py` — 编解码 canonical 串、默认回 legacy、量化、畸形拒绝。
- `tests/unit/test_phase_lock_labels.py` — recent_lows 切片 / 左扩 / 不足根降级 / 停牌跳过。
