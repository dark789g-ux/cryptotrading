# 03 · Python 采集管线（quant-pipeline）

← 返回 [index.md](./index.md)

镜像美股个股管线但**更简单**：单次抓取、无 qfq/无 adj_factor。代码在 `apps/quant-pipeline/src/quant_pipeline/`。

## 0. 落库前硬约束（`.claude/rules/data-integrity.md`）

实现首步：`uv run python` 实跑 `ak.index_us_stock_sina(symbol=".NDX")`，**亲眼确认**列名（`date/open/high/low/close/volume/amount`）、symbol 带前导点、`amount` 恒 0，再写 fail-fast / 落库。本 spec 的事实虽已一手验证，二次确认是硬规范。

## 1. akshare_client.py — 加 `fetch_us_index`

镜像 `fetch_us_daily`（[akshare_client.py:43](../../../../apps/quant-pipeline/src/quant_pipeline/sync/akshare_client.py)）的限频/重试/空数据双路径骨架：

```python
def fetch_us_index(self, symbol: str) -> UsFetchResult:
    # 复用 _throttle() / for attempt in range(max_attempts) 重试
    # 内部调 ak.index_us_stock_sina(symbol=symbol)，api_name="index_us_stock_sina"
    # 空数据双路径(复用现有 warn):
    #   df is None        → log "akshare_empty_data_null"  → empty_path="data_null"
    #   len(df) == 0      → log "akshare_empty_items_empty" → empty_path="items_empty"
    # 返回 UsFetchResult(df, empty_path)；df 含 date/open/high/low/close/volume/amount
```

无需改 `UsFetchResult` dataclass。`amount` 列后续丢弃。

## 2. sync/us_index.py — 单标的 fetcher（新）

```python
def sync_us_index_for_symbol(*, index_code: str, start_date: str, end_date: str,
                             client: AkShareClient) -> UsIndexReport:
```

流程（比 us_daily 少一次 qfq 抓取与 adj_factor 派生）：

```text
1. res = client.fetch_us_index(index_code)
   res.df is None / empty_path → return UsIndexReport(index_code, empty_path=res.empty_path)   # 透出
2. 规整: date 'YYYY-MM-DD' → trade_date 'YYYYMMDD'（去 '-'）; 选列 open/high/low/close/volume
3. 窗口裁切 [start_date, end_date]（YYYYMMDD 字符串比较）+ 按 trade_date 去重(保留最后一条)
   裁切后 0 行 → return UsIndexReport(index_code, empty_path="window_empty")                    # 透出
4. upsert raw.us_index_daily  via _upsert.upsert_rows(conflict=('index_code','trade_date'))
   rows 列: index_code, trade_date, open, high, low, close, volume
5. ind = calc_us_indicators(opens=, highs=, lows=, closes=)   # 复用; 输入升序 OHLC
   逐行拼 {index_code, trade_date, **ind[i]} → upsert raw.us_index_indicator
   （ind[i] 的键 = INDICATOR_KEYS 17 列，与 01 DDL 列名一一对齐 → 动态 upsert 零改）
6. return UsIndexReport(index_code, rows=len, indicator_rows=len)
```

- **幂等**：`_upsert.upsert_rows` 的 `ON CONFLICT (index_code, trade_date) DO UPDATE SET ... updated_at=now()`（[_upsert.py:117](../../../../apps/quant-pipeline/src/quant_pipeline/sync/_upsert.py)）。
- **无复权**：指数无 adj_factor 概念，**不写** `raw.us_adj_factor`、**不抓** qfq。`calc_us_indicators` 直接吃裁切后的 OHLC。
- `calc_us_indicators`（[us_indicators.py:99](../../../../apps/quant-pipeline/src/quant_pipeline/sync/us_indicators.py)）需 open/high/low/close 四序列；指数齐备。n=0 返回 `[]`，安全。

## 3. sync/us_index_orchestrator.py — 编排（新）

镜像 `run_us_sync`（[us_orchestrator.py:55](../../../../apps/quant-pipeline/src/quant_pipeline/sync/us_orchestrator.py)）：

