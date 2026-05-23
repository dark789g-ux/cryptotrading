# 03. 运行时护门

## 3.1 trade_cal 工具函数

`apps/quant-pipeline/src/quant_pipeline/factors/data_access.py` 新增（或新建该 module）：

```python
from functools import lru_cache
from sqlalchemy import text
from sqlalchemy.orm import Session


@lru_cache(maxsize=4096)
def _count_trade_days_cached(start_date: str, end_date: str, exchange: str) -> int:
    """LRU 缓存版本，session 由调用方在外层管理。"""
    # 实现见 count_trade_days_in_window；这里仅为占位说明缓存形态
    raise NotImplementedError


def count_trade_days_in_window(
    session: Session,
    start_date: str,   # 'YYYYMMDD'
    end_date: str,     # 'YYYYMMDD'，含
    exchange: str = "SSE",
) -> int:
    """查 raw.trade_cal，返回 [start, end] 闭区间内 is_open=1 的天数。

    使用 LRU 缓存按 (start, end, exchange) 命中：同 job 内反复调用零成本。
    """
    sql = text("""
        SELECT COUNT(*) FROM raw.trade_cal
        WHERE exchange = :ex AND is_open = 1
          AND cal_date BETWEEN :s AND :e
    """)
    return int(
        session.execute(sql, {"ex": exchange, "s": start_date, "e": end_date}).scalar()
        or 0
    )


def get_trade_dates_in_window(
    session: Session,
    start_date: str,
    end_date: str,
    exchange: str = "SSE",
) -> list[str]:
    """返回交易日列表（升序），给动态扩窗时找"上一个交易日"用。"""
    sql = text("""
        SELECT cal_date FROM raw.trade_cal
        WHERE exchange = :ex AND is_open = 1
          AND cal_date BETWEEN :s AND :e
        ORDER BY cal_date
    """)
    return [row[0] for row in session.execute(sql, {"ex": exchange, "s": start_date, "e": end_date})]
```

> **为什么单独一个 module 而不是堆到 runner.py**：runner.py 改完估计 280 行；再加这些会突破 CLAUDE.md 500 行约束。同时这两个函数会被 runner / pit_audit 新检查项 / CLI 启动校验三处复用。

### 3.1.1 LRU 缓存策略

| 维度 | 决策 |
|---|---|
| key | `(start_date, end_date, exchange)` |
| maxsize | 4096（一个 job 最多扫 ~250 trade_dates × 4 unique windows = 1000，留余量） |
| 进程级 vs 请求级 | 进程级（worker 是长进程；不同 job 共享缓存无副作用） |
| 失效 | 不主动失效；trade_cal 通常稳定，如有新同步重启 worker |

## 3.2 runner 改造

`apps/quant-pipeline/src/quant_pipeline/factors/runner.py`。

### 3.2.1 取数前（不变）

现有 `factor_window_empty` 检查保留：取数后 `sub.empty` → warn + skip 整个 trade_date。

### 3.2.2 取数后、调 compute 前（新增护门）

```python
# 伪代码，实际写到 runner.py:174 后
for factor in factors:
    # === 新增运行时护门 ===
    window_start = _shift_date(trade_date, -factor.pit_window_days)
    actual_td = count_trade_days_in_window(session, window_start, trade_date)

    if actual_td < factor.min_trade_days:
        # 第一次告警
        logger.warning(
            "factor_window_short",
            extra={
                "factor_id": factor.factor_id,
                "factor_version": factor.factor_version,
                "trade_date": trade_date,
                "declared_pit_window": factor.pit_window_days,
                "actual_trade_days": actual_td,
                "min_trade_days": factor.min_trade_days,
            },
        )
        _emit_job_warning(job_id, "factor_window_short", factor_id=factor.factor_id, ...)

        # 动态扩窗 × 2 重试
        retry_window_days = factor.pit_window_days * 2
        retry_start = _shift_date(trade_date, -retry_window_days)
        retry_td = count_trade_days_in_window(session, retry_start, trade_date)

        if retry_td < factor.min_trade_days:
            logger.warning(
                "factor_window_retry_failed",
                extra={
                    "factor_id": factor.factor_id,
                    "trade_date": trade_date,
                    "retry_trade_days": retry_td,
                    "min_trade_days": factor.min_trade_days,
                },
            )
            _emit_job_warning(job_id, "factor_window_retry_failed", ...)
            continue   # skip 该因子当天

        # 重试成功：增量拉数据
        sub_for_factor = _load_window_increment(
            session, factor, retry_start, trade_date, base_df=df_window
        )
        series = factor.compute(sub_for_factor, trade_date)
    else:
        # 正常路径
        series = factor.compute(sub, trade_date)

    _write_non_nan_to_db(series, trade_date, factor)
```

### 3.2.3 扩窗"增量拉"而非"重拉"

已有 `df_window` 是按 `max(pit_window_days for f in factors)` 一次性预取的。扩到 ×2 时：

- 若 `factor.pit_window_days × 2 <= max(pit_window_days)`：`df_window` 已经够，直接切片复用
- 否则：补拉 `[T - pit_window_days × 2, T - max(pit_window_days))` 这段，并 concat 进 `df_window`

伪代码：

```python
def _load_window_increment(session, factor, retry_start, trade_date, base_df):
    # 若 base_df 的最早 trade_date 已 <= retry_start，复用
    base_min = base_df.index.get_level_values("trade_date").min()
    if base_min <= retry_start:
        return base_df.loc[(slice(retry_start, trade_date), slice(None)), :]

    # 否则补拉
    extra = _fetch_raw_for_window(session, factor.category, retry_start, base_min)
    return pd.concat([extra, base_df]).sort_index()
```

