# 02. 数据模型变更

> **表结构权威文档**见 [doc/db/index.md](../../../doc/db/index.md)。本文档保留设计 rationale；**DDL 已迁移至 doc/db/**。

## 2.1 DB schema 变更

`factors.factor_definitions` 表新增 1 列 + 1 个跨字段 CHECK 约束。

### 2.1.1 主 SQL（迁移脚本主体）

表结构（含 `min_trade_days` 列）：`factors.factor_definitions`（列定义按需 `\d schema.table`）

Migration 脚本：`apps/server/migrations/20260524_factor_definitions_min_trade_days.sql`（含 `min_trade_days` 列添加、`pit_window_covers_min_trade_days` 约束、16 因子回填 UPDATE）。

> **CHECK 用 `× 2` 而不是 `ceil(× 2.0)`**：min_trade_days 是整数，× 2 即整数，等价 `ceil(× 2.0)`，避免 PostgreSQL CHECK 用浮点。系数 `2.0` 由 Python `factors/constants.py` 单点定义，CHECK 只是兜底。

### 2.1.2 配套 PowerShell

`apps/server/migrations/20260524_factor_definitions_min_trade_days.ps1`（CLAUDE.md 硬约束：schema 调整须附 `docker exec` 脚本）：

```powershell
# 调用 docker exec crypto-postgres psql -U cryptouser -d cryptodb -f /path/to/sql
# 结构参考已有的 20260524_factor_definitions.ps1
```

### 2.1.3 Alembic 同步

`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260525_0001_add_min_trade_days.py`：与 NestJS migration 内容等价，让 Python 侧 alembic 链不断裂。

## 2.2 Python `Factor` 基类变更

`apps/quant-pipeline/src/quant_pipeline/factors/base.py`：

```python
# 新增类属性占位（与现有 pit_window_days 同样模式）
class Factor(ABC):
    # ... 现有字段 ...
    min_trade_days: int = 0  # 由 _meta_cache 注入；0 = 未声明哨兵

    def __init__(self) -> None:
        # ... 现有逻辑 ...
        self.min_trade_days = meta.min_trade_days  # 新增注入

    def meta(self) -> dict[str, object]:
        return {
            # ... 现有字段 ...
            "min_trade_days": self.min_trade_days,
        }
```

`FactorMeta` dataclass（`registry.py`）补 `min_trade_days: int` 字段。

## 2.3 子类口令声明：`@register` 装饰器扩展

**写法 A（已确认采用）**：装饰器追加参数 + compute 用实例属性。

```python
# factors/price/momentum_20d.py
@register(
    factor_id="momentum_20d",
    factor_version="v1",
    min_trade_days=21,   # 新增
)
class Momentum20d(Factor):
    def compute(self, df, trade_date):
        close = df["close_adj"].unstack("ts_code").sort_index()
        close = close.loc[:trade_date]
        if len(close) < self.min_trade_days:   # 改：原 `< 21` 硬编码 → self.min_trade_days
            return pd.Series(dtype=float)
        # ... 业务逻辑不变 ...
```

**为什么这样写**：
1. 元信息聚合在 `@register` 一处，与 `factor_id` / `factor_version` 并列
2. compute 不再有魔数，可读性 + 一致性
3. registry 装饰器即可收集声明，与 DB 校验时不需要重新扫描代码

**`@register` 装饰器签名变更**：

```python
# factors/registry.py
def register(
    *,
    factor_id: str,
    factor_version: str,
    min_trade_days: int,   # 新增，必填（不给默认值，强制声明）
):
    def deco(cls: type[Factor]) -> type[Factor]:
        cls.factor_id = factor_id
        cls.factor_version = factor_version
        _CLASS_DECLARATIONS[(factor_id, factor_version)] = {
            "min_trade_days": min_trade_days,
        }
        _registered.append(cls)
        return cls
    return deco
```

> **必填不给默认值**：避免新因子忘了声明，CLAUDE.md "禁止静默吞错"。

## 2.4 registry 双向校验

`registry.load_from_db()` 加载完 `_meta_cache` 后追加：

```python
class FactorMetaMismatch(RuntimeError):
    """Python 子类装饰器声明 与 DB factor_definitions 不一致。"""

def _validate_class_db_consistency() -> None:
    """对每个已注册 Factor 子类，校验装饰器声明的 min_trade_days
    与 DB 一致。不一致 → fail-fast。
    """
    for (factor_id, factor_version), declared in _CLASS_DECLARATIONS.items():
        db_meta = _meta_cache.get((factor_id, factor_version))
        if db_meta is None:
            raise FactorMetaMissing(factor_id, factor_version)
        if declared["min_trade_days"] != db_meta.min_trade_days:
            raise FactorMetaMismatch(
                f"min_trade_days drift for {factor_id}/{factor_version}: "
                f"class declared={declared['min_trade_days']} "
                f"DB={db_meta.min_trade_days}"
            )

def load_from_db(session: Session) -> None:
    # ... 现有加载逻辑 ...
    _validate_class_db_consistency()  # 新增，加载完立即校验
```

不一致直接抛 —— worker 启动失败比"静默用某一方默认值"安全。

## 2.5 现有 16 个因子的回填值

值来源：每个因子 `compute()` 内部硬检查值，已通过 grep 精确确认（**非记忆推断**）。

### 价格类（11 个）

| 类名 / 文件 | DB factor_id | 源文件硬检查 | min_trade_days |
|---|---|---|---|
| Momentum20d / `price/momentum_20d.py` | `momentum_20d` | `:32` `if len(close) < 21` | **21** |
| Volatility20d / `price/volatility_20d.py` | `volatility_20d` | `:29` `if len(close) < 21` | **21** |
| VolumeRatio20d / `price/volume_ratio_20d.py` | `volume_ratio_20d` | `:27` `if len(vol) < 21` | **21** |
| AmihudIlliq20d / `price/amihud_illiq_20d.py` | `amihud_illiq_20d` | `:37` `if len(close) < 21` | **21** |
| MaRatio20d / `price/ma_ratio_20d.py` | `ma_ratio_20d` | `:26` `if len(close) < 20` | **20** |
| TurnoverMean20d / `price/turnover_mean_20d.py` | `turnover_mean_20d` | `:27` `if len(tr) < 20` | **20** |
| BollingerPosition20d / `price/bollinger_position_20d.py` | `bollinger_position_20d` | `:22,34` `_N=20; if len(close) < _N` | **20** |
| Rsi14 / `price/rsi_14.py` | `rsi_14` | `:29,41` `_N=14; if len(close) < _N + 1` | **15** |
| Momentum60d / `price/momentum_60d.py` | `momentum_60d` | `:28` `if len(close) < 61` | **61** |
| CloseToHigh60d / `price/close_to_high_60d.py` | `close_to_high_60d` | `:17,29` `_N=60; if len(close) < _N` | **60** |
| PriceMaxDrawdown60d / `price/price_max_drawdown_60d.py` | `price_max_drawdown_60d` | `:18,30` `_N=60; if len(close) < _N` | **60** |

> **rsi_14 = 15 而非 14**：源码硬检查是 `len(close) < _N + 1`（rsi_14.py:41），其中 `_N=14` 是 RSI 窗口常量；多出的 1 是 `close.diff()` 消耗的首日观测。

### 行业类（5 个）

| 类名 / 文件 | DB factor_id | 源文件硬检查 | min_trade_days |
|---|---|---|---|
| IndustryMomentum20d / `industry/industry_momentum_20d.py` | `industry_momentum_20d` | `:37` `if len(close) < 21` | **21** |
| IndustryNeutralMomentum / `industry/industry_neutral_momentum.py` | `momentum_20d_neu` | `:31` `if len(close) < 21` | **21** |
| IndustryRankInSector / `industry/industry_rank_in_sector.py` | `industry_rank_in_sector_mom20` | `:31` `if len(close) < 21` | **21** |
| IndustryRelativeStrength / `industry/industry_relative_strength.py` | `industry_relative_strength` | `:29` `if len(close) < 21` | **21** |
| SectorVolumeConcentration / `industry/sector_volume_concentration.py` | `sector_volume_concentration` | 仅用 T 日 | **1** |

> **2 个文件名 ≠ factor_id**：`IndustryNeutralMomentum` 注册为 `momentum_20d_neu`、`IndustryRankInSector` 注册为 `industry_rank_in_sector_mom20`。SQL UPDATE 必须用 **DB factor_id 列**的值，文件名仅用于代码定位。

## 2.6 验证一致性的脚本

落地后跑一次校验脚本（PowerShell + docker exec）：

```sql
-- 期望：0 行
SELECT factor_id, factor_version, pit_window_days, min_trade_days
FROM factors.factor_definitions
WHERE pit_window_days < min_trade_days * 2
   OR min_trade_days < 1
   OR min_trade_days > 250;
```

worker 启动并通过 registry 双向校验 + pit_audit 启动检查（见 [06-warnings-and-startup.md §6.4](./06-warnings-and-startup.md#64-启动期校验扩展)），即视为 migration 成功。