```python
def run_us_index_sync(*, job_id: UUID | None, date_range: str,
                      symbols: tuple[str, ...] | None = None) -> UsIndexSyncOutcome:
    # symbols 缺省 = ('.NDX',)  —— v1 硬编码, 无 catalog/tracked 查询
    # _parse_date_range(date_range): 'YYYYMMDD:YYYYMMDD' 冒号分隔, 两段 8 位数字
    # for index_code in symbols: rep = sync_us_index_for_symbol(...); 累计 failed_items
    #   rep.empty_path is not None → failed_items.push(rule="us_index_empty", apiName, params)
    # job_id 非空: 每标的/末批 update_progress(job_id, pct, stage=f"us_index_sync:{code}")
```

**failed_items 透出**（`.claude/rules/data-integrity.md`）：空/0 行用 rule `us_index_empty`，禁 `.catch(()=>[])` 静默吞错，apiName + 完整 params 一并带上。

## 4. worker/dispatcher.py — 路由（改）

```python
def _runner_us_index_sync(job: Job) -> None:          # 新, 镜像 _runner_us_sync:128-146
    from quant_pipeline.sync.us_index_orchestrator import run_us_index_sync
    params = job.params or {}
    date_range = params.get("date_range")
    if date_range is None:                            # UI 无参同步 → 兜底默认全量(保证按钮可用)
        date_range = f"20100101:{date.today():%Y%m%d}"
    if not isinstance(date_range, str) or ":" not in date_range:   # 严格校验, 同 _runner_us_sync:143
        raise ValueError(f"us_index_sync params.date_range 必须 'YYYYMMDD:YYYYMMDD', got {date_range!r}")
    symbols_raw = params.get("symbols")               # 可选; 非空字符串数组校验
    symbols = tuple(symbols_raw) if symbols_raw else None   # 缺省 None → orchestrator 用 ('.NDX',)
    run_us_index_sync(job_id=job.id, date_range=date_range, symbols=symbols)
```

`_ROUTES` 注册：在 [dispatcher.py:433](../../../../apps/quant-pipeline/src/quant_pipeline/worker/dispatcher.py) 的 `_ROUTES = { ... }` **字面量内部**追加一行（与现有 `"us_sync": _runner_us_sync` 同格式，保持路由表集中可见），**勿**在字面量外用下标赋值：

```python
_ROUTES = {
    ...
    "us_sync": _runner_us_sync,
    "us_index_sync": _runner_us_index_sync,   # ← 新增
    ...
}
```

> ⚠️ 兜底默认全量是**有意与 us-stocks 不同**：us-stocks 的 `_runner_us_sync` 缺 date_range 直接 ValueError（其 UI 同步按钮 latent bug，见 [02 sync 注](./02-backend-nestjs.md)）；本模块要让「美股指数」面板的无参同步真能跑通，故在 runner 兜底。`date` 来自 `from datetime import date`（CLI/worker 入口 import，非 dead-path）。

## 5. cli.py — 命令（改）

```python
@app.command("us-index-sync")                          # 镜像 us-sync:233
def us_index_sync(date_range: str = typer.Option(..., "--date-range"),
                  symbols: str = typer.Option("", "--symbols")):  # 逗号分隔, 缺省 .NDX
    # validate_date_range → run_us_index_sync(job_id=None, ...) → stdout 汇总 → errors 非空 exit 1
```

去掉个股的 `--tracked` 逻辑（指数无 tracked 集合）。首灌：`quant us-index-sync --date-range 20100101:<today> --symbols .NDX`。

## pytest（补美股管线测试空白）

现有 us 管线 pytest 零覆盖；新增：

- `test_akshare_index_client.py`：`fetch_us_index` `df=None`→`data_null`、`df=[]`→`items_empty`、重试耗尽 raise。
- `test_us_index.py`：mock client → `empty_path`/`window_empty` 路径各返回正确 `UsIndexReport`；mock `upsert_rows` 验幂等调用 2 表；固定 OHLC fixture 断言 `calc_us_indicators` 关键值（MA5/KDJ/MACD）非空。
- `test_sync_dispatcher_route.py` 追加：`_ROUTES["us_index_sync"].__name__ == "_runner_us_index_sync"`。

## 验证

`uv run pytest` 全过 + CLI 首灌后 `raw.us_index_daily` 最新 close ≈ 30543（对照 2026-06-15）、`raw.us_index_indicator` 同日 ma5/kdj_j/macd 非空。
