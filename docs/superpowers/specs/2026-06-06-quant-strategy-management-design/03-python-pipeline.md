# 03 · Python pipeline 改造

← 返回 [index](./index.md) ｜ 上一篇 [02 数据模型](./02-data-model-and-migration.md)

本层是改造重心。分三块：① 出场规则层（exit_rules.py 泛化 + 新规则 + 模拟器加状态）；
② scheme codec；③ 接线（runner / train_e2e + 策略加载）。

## 1. 出场规则层 `strategy/exit_rules.py`

### 1.1 ExitState 扩展（加 high / peak）

现状 `ExitState` 只有 current_price/low_price/ma5（`exit_rules.py:53-71`），take_profit 需盘中最高价、
trailing_stop 需持仓期峰值。新增两字段：

```text
@dataclass(frozen=True) ExitState:
    ... 现有字段 ...
    high_price: float            # 新增：当日 high_adj（盘中最高价，后复权）
    peak_price: float            # 新增：入场以来 high_adj 的运行峰值（含当日）
    ma: float                    # 原 ma5 改名为 ma（值=配置 period 的 MA），兼容见 §1.4
```

`peak_price` 由**模拟器**逐日维护（见 §1.5），不是某日数据，是持仓上下文。

### 1.2 新规则 TakeProfitRule

```text
class TakeProfitRule(ExitRule):  name = "take_profit"
    __init__(pct): 校验 0 < pct <= 5，self.pct = float(pct)
    decide(state):
        if not isfinite(state.high_price): return None
        target = state.entry_price * (1 + self.pct)
        if state.high_price >= target:
            return ExitDecision(exit_reason=EXIT_TAKE_PROFIT, exit_price=target)
        return None
```
- 成交价取 **target = entry×(1+pct)**（假设盘中触及限价单成交），决定性、不乐观高估到 high。
- 新常量 `EXIT_TAKE_PROFIT: Final[str] = "take_profit"`。

### 1.3 新规则 TrailingStopRule

```text
class TrailingStopRule(ExitRule):  name = "trailing_stop"
    __init__(pct): 校验 0 < pct < 1，self.pct = float(pct)
    decide(state):
        if not isfinite(state.peak_price): return None
        stop = state.peak_price * (1 - self.pct)
        if state.current_price <= stop:        # 收盘跌破峰值回撤线
            return ExitDecision(exit_reason=EXIT_TRAILING_STOP, exit_price=float(state.current_price))
        return None
```
- 用 close（current_price）判定与成交，与 ma_break 同口径（保守、避免盘中穿透歧义）。
- 新常量 `EXIT_TRAILING_STOP: Final[str] = "trailing_stop"`。

### 1.4 ma_break 泛化

