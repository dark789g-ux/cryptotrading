# 02. 数据模型变更

## 2.1 DB schema 变更

`factors.factor_definitions` 表新增 1 列 + 1 个跨字段 CHECK 约束。

### 2.1.1 主 SQL（迁移脚本主体）

`apps/server/migrations/20260524_factor_definitions_min_trade_days.sql`：

```sql
-- 1. 新增 min_trade_days 列（先用 DEFAULT 1 占位，下面 UPDATE 回填真实值）
ALTER TABLE factors.factor_definitions
  ADD COLUMN min_trade_days INTEGER NOT NULL DEFAULT 1
  CHECK (min_trade_days BETWEEN 1 AND 250);

-- 2. 回填 16 个现有因子的 min_trade_days（值来源见 2.5 节）
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'momentum_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'volatility_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'volume_ratio_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'amihud_illiq_20d';
UPDATE factors.factor_definitions SET min_trade_days = 20 WHERE factor_id = 'ma_ratio_20d';
UPDATE factors.factor_definitions SET min_trade_days = 20 WHERE factor_id = 'turnover_mean_20d';
UPDATE factors.factor_definitions SET min_trade_days = 20 WHERE factor_id = 'bollinger_position_20d';
UPDATE factors.factor_definitions SET min_trade_days = 14 WHERE factor_id = 'rsi_14';
UPDATE factors.factor_definitions SET min_trade_days = 61 WHERE factor_id = 'momentum_60d';
UPDATE factors.factor_definitions SET min_trade_days = 60 WHERE factor_id = 'close_to_high_60d';
UPDATE factors.factor_definitions SET min_trade_days = 60 WHERE factor_id = 'price_max_drawdown_60d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'industry_momentum_20d';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'industry_neutral_momentum';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'industry_rank_in_sector';
UPDATE factors.factor_definitions SET min_trade_days = 21 WHERE factor_id = 'industry_relative_strength';
UPDATE factors.factor_definitions SET min_trade_days = 1  WHERE factor_id = 'sector_volume_concentration';

-- 3. 落跨字段约束前，先把 pit_window_days 不足的行抬高到 min_trade_days × 2
--    （CLAUDE.md 反静默吞错：抬高时记 NOTICE）
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT factor_id, factor_version, pit_window_days, min_trade_days
    FROM factors.factor_definitions
    WHERE pit_window_days < min_trade_days * 2
  LOOP
    RAISE NOTICE 'Lifting pit_window_days for %/%: % -> %',
      r.factor_id, r.factor_version, r.pit_window_days, r.min_trade_days * 2;
  END LOOP;
END $$;

UPDATE factors.factor_definitions
  SET pit_window_days = min_trade_days * 2
  WHERE pit_window_days < min_trade_days * 2;

-- 4. 添加跨字段 CHECK 约束（DB 层兜底）
ALTER TABLE factors.factor_definitions
  ADD CONSTRAINT pit_window_covers_min_trade_days
  CHECK (pit_window_days >= min_trade_days * 2);
```

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

| factor_id | 源文件硬检查 | min_trade_days |
|---|---|---|
| `momentum_20d` | `price/momentum_20d.py:32` `if len(close) < 21` | **21** |
| `volatility_20d` | `price/volatility_20d.py:29` `if len(close) < 21` | **21** |
| `volume_ratio_20d` | `price/volume_ratio_20d.py:27` `if len(vol) < 21` | **21** |
| `amihud_illiq_20d` | `price/amihud_illiq_20d.py:37` `if len(close) < 21` | **21** |
| `ma_ratio_20d` | `price/ma_ratio_20d.py:26` `if len(close) < 20` | **20** |
| `turnover_mean_20d` | `price/turnover_mean_20d.py:27` `if len(tr) < 20` | **20** |
| `bollinger_position_20d` | `price/bollinger_position_20d.py:22,34` `_N=20; if len(close) < _N` | **20** |
| `rsi_14` | `price/rsi_14.py:29,47` `_N=14; ewm(min_periods=_N)` | **14** |
| `momentum_60d` | `price/momentum_60d.py:28` `if len(close) < 61` | **61** |
| `close_to_high_60d` | `price/close_to_high_60d.py:17,29` `_N=60; if len(close) < _N` | **60** |
| `price_max_drawdown_60d` | `price/price_max_drawdown_60d.py:18,30` `_N=60; if len(close) < _N` | **60** |

### 行业类（5 个）

| factor_id | 源文件硬检查 | min_trade_days |
|---|---|---|
| `industry_momentum_20d` | `industry/industry_momentum_20d.py:37` `if len(close) < 21` | **21** |
| `industry_neutral_momentum` | `industry/industry_neutral_momentum.py:31` `if len(close) < 21` | **21** |
| `industry_rank_in_sector` | `industry/industry_rank_in_sector.py:31` `if len(close) < 21` | **21** |
| `industry_relative_strength` | `industry/industry_relative_strength.py:29` `if len(close) < 21` | **21** |
| `sector_volume_concentration` | `industry/sector_volume_concentration.py` 仅用 T 日 | **1** |

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

worker 启动并通过 registry 双向校验 + pit_audit 启动检查（见 [03-runtime-guard.md](./03-runtime-guard.md#34-启动期校验扩展)），即视为 migration 成功。
