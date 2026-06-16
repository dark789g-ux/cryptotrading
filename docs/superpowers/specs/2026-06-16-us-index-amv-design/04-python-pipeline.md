# 04 · Python 管线（取数 / 聚合 / 编排 / dispatcher / cli / seed）

> 全程遵守 `.claude/rules/data-integrity.md`：空数据双路径 warn、0 行进 failed_items、禁
> `.catch(()=>[])` 静默吞错、东财间歇失败必重试。run_type=`us_index_amv_sync` 走 Python worker。

## 模块划分

| 文件 | 职责 |
|---|---|
| `sync/us_index_amv_formula.py` | 纯公式（见 [03](./03-amv-formula.md)） |
| `sync/us_index_constituent.py` | 成分名单 seed（CSV→`raw.us_index_constituent`）+ 读名单 helper |
| `sync/us_index_amv.py` | 取数 + Σ 聚合 + 套公式 + 写 `raw.us_index_amv_daily` |
| `sync/us_index_amv_orchestrator.py` | `run_us_index_amv_sync` 编排（镜像 `us_index_orchestrator.py`） |
| `worker/dispatcher.py` | `_runner_us_index_amv` + `_ROUTES` 注册 |
| `cli.py` | `us-index-amv-sync` + `us-index-constituent seed` 命令 |
| `data/us_index_constituent_ndx.csv` | checked-in 101 只 `.NDX` 成分 seed |

## 1. 成分股取数（不污染策划清单）

`raw.us_daily_quote` **无外键到 `us_symbol`**（真 DB 核验），`sync_us_daily_for_ticker` 按显式 ticker
写库不校验归属。所以成分股**直接灌 `raw.us_daily_quote`、不进 `raw.us_symbol`**，美股个股 Tab（只读
`us_symbol` 策划清单）零污染。

取数复用 [sync_us_daily_for_ticker(*, ticker, start_date, end_date, client)](apps/quant-pipeline/src/quant_pipeline/sync/us_daily.py:58)：
- 它取**不复权 + 前复权**两次新浪 → 写 `us_daily_quote`/`us_adj_factor`/`us_daily_indicator`。
- AMV **只消费 `us_daily_quote` 的原始 `close`、`volume`**（真实美元成交额 = close×volume，非复权）；
  qfq / indicator 是副产物（无害、幂等）。
- 返回 `UsDailyReport(ticker, quote_rows, factor_rows, indicator_rows, empty_path, factor_empty)`。
  - `empty_path != None`（data_null / items_empty / window_empty）→ 该成分当日无行情 → **AMV 关心**，
    记 failed_items（rule=`us_daily_empty`）。
  - `factor_empty=True`（qfq 缺）→ **AMV 不关心**，仅 `logger.warning`，**不**计为 AMV 失败。

> 21 只成分与现有策划股重叠 → upsert 天然去重（PK `ticker,trade_date`），不重复存储。

## 2. Σ 聚合 + 套公式（`us_index_amv.py`）

读 `raw.us_daily_quote`（成分成交额）+ `raw.us_index_daily`（.NDX 点位），用管线现有 DB 连接
（同 `sync/_upsert.py` 的 engine / psycopg2，**禁**新建连接风格）。

**成交额 Σ（裸求和，镜像 [industry-amv.service.ts:489-503]，那里是 `SUM(amount)`/`COUNT(amount)`）：**
```sql
SELECT trade_date,
       SUM(close * volume) AS amt,
       COUNT(*)            AS member_count   -- WHERE 已过滤 null close/volume，COUNT(*) 即有效成分数
FROM raw.us_daily_quote
WHERE ticker = ANY(%(tickers)s)
  AND trade_date >= %(fetch_start)s AND trade_date <= %(end)s
  AND close IS NOT NULL AND volume IS NOT NULL
GROUP BY trade_date;
```
`close`/`volume` 均 `numeric(30,10)`，乘积 numeric 无浮点误差；Python 侧转 float。`member_count` 与
industry 的 `COUNT(amount)` 等价（均 = 当日有效成分数）。

