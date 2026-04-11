# 根目录脚本说明

本文档列出 `cryptotrading/` 根目录下所有可执行脚本的详细说明、输入输出及注意事项。

---

## 脚本速查表

| 脚本 | 功能描述 | 输出 |
|------|---------|------|
| `fetch_symbols.py` | 拉取币安 `exchangeInfo`，过滤 `TRADING` 状态的 USDT 交易对并写入缓存 | `cache/exchange_info.csv` |
| `fetch_klines.py` | 批量拉取 K 线并计算指标；周期由脚本内 `KLINE_INTERVAL`（`1h` / `4h` / `1d`）选择 | `cache/<周期>_klines/` |
| `patch_klines_indicators.py` | 补全或重算已有 CSV 中的所有指标列 | 原地覆盖 CSV |
| `update_indicators.py` | 历史补丁：为旧版 CSV 增量添加止损 / 盈亏比列 | 原地覆盖 CSV |
| `convert_klines_time.py` | 将毫秒时间戳幂等转换为 UTC+8 字符串 | 原地覆盖 `1h_klines/` |
| `backtest_strategy.py` | 回测入口：加载数据 → 运行引擎 → 写出结果 | `backtest_results/{run_id}/` |
| `main.py`（`uvicorn main:app`） | FastAPI：标的 / K 线 / 回测 / 同步 API + 托管 Vue 构建产物 | HTTP :8000 |
| `generate_random.py` | 输出随机整数（仅用于调试） | stdout |

---

## 数据采集流水线

### `fetch_symbols.py`

- 调用 `GET /api/v3/exchangeInfo`，筛选条件：`status == TRADING` 且 `quoteAsset == USDT`
- 结果写入 `cache/exchange_info.csv`（`utf-8-sig` 编码）
- 缓存 TTL ≥ 3600 秒，未过期时跳过请求

### `fetch_klines.py`

- 读取 `exchange_info.csv` 获取标的列表
- 在脚本中设置 `KLINE_INTERVAL` 为 `1h`、`4h` 或 `1d`，多线程拉取对应 `interval` 的 `GET /api/v3/klines`
- 实时计算技术指标后写入 `cache/{interval}_klines/{symbol}_{interval}.csv`
- 增量更新时会回溯 `UPDATE_LOOKBACK_DAYS` 天，以保证指标准确
- 并发数由 `MAX_WORKERS` 控制，配合信号量限速；数据同步页的 SSE 会触发本脚本，实际周期以脚本内 `KLINE_INTERVAL` 为准

### `patch_klines_indicators.py`

- 对已存在的 CSV 文件重新计算全部指标列
- 幂等操作，可反复执行；用于指标逻辑变更后的批量补全

### `convert_klines_time.py`

- 将 `open_time` 列从毫秒时间戳转换为 `YYYY-MM-DD HH:MM:SS`（UTC+8）
- 幂等：已是字符串格式则跳过

---

## HTTP 服务（`main.py` / `uvicorn main:app --port 8000`）

- 根路径托管 Vue 前端（需先 `cd frontend && npm run build`）。
- 标的与 K 线：`GET /api/symbols/kline-columns`、`GET /api/symbols/names`、`POST /api/symbols/query`、`GET /api/klines/{interval}/{symbol}` 等（见 `api/symbols.py`）。
- 回测与同步：`api/backtest_api.py`、`api/sync_api.py`。
