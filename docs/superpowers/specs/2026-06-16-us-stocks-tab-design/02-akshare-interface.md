# 02 · AkShare 美股接口

> 数据完整性铁律：接口名/字段名进硬断言/落库前**必须落官方文档与真实调用核验**，禁止凭记忆或邻近接口推断。本节区分「已核验」与「实现期必核」。

## 已核验（WebFetch/WebSearch akshare 官方文档）

- **`stock_us_daily(symbol, adjust)`**（数据源：新浪）
  - `symbol`：裸 ticker，如 `"AAPL"`。
  - `adjust`：`""`（不复权）/`"qfq"`（前复权价）/`"hfq"`（后复权价）/`"qfq-factor"`（前复权因子）/`"hfq-factor"`（后复权因子）。
  - 无需 token/积分（爬虫源）。
  - `"hfq-factor"` 语义同 Tushare `adj_factor`（后复权累计因子），可直接套用现有「qfq = 原始价 × 当日因子 / 最新因子」。
- 另有 `stock_us_hist`（东财源）：字段更丰富但 symbol 是 `105.AAPL` 内部码、**不单独给复权因子** → 不选。

## 实现期必核（写进 fail-fast，禁凭印象）

1. **`stock_us_daily` 真实返回列名与 symbol 接受格式**：用真实一次调用核验 `adjust=""` 的列（预期 `date/open/high/low/close/volume`，是否带 `amount` 待核），以及裸 `AAPL` 是否全部可用、个别是否需前缀。`raw.us_daily_quote` 的列映射以真实列名为准。
2. **复权因子语义校验**：文档提到「不复权数据 × factor + adjust」可能含加法项。实现期**用真实数据核验**：对同一 ticker 同时取 `adjust="qfq"`（ground truth）与（`adjust=""` + 因子自算 qfq），断言两者在容差内吻合（既验公式正确、又当回归保护）。若纯乘法不成立，调整 qfq 重算逻辑或直接以 `adjust="qfq"` 校准。
3. **美股名称/代码列表接口（P2，v1 不必）**：候选 `get_us_stock_name` / `stock_us_spot_em`，确切函数名、字段、代码格式能否对齐 `stock_us_daily` 的裸 ticker——P2 实现全名单同步时再核。v1 用 CSV 播种，不依赖此接口。

## v1 的 symbol 来源（绕开列表接口）

v1 的 tracked 集来自 `doc/us_stocks_themes (1).csv`（62 只裸 ticker），直接播种 `raw.us_symbol`，**不调** AkShare 名单接口。因此 v1 只硬依赖 `stock_us_daily` 一个接口。

## 限频与稳健

- AkShare 是爬虫源，稳定性/限频弱于官方 API。`akshare_client` 仿 `tushare_client.py` 加：请求间隔（可配 `US_SYNC_MIN_INTERVAL_MS`）、最多 3 次指数退避、空数据双路径 warn。
- 逐 ticker 串行/低并发（避免被源限流）；62 只全历史可接受。规模扩到全美股的增量策略属 P2。
