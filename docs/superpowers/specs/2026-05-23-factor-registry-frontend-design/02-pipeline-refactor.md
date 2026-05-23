# 02 · quant-pipeline Registry Refactor

← 回到 [index.md](./index.md)

## 影响文件

- `apps/quant-pipeline/src/quant_pipeline/factors/base.py` — 去除 4 个类属性的硬性要求，改从内存缓存读
- `apps/quant-pipeline/src/quant_pipeline/factors/registry.py` — 新增 `load_from_db / reload_from_db / list_active`
- `apps/quant-pipeline/src/quant_pipeline/factors/{price,industry}/<16 个因子文件>.py` — 删除 `description / category / pit_window_days / pit_anchor` 类属性。当前清单（industry 5 + price 11）：

  ```text
  industry/industry_momentum_20d.py
  industry/industry_neutral_momentum.py
  industry/industry_rank_in_sector.py
  industry/industry_relative_strength.py
  industry/sector_volume_concentration.py
  price/amihud_illiq_20d.py
  price/bollinger_position_20d.py
  price/close_to_high_60d.py
  price/ma_ratio_20d.py
  price/momentum_20d.py
  price/momentum_60d.py
  price/price_max_drawdown_60d.py
  price/rsi_14.py
  price/turnover_mean_20d.py
  price/volatility_20d.py
  price/volume_ratio_20d.py
  ```
- `apps/quant-pipeline/src/quant_pipeline/worker/train_e2e_runner.py` — 启动期调 `reload_from_db`
- `apps/quant-pipeline/src/quant_pipeline/features/runner.py` — `_load_factor_ids` 改用 `list_active(factor_version)` 与 DB 拉到的 factor_ids 取交集（spec 原写 `features/builder.py:sorted_factor_ids`，实际仓库该变量位于 runner.py；自动排除 enabled=false）

## DB 接入点

复用现有 `apps/quant-pipeline/src/quant_pipeline/db/engine.py`（已有 SQLAlchemy engine + session 工厂，被 Alembic env 和现有 worker 共用）：

```python
from quant_pipeline.db.engine import session_scope  # 已有 API
```

`registry.load_from_db()` 不持有长会话——拿到 session、SELECT 全表后立即释放：

```python
def load_from_db() -> None:
    with session_scope() as s:
        rows = s.execute(select(FactorDefinitionRow)).scalars().all()
    _meta_cache.clear()
    _meta_cache.update({(r.factor_id, r.factor_version): FactorMeta(...) for r in rows})
```

**多进程可见性**：worker 当前**单进程多协程**模型（asyncio dispatcher 见 `worker/dispatcher.py`），`_meta_cache` 模块级全局变量，所有协程共享。如未来切到 fork 多进程，需在每个子进程入口再调一次 `load_from_db()`——目前不是关注点。

## 加载与实例化流程

```text
worker / cli 启动
        │
        ▼
registry.load_from_db()
   - SELECT * FROM factors.factor_definitions
   - 生成 _meta_cache: dict[(factor_id, factor_version), FactorMeta]
        │
        ▼
Factor.__init__():
   key = (cls.factor_id, cls.factor_version)
   if key not in _meta_cache:
       raise FactorMetaMissing(key)         ← fail-fast，不静默
   meta = _meta_cache[key]
   self.category = meta.category
   self.pit_window_days = meta.pit_window_days
   self.pit_anchor = meta.pit_anchor
   self.description = meta.description
```

### `FactorMeta` 数据类

```text
@dataclass(frozen=True)
class FactorMeta:
    factor_id: str
    factor_version: str
    description: str
    category: str
    pit_window_days: int
    pit_anchor: str
    enabled: bool
    display_order: int
```

`formula` / `data_source` **不**进 `FactorMeta`——它们仅供阅读，不需要在 Python 端使用。

## enabled=false 跳过逻辑

- `registry.list_active(factor_version)` 仅返回 `enabled=true` 的因子集合
- `features/builder.py` 当前哈希契约：

```text
sha256(factor_version + label_scheme + new_listing_min_days + sorted_factor_ids)
```

  中的 `sorted_factor_ids` 改用 `list_active` 输出
- 启停一个因子 → 新 SHA256 → 新 feature_set_id → 自动产出新 feature_set 行
- 既有的 feature_set 物化数据不受影响（旧 set 还能复用，但新 train_e2e 跑出来是新的 set_id）

## 缓存粒度

- **不**做长驻进程级缓存（worker 可能同时跑多个 job，进程级缓存会让"上一个 job 锁定的元数据"污染下一个）
- 每个 `train_e2e_runner` 入口调 `reload_from_db()`；job 结束随进程退出
- `train` / `optuna` / `seed_avg` 三种 run_type **不算因子**，不受影响

## 异常分类

- `FactorMetaMissing(factor_id, factor_version)` — DB 缺对应行 → worker 启动失败，CLAUDE.md「禁止静默吞错」
- `DuplicateFactorClass(factor_id, factor_version)` — 同 key 注册了多个 Python 类 → registry 装饰器原有行为保持
- DB 连接失败 → `RuntimeError("factor_definitions unreachable")`，由 train_e2e_runner 上层捕获并 fail job

## 单元测试入口

详见 [06-testing.md](./06-testing.md#1-quant-pipeline-pytest)。关键场景：

- DB 缺一行 → 实例化抛 `FactorMetaMissing`
- 改 enabled → `list_active` 输出变化 → builder SHA256 变化
- compute 计算结果在 refactor 前后**逐字节一致**（参数化跑通 16 个因子）
