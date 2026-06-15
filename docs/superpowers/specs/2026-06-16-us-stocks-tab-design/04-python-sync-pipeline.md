# 04 · Python 同步管线（quant-pipeline）

新增文件（`apps/quant-pipeline/src/quant_pipeline/`）：

```text
sync/akshare_client.py      AkShare 封装: 限频 + 重试 + 空数据双路径 warn (仿 tushare_client.py)
sync/us_symbol.py           CSV 播种 → upsert raw.us_symbol (不覆盖 tracked); P2: AkShare 全名单
sync/us_daily.py            tracked ticker 循环: 抓 raw+因子 → SQL qfq → 指标 → 写三表
sync/us_orchestrator.py     run_us_sync(date_range, tickers?) — CLI/Worker 共用入口
worker/dispatcher.py        +_runner_us_sync, _ROUTES["us_sync"]
cli.py                      +`quant us-sync` 与 `quant us-symbols seed` 子命令
```

## 1. akshare_client

- 延迟 `import akshare`（仅 `us_sync` 路径加载，避免拖慢 noop/其它 run_type）。
- 方法：`fetch_us_daily(ticker, adjust)` 返回 DataFrame。
- **空数据双路径 warn（铁律）**：`df is None` 与 `len(df)==0` 两条独立路径都 `logger.warn`，带 `apiName + ticker + adjust`。
- 限频：`US_SYNC_MIN_INTERVAL_MS`（默认较保守，如 300ms）+ 最多 3 次指数退避。
- 无 token。

## 2. us_daily fetcher（每只 ticker）

```text
for ticker in tickers:
  raw_df  = fetch_us_daily(ticker, adjust="")            # 不复权
  fac_df  = fetch_us_daily(ticker, adjust="hfq-factor")  # 后复权因子
  if raw_df 空:  failed_items.push({apiName:"us_daily_empty", ticker});  continue
  if fac_df 空:  failed_items.push({apiName:"us_factor_empty", ticker})  # 仍可写 raw, 但 qfq/指标退化, 标记
  归一化 date→YYYYMMDD, 过滤到 date_range [start,end]
  upsert raw.us_daily_quote(原始列, pct_chg=(close/pre_close-1)*100)   # 百分数, 与 qfq_pct_chg 同量纲
  upsert raw.us_adj_factor(adj_factor)
  -- 见 §3
```

- **禁止 `.catch(()=>[])` 静默吞错**：异常/0 行必进 `failed_items`（apiName `us_daily_empty`/`us_factor_empty`/`us_symbol_empty`），上层汇总返回，不伪装成功。
- `SPCX` 等未上市标的预期落 `us_daily_empty`，正常流程，结束如实报告。

## 3. 前复权与指标

- **qfq（SQL，幂等）**：对该 ticker 全历史 `UPDATE raw.us_daily_quote SET qfq_x = x * f.adj_factor / latest.adj_factor`，公式同 A 股 `a-shares-sync-dirty-ranges.ts:65-130`，仅换表名/键名为 `ticker`。
- **指标（Python，输入 qfq 价）**：复用 quant-pipeline 现有价格指标实现（`features/builder.py` / `factors/price.py`）；缺的（KDJ/BBI/ATR/low-high9/stop/rr）从 `apps/server/src/indicators/indicators.ts` 移植。写 `raw.us_daily_indicator`。
- **TS↔Python 对拍**：对 1–2 只 ticker 抽样，断言 Python 指标与 `indicators.ts`（同输入 qfq）在容差内一致，防展示指标发散。

## 4. orchestrator / CLI / worker

- `run_us_sync(date_range, tickers=None)`：`tickers=None` 时取 `raw.us_symbol where tracked`；否则用传入清单。遍历 → us_daily fetcher → 汇总 `failed_items` + 计数。进度按 ticker 数推进（`current/total`）。
- **CLI（本次灌数）**：
  - `quant us-symbols seed --csv "doc/us_stocks_themes (1).csv"` → 播种 us_symbol。
  - `quant us-sync --date-range 20250101:20260612 [--tickers NVDA,MSFT | --tracked]` → 直调 `run_us_sync`，不写 ml.jobs。
- **worker runner**：`_runner_us_sync(job)` 从 `job.params` 取 `date_range/tickers` → 调 `run_us_sync`，进度回写 ml.jobs（终态须 emit progress=100，否则 SSE 终态链断、前端卡 99——参见既有 kelly_sweep 教训）。

## 5. 数据完整性最弱标准（落库自检）

- 行级硬约束：`raw.us_daily_quote` 的 OHLC、`raw.us_adj_factor.adj_factor` 在该 ticker 每行非空。
- 跨表对齐（**按 ticker 独立判定**）：对成功取到因子的 ticker，其 `us_adj_factor` 行数应 `>=` 其有效 `us_daily_quote` 行数；**被标 `us_factor_empty` 的 ticker 豁免此对齐检查**（已显式记入 failed_items，不假装完整，也不误判为违例）。
