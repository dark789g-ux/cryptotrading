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


def trade_cal_covers(
    session: Session,
    start_date: str,
    end_date: str,
    exchange: str = "SSE",
) -> bool:
    """检查 raw.trade_cal 是否覆盖 [start_date, end_date]。

    用途：runner 触发 factor_window_short 时，先用本函数区分
      - True  → trade_cal 已覆盖，确属"窗口内交易日不足"
      - False → trade_cal 未同步到这段时间，归因不同（应 warn trade_cal_not_synced）
    """
    sql = text("""
        SELECT MIN(cal_date), MAX(cal_date) FROM raw.trade_cal WHERE exchange = :ex
    """)
    row = session.execute(sql, {"ex": exchange}).first()
    if row is None or row[0] is None:
        return False
    cal_min, cal_max = row
    return cal_min <= start_date and end_date <= cal_max


def shift_calendar_days(yyyymmdd: str, delta: int) -> str:
    """按日历日加减（非交易日）。

    显式命名为 "calendar_days" 是因为 PIT 窗口本身就是日历日窗口，
    与"按交易日 shift"区分清楚，避免后续调用方误用。
    """
    d = datetime.strptime(yyyymmdd, "%Y%m%d") + timedelta(days=delta)
    return d.strftime("%Y%m%d")


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
    window_start = shift_calendar_days(trade_date, -factor.pit_window_days)

    # 前置归因：先确认 trade_cal 真覆盖了这段时间
    if not trade_cal_covers(session, window_start, trade_date):
        logger.warning(
            "trade_cal_not_synced",
            extra={
                "factor_id": factor.factor_id, "trade_date": trade_date,
                "window_start": window_start,
                "remedy": "请先同步 raw.trade_cal 到该日期范围，再重跑因子",
            },
        )
        _emit_job_warning(job_id, "trade_cal_not_synced", factor_id=factor.factor_id, ...)
        continue   # skip 该因子当天，归因明确

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
        retry_start = shift_calendar_days(trade_date, -retry_window_days)
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
    """返回独立 DataFrame，不修改入参 base_df。"""
    # 若 base_df 的最早 trade_date 已 <= retry_start，切片复用（pandas slice 返回视图，但下游不写）
    base_min = base_df.index.get_level_values("trade_date").min()
    if base_min <= retry_start:
        return base_df.loc[(slice(retry_start, trade_date), slice(None)), :]

    # 否则补拉并 concat 到新对象；显式不 sort_index 回写 base_df
    extra = _fetch_raw_for_window(session, factor.category, retry_start, base_min)
    return pd.concat([extra, base_df.copy()]).sort_index()
```

> **不污染其它 factor 的取数边界**：扩窗后的 `sub_for_factor` 只给当前 factor 用；其它 factor 用各自 `pit_window_days` 切片 `base_df`。`base_df.copy()` 在补拉路径保证原对象不被 `sort_index` 副作用影响。

### 3.2.4 重试也失败的处理

- 写 `factor_window_retry_failed` warning（区别于 `_short`）
- 该因子当天 `skip`，不调 compute
- DB 里这一天这一只股票的该因子没有行（与"停牌"同等处理，但有 SSE warning 可追溯）

## 3.3 后续：SSE 推送、启动校验、常量

警告聚合写入 `ml.jobs.warnings`、SSE payload 形态、前端展示、启动期校验、常量定义等内容已拆到 [06-warnings-and-startup.md](./06-warnings-and-startup.md)，以保持本文档聚焦 runner 取数 / 护门核心。

跨文档锚点：

- 警告写入与 SSE 推送 → [06 §6.1 + §6.2](./06-warnings-and-startup.md#61-警告聚合写入-mljobswarnings)
- 前端展示 → [06 §6.3](./06-warnings-and-startup.md#63-前端展示)
- 启动期校验 → [06 §6.4](./06-warnings-and-startup.md#64-启动期校验扩展)
- 常量定义 → [06 §6.5](./06-warnings-and-startup.md#65-常量定义)
