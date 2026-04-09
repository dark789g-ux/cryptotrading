# 关键约束与编码规范

本文档列出 `cryptotrading` 项目的强制性约束（Invariants），所有代码变更必须遵守。

---

## 约束一览

| 约束域 | 规则 |
|--------|------|
| **API 访问** | 所有币安 REST 请求必须经过 `_safe_get()`；监控 `X-MBX-USED-WEIGHT-1M`；触发 429 时指数退避；**禁止**裸调用 `requests.get()`。 |
| **缓存格式** | CSV 使用 `utf-8-sig` 编码；`exchange_info.csv` 缓存 TTL ≥ 3600 秒；仅保留 `status == TRADING` 且 `quoteAsset == USDT` 的标的。 |
| **脚本配置** | 所有可调参数在文件顶部以大写常量声明，**禁止**使用 `argparse`。 |
| **时间对齐** | K 线 `open_time` 统一存储为 UTC+8 字符串（`YYYY-MM-DD HH:MM:SS`）；4h / 1d 聚合以 UTC+8 日边界为准。 |
| **文件编码** | 所有 `.py` 文件首行必须声明 `# -*- coding: utf-8 -*-`。 |
| **并发控制** | 多线程任务依据机器核数设置 `MAX_WORKERS`，配合信号量限速，避免耗尽币安 API 权重。 |
| **代码组织** | 单个 Python 文件不超过 500 行；按职责拆分模块（数据获取、指标计算、回测引擎、报告生成），避免单文件臃肿。 |

---

## 币安限速规范

详见 [`doc/binance-rate-limit.md`](binance-rate-limit.md)，包含完整代码示例。

核心要点：

- 每分钟权重上限：`1200`（Spot）
- `_safe_get()` 在每次请求后检查响应头 `X-MBX-USED-WEIGHT-1M`
- 权重超过阈值时主动 `sleep`，触发 429 / 418 时指数退避重试
- 禁止在循环中无限速地裸调 `requests.get()`

---

## 交易对缓存规范

详见 [`.cursor/rules/fetch-symbols.mdc`](../.cursor/rules/fetch-symbols.mdc)。

核心要点：

- 唯一数据源：`GET /api/v3/exchangeInfo`
- 缓存文件：`cache/exchange_info.csv`，列包含 `symbol`、`status`、`quoteAsset` 等
- 读取时检查文件修改时间，TTL 内直接复用，避免重复请求

---

## CSV 列规范

### 1h K 线标准列（`cache/1h_klines/{symbol}_1h.csv`）

| 列名 | 类型 | 说明 |
|------|------|------|
| `open_time` | str | UTC+8 时间字符串 |
| `open` / `high` / `low` / `close` | float | OHLC 价格 |
| `10_quote_volume` | float | 成交额 |
| `MA5` / `MA30` / `MA60` / `MA120` / `MA240` | float | 移动均线 |
| `DIF` / `MACD` | float | MACD 指标 |
| `KDJ.J` | float | KDJ J 值 |
| `loss_atr_14` | float | ATR 止损距离（可选） |
| `stop_loss_pct` | float | 止损百分比（可选） |
| `risk_reward_ratio` | float | 盈亏比（可选） |