`MA5BreakRule`（无参，读 `state.ma5`，MA_WINDOW=5）→ 泛化为 `MABreakRule(period=5)`：
```text
class MABreakRule(ExitRule):  name = "ma_break"
    __init__(period=MA_WINDOW): 校验 int∈[2,250]
    decide(state):
        if not isfinite(state.ma): return None
        if state.current_price < state.ma:
            return ExitDecision(exit_reason=EXIT_BELOW_MA5, exit_price=float(state.current_price))
        return None
```
- **exit_reason 仍用 `EXIT_BELOW_MA5="ma5_break"`**（下游禁改名，见 [02 §2†](./02-data-model-and-migration.md#2-exit_rules-json-schema)）。
- `_ensure_ma5(df)` → `_ensure_ma(df, window)`：`rolling(window, min_periods=window)`。
- ExitState 的 `ma` 按配置 period 算（见 §1.5）。
- **回归安全**：period=5 时 MA 与原 ma5 逐行相等 → default_exit 输出不变。
- 保留 `MA5BreakRule = MABreakRule` 别名或 `default_rules()` 直接用 `MABreakRule(5)`，
  确保现有 import（`strategy_aware.py:69`）与单测不破。

### 1.5 build_exit_rules 工厂 + 模拟器加 peak

**工厂**（纯函数，吃已解析的 config，不碰 DB）：
```text
_RULE_BUILDERS = {
  "stop_loss":     lambda p: StopLossRule(threshold=-float(p["pct"])),
  "ma_break":      lambda p: MABreakRule(period=int(p["period"])),
  "max_hold":      lambda p: MaxHoldRule(max_days=int(p["days"])),
  "take_profit":   lambda p: TakeProfitRule(pct=float(p["pct"])),
  "trailing_stop": lambda p: TrailingStopRule(pct=float(p["pct"])),
}
def build_exit_rules(exit_rules: list[dict]) -> ExitRule:
    # 校验：非空 / 每条 type 合法 / 恰一条 max_hold / params 范围
    # 按列表顺序实例化 → combine_rules([...])（first-match）
    # 同时回传需要的 ma window（供模拟器算 ma）：取列表中 ma_break 的 period（无则不算 ma）
```
返回 `combine_rules(rules)`；另需让调用方知道 **MA window**（仅一条 ma_break，取其 period；
无 ma_break 则 ma 恒 NaN、MABreakRule 不触发——但 v1 default 含 ma_break）。建议
`build_exit_rules` 返回 `(rule, ma_window: int | None)` 二元组。

**模拟器 `simulate_exit` 改造**（`exit_rules.py:275-444`）：
- `_normalize_prices`：补 `high` 列（缺则等于 close，与 low 同处理，`:258-272`）。
- `_ensure_ma(prices, window)`：用传入 window；window=None 时 ma 列全 NaN。
- 主循环维护 `peak = max(peak, high_val)`（入场后逐有效交易日更新；初值取入场日 high）。
- 构造 ExitState 时填 `high_price=high_val, peak_price=peak, ma=ma_val`。
- 签名增 `ma_window: int | None`（由 build_exit_rules 回传，compute 层透传）。

## 2. scheme codec `labels/dir3_scheme.py`

`base_scheme_codec` 的 strategy_aware 分支（现 `:140-142` 直接返回常量）改为读 id+版本：
```text
if base_type == "strategy_aware":
    sid = (base_params or {}).get("strategy_id")
    sver = (base_params or {}).get("strategy_version")
    if not sid or not sver:
        raise ValueError("strategy_aware requires base_params={strategy_id, strategy_version}")
    if sid == "default_exit" and sver == "v1":
        return _STRATEGY_AWARE_SCHEME          # "strategy-aware" legacy 别名
    return f"strategy-aware__{sid}_{sver}"
```
- 反向：`labels/runner.py` 已用 scheme 串识别路径（`:300-305`），需让
  `compute_labels` 接受 `"strategy-aware"` **和** `"strategy-aware__*"` 都走 strategy_aware
  分支（加正则 `^strategy-aware(__.+)?$` 或显式前缀判断）。

## 3. 接线（runner / train_e2e + 策略加载）

### 3.1 策略加载（DB IO 层，runner.py 新增）
```text
def _load_strategy_definition(strategy_id: str, strategy_version: str) -> list[dict]:
    SELECT exit_rules FROM factors.strategy_definitions
    WHERE strategy_id=:id AND strategy_version=:ver
    取不到 → raise RuntimeError(f"strategy {id}@{ver} not found")（fail-fast，CLAUDE.md）
    返回 exit_rules（jsonb→list[dict]）
```

### 3.2 compute_labels 签名（runner.py:256）
- 删 `max_hold_days` 入参；新增 `exit_rules: list[dict] | None`。
- strategy_aware 分支（`:337-352`）：
  - `exit_rules` 为 None（直跑且未给）→ 加载 default_exit@v1 或走 default_rules()。
  - 调 `compute_strategy_aware_labels(LabelInputs(..., exit_rules=exit_rules), scheme=scheme)`。
- `LabelInputs.max_hold_days` 删除 → 改 `exit_rules: list[dict] | None`
  （`strategy_aware.py:274`）。`compute_strategy_aware_labels` 内：
  `rule, ma_window = build_exit_rules(exit_rules)`（None → `default_rules(), 5`），
  records 的 `scheme` 用传入的 `scheme`（替换写死的 `LABEL_SCHEME`，`:505`）。

### 3.3 train_e2e（主路径，train_e2e_runner.py）
- `_validate_base_type_and_params`（`:341-355`，由顶层 `_validate_params` 调用的子校验器）：strategy_aware 分支改为校验
  `base_params={strategy_id: str(`[a-z0-9_]{1,64}`), strategy_version: str(`v\d+`)}`，
  删 `max_hold_days∈[10,30]` 校验（`_MAX_HOLD_DAYS_RANGE` 移除）。
- `base_scheme = base_scheme_codec(base_type, base_params)` 不变（codec 已改）。
- `_step_labels`（`:537-587`）：删 max_hold_days 解析；改为
  `exit_rules = _load_strategy_definition(base_params["strategy_id"], base_params["strategy_version"])`
  （strategy_aware 时），传 `compute_labels(scheme=base_scheme, exit_rules=exit_rules, ...)`。
- `_step_train` extra_hyperparams 增 `strategy_id/strategy_version`（追溯，`:673-684` 同 label_id 风格）。

### 3.4 dispatcher 直跑（runner_entrypoint，runner.py:413）
- 现状只读 scheme/date_range/new_listing_min_days（`:420-436`）。
- 新增：若 params 含 `strategy_id`+`strategy_version` → 加载 exit_rules + 用 codec 算 scheme；
  否则（裸 scheme="strategy-aware"）→ 走 default_exit。传入 compute_labels。

## 4. 数据加载 SQL（runner.py:73-95）

`_load_daily_quotes` 的 SELECT 增 `q.high`：
```sql
SELECT q.ts_code, q.trade_date, q.close, q.low, q.high, a.adj_factor
FROM raw.daily_quote q LEFT JOIN raw.adj_factor a ON ...
```
- `raw.daily_quote.high` 存在（`schema_contract.py:23` 核实）。
- `apply_hfq`（`_common.py:43`）增 `high_adj = high × adj_factor`（与 low_adj 对称，`:57-58`）。
- `strategy_aware._prices_for_simulator`（`:315-328`）增 `high_adj → high` 映射。

## 5. 校验与 fail-fast

- `build_exit_rules`：空数组 / 未知 type / 无 max_hold / 多条同 type / params 越界 → raise ValueError。
- `_load_strategy_definition` 取不到行 → raise RuntimeError（禁静默，CLAUDE.md `data-integrity`）。
- codec：strategy_aware 缺 strategy_id/version → raise ValueError。
- 这些 raise 由 worker 顶层捕获 → job=failed + error_text（现有机制，train_e2e StepError）。