> **不污染其它 factor 的取数边界**：扩窗后的 `sub_for_factor` 只给当前 factor 用；其它 factor 用各自 `pit_window_days` 切片 `base_df`。

### 3.2.4 重试也失败的处理

- 写 `factor_window_retry_failed` warning（区别于 `_short`）
- 该因子当天 `skip`，不调 compute
- DB 里这一天这一只股票的该因子没有行（与"停牌"同等处理，但有 SSE warning 可追溯）

## 3.3 SSE 推送整合

### 3.3.1 警告聚合写入 `ml.jobs.warnings`

`apps/server/src/entities/ml/ml-job.entity.ts` 已有 `warnings JSONB`（如无则加）。runner 内部 `_emit_job_warning`：

```python
def _emit_job_warning(job_id: str, warning_type: str, **detail) -> None:
    """追加一条 warning 到 ml.jobs.warnings 字段。
    progress.update_progress 下次推送时会带 warnings_summary。
    """
    session.execute(
        text("""
            UPDATE ml.jobs SET warnings = warnings || :w::jsonb
            WHERE id = :id
        """),
        {"w": json.dumps([{"type": warning_type, **detail}]), "id": job_id},
    )
```

### 3.3.2 SSE payload 形态

`worker/progress.py:update_progress` 现有：

```python
def update_progress(job_id, pct, stage):
    # 已有：写 ml.jobs.progress + NOTIFY
```

扩展为同时读 warnings 并聚合 summary：

```python
def update_progress(job_id, pct, stage):
    warnings_count = _count_warnings_by_type(job_id)  # {"factor_window_short": 3, ...}
    payload = {
        "type": "progress",
        "pct": pct,
        "stage": stage,
        "warnings_summary": warnings_count,
    }
    _notify(job_id, payload)
```

### 3.3.3 前端展示

`apps/web/src/views/quant/QuantJobs*.vue`（详情页）加 warnings 折叠区：

```text
┌─ Job #abc-123 ──────────────────────────────────┐
│  进度: ████████░░ 80%   stage: computing        │
│                                                 │
│  ⚠ 警告 (4 条)  [展开]                          │
│   ▼ factor_window_short × 3                     │
│       momentum_20d @ 20260206  (18 < 21)        │
│       volatility_20d @ 20260206 (18 < 21)       │
│       ...                                       │
│   ▼ factor_window_retry_failed × 1              │
│       sector_volume_concentration @ 20260205    │
└─────────────────────────────────────────────────┘
```

> **不阻塞但可见**：动态护门本身承担"运行时救回"角色，warning 不应中断 job；但必须前端可见，否则等于没救（用户压根不知道发生过）。

## 3.4 启动期校验扩展

`apps/quant-pipeline/src/quant_pipeline/quality/pit_audit.py` 新增一个 check：

```python
from quant_pipeline.factors.constants import PIT_WINDOW_COEFFICIENT


def audit_pit_window_covers_min_trade_days(factors: list[Factor]) -> list[CheckResult]:
    """对每个已注册 factor，校验 pit_window_days >= ceil(min_trade_days × 2.0)。

    与 DB CHECK 约束重复，但 fail-fast 在 worker 启动期暴露，
    比等到第一次 runner 跑因子时再炸要早。
    """
    out: list[CheckResult] = []
    for f in factors:
        required = math.ceil(f.min_trade_days * PIT_WINDOW_COEFFICIENT)
        if f.pit_window_days < required:
            out.append(CheckResult(
                passed=False,
                level="critical",
                rule="pit_window_coverage",
                detail={
                    "factor_id": f.factor_id,
                    "declared": f.pit_window_days,
                    "required": required,
                    "min_trade_days": f.min_trade_days,
                    "coefficient": PIT_WINDOW_COEFFICIENT,
                },
                trade_date="00000000",
                name="pit_window_covers_min_trade_days",
            ))
    return out
```

挂在 CLI `factors run` 入口的 startup hook（`apps/quant-pipeline/src/quant_pipeline/cli.py`），failed 则拒启动并打印失败因子清单。

## 3.5 常量定义

新建 `apps/quant-pipeline/src/quant_pipeline/factors/constants.py`：

```python
"""因子运行时常量。

集中定义，避免 magic number 散落到 runner / pit_audit / registry 多处。
"""

PIT_WINDOW_COEFFICIENT: float = 2.0
"""pit_window_days 必须 >= ceil(min_trade_days × 该系数)。

系数 = 2.0（原经验值 1.6 提高到 2.0）：
  - 1.6 仅覆盖周末 + 短假期（五一、中秋）
  - 2.0 额外覆盖春节 / 国庆 7 天连休 + 周末叠加

修改该常量需同步：
  1. apps/server/migrations 加新 migration 调整 CHECK 约束
  2. apps/server/src/modules/quant/factors/factors.service.ts 同步系数
  3. apps/web/src/components/quant/FactorEditModal.vue 同步系数
  4. 跑回归测试，确保现有 16 个因子的 pit_window_days 仍满足新系数
"""

RETRY_WINDOW_MULTIPLIER: int = 2
"""运行时窗口不足时，扩窗 × 该倍率重试一次。"""
```

> **3 处人工同步系数**：前后端各自硬编码 `2.0`（注释里指向本文件）。比建 shared-types 常量值简单；3 处同步可以靠 PR review 保证。