**覆盖度 warn（镜像 [industry-amv.service.ts:445-450]）**：某日 `member_count < 当前名单总数`（101）→
`logger.warning`（covered/expected），不阻断（历史成分近似，见 [01 §6](./01-feasibility-and-data-sources.md#6-历史成分近似已知局限)）。

**.NDX 价格侧：**
```sql
SELECT trade_date, open, high, low, close
FROM raw.us_index_daily
WHERE index_code = '.NDX'
  AND trade_date >= %(fetch_start)s AND trade_date <= %(end)s
ORDER BY trade_date;
```

按 `trade_date` **内连接**（只算两侧都有的日）。volume 入参 = `amt`（**不 ×1000**，见
[03 美股口径差异](./03-amv-formula.md#美股口径差异)）。

调 `calc_amv_series` → amv 四价；`calc_macd(amv_close)` → dif/dea/macd；`calc_signal` → signal；
`calc_zdf(amv_close)` → amv_zdf。**逐日：先裁热身段（`trade_date < start` 不落库），再丢弃 `invalid[i]`
异常日（不落库，[03](./03-amv-formula.md) §异常处置）**，余下组 upsert
`raw.us_index_amv_daily`（ON CONFLICT `index_code,trade_date`，**按 conflictKey 去重保留最后一条**，
`.claude/rules/database-sql.md`）。

## 3. Warmup（递归指标必须，否则增量窗口口径漂移）

`td_sma`/`td_ema` 是递归（从第一个有效值滚动）。若只在近窗 `[start,end]` 计算，种子 = 窗内首值，与全量
从头累计的「真值」不符 → 增量窗口口径漂移。需 warmup 让递归收敛。

**收敛行数由最慢的递归项决定**（务必按慢线定，别只看 `td_sma`）：
- `v1 = td_sma(volume,10)`：衰减因子 9/10，`(9/10)^90 ≈ 8e-5`（90 行足够）。
- `calc_macd(amv_close)` 用 `td_ema(amv_close,26)`：衰减因子 `(N-1)/(N+1)=25/27≈0.926`，**更慢**，
  `(25/27)^90 ≈ 9.8e-4`（90 行只到 ~1e-3），`(25/27)^150 ≈ 1.3e-5`（150 行才到 1e-5 量级）。
- → 取 **`WARMUP_ROWS = 150` 交易行**（覆盖 td_sma 与 MACD 慢线，全列收敛到 <1e-5）。

**取法按交易行、不按自然日**（逐字镜像 [industry-amv.service.ts:520-533 resolveWarmupStart](apps/server/src/market-data/active-mv/industry-amv.service.ts:520)）：
查 `raw.us_index_daily WHERE index_code=:idx AND trade_date < :start ORDER BY trade_date DESC LIMIT 150`，
取最早一行的 `trade_date` 作 `fetch_start`（无更早行则 `fetch_start = start`，首次全量自然 clamp）。
`.NDX` 指数表本身就是美股交易日历，成分股同历，故用它定 warmup 起点确定、无自然日近似的浮动。

**成分股取数（步骤1）与读取（步骤2）都用 `fetch_start`**，计算全序列后**只 upsert `trade_date >= start`**
的行（warmup 段只为种子，不落库；与 [03 异常处置](./03-amv-formula.md) 的裁热身一致）。
07 §1 的 warmup-parity 测试**须验 amv_close 与 amv_dif/dea/macd/signal 全列**一致（不能只验 amv_close）。

## 4. orchestrator（`run_us_index_amv_sync`，镜像 [us_index_orchestrator.py:55]）

```python
def run_us_index_amv_sync(*, job_id, date_range, symbols=None, client=None) -> UsIndexAmvOutcome:
    start, end = parse_date_range(date_range)        # 复用现有 _parse_date_range 风格
    index_codes = list(symbols) if symbols else ['.NDX']
    for index_code in index_codes:                   # 当前仅 .NDX，结构留多指数
        check_cancel_requested(job_id)               # 复用 worker.progress
        tickers = load_constituents(index_code)      # raw.us_index_constituent
        fetch_start = resolve_warmup_start(index_code, start)  # 按交易行查 .NDX 表(§3)，非自然日
        # 步骤1：取成分行情 [fetch_start,end] → us_daily_quote（逐 ticker 复用 sync_us_daily_for_ticker）
        # 步骤2：读 [fetch_start,end] Σ聚合 + .NDX 点位 + 套公式 → 裁热身/丢异常 → upsert us_index_amv_daily
        update_progress(...)                          # 取数 / 聚合 / 写 三阶段进度
    return outcome   # rows_total, amv_rows_total, constituents_done, failed_items, errors
```

- `UsIndexAmvOutcome`：`rows_total`（成分 quote 行）、`amv_rows_total`（AMV 行）、`constituents_done`、
  `failed_items: list[UsIndexAmvFailedItem(index_code, ticker, api_name, reason, rule)]`、`errors: list[str]`。
- 单成分失败逐个 `except` 记 `errors`，不中断整批（镜像 us_index_orchestrator）。
- 成分 0 行 / 空 → failed_items（rule=`us_daily_empty`）；若**全部成分**取数失败致某日无 Σ → 该日不写、
  记 errors（禁伪装成功）。

## 5. dispatcher（`_runner_us_index_amv`，镜像 [dispatcher.py:176-221]）

```python
def _runner_us_index_amv(job: Job) -> None:
    from quant_pipeline.sync.us_index_amv_orchestrator import run_us_index_amv_sync
    params = job.params or {}
    date_range = params.get("date_range") or f"20140101:{date.today():%Y%m%d}"   # 兜底全量
    if not isinstance(date_range, str) or ":" not in date_range: raise ValueError(...)
    symbols = _parse_symbols(params.get("symbols"))   # 同 us_index_sync：list[str]|None 校验
    outcome = run_us_index_amv_sync(job_id=job.id, date_range=date_range, symbols=symbols)
    if outcome.failed_items or outcome.errors:
        logger.warning("us_index_amv_sync_job_completed_with_issues", extra={...})
```
- 返回 None；job 终态由 `Dispatcher.dispatch` 统一写（success / requeue / failed）。
- `_ROUTES["us_index_amv_sync"] = _runner_us_index_amv`（[dispatcher.py:491] 附近，与 us_index_sync 同段）。

## 6. cli（镜像 [cli.py:216-331]）

- `@app.command("us-index-amv-sync")`：`--date-range`（必填 YYYYMMDD:YYYYMMDD，`validate_date_range`）+
  `--symbols`（可选逗号分隔，缺省 `.NDX`）→ `run_us_index_amv_sync(job_id=None, ...)` → echo 汇总 →
  errors 非空 `raise typer.Exit(1)`。
- `us-index-constituent` 子 Typer + `seed --csv`：调 `seed_us_index_constituent_from_csv(csv_path)`
  upsert `raw.us_index_constituent` → echo `rows_upserted / tickers`。镜像 `us-symbols seed`。

## 7. seed CSV 内容

`data/us_index_constituent_ndx.csv`：列 `index_code,ticker,name,weight_pct`，101 行 `.NDX` 成分
（Wikipedia 全集；weight_pct 仅 25 只有值，余空）。Phase 1 `tmp/phase1_us_amv/constituents.json` 可作来源。
