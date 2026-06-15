# 02 · AkShare 美股接口

> 数据完整性铁律：接口名/字段名进硬断言/落库前必须落源头核验。本节的「真机已核验」段以 `uv run python` 实跑结果为准（2026-06-16，akshare==1.18.64），**取代**早期凭文档的假设。

## 真机已核验（实跑，权威）

唯一可靠接口：**`ak.stock_us_daily(symbol, adjust)`**（数据源：**新浪**）。东财系 `stock_us_spot_em` / `stock_us_hist` 在本机网络 **ConnectionError（远端断连）不可用**，不依赖。

- `symbol`：**裸 ticker**（`"AAPL"`/`"NVDA"`…）。CSV 全部 62 只均以裸 ticker 成功。
- 返回列（**实测**）：`date, open, high, low, close, volume` —— **无 `pre_close`、无 `amount`**。`date` 为 datetime，落库转 `YYYYMMDD`。
- `adjust` 实测：
  - `""` → **不复权** OHLCV（干净）。✓
  - `"qfq"` → 前复权 OHLCV。**近窗口干净**（最新日 == 不复权），仅**深历史**（如 1984）有加性伪影致负值——本次窗口 2025-2026 无此问题（实测全正）。
  - `"hfq-factor"` / `"qfq-factor"` → **返回 `None`**（本版不支持）。**故复权因子无法直接取**。
- 无需 token/积分（爬虫源）。

## 复权因子：派生而非直取（已实测验证）

因 `hfq-factor` 返回 None，**复权因子由两次抓取派生**：

```text
raw = stock_us_daily(tk, adjust="")     # 不复权 OHLCV
qfq = stock_us_daily(tk, adjust="qfq")  # 前复权 OHLCV
adj_factor_t = qfq.close_t / raw.close_t   # 后复权-style 乘性因子(每日)
```

实测样本（14 只含 NVDA/MSFT/TSLA/PLTR/COIN/CRCL/BMNR/OKLO/IONQ/LLY/JPM/TLN/GEV，窗口 2025-01-01..2026-06-12）：
- 因子区间约 `0.96 ~ 1.0`，**最新日恒 = 1.0000**（前复权锚定最新），**窗口内无负 qfq**。
- 据此**存 raw + 派生 adj_factor**，再用 A 股同款 SQL `qfq_x = raw_x × adj_factor / 最新adj_factor` 重算 qfq_*（最新因子≈1）。
- **Ground-truth 校验**：重算的 `qfq_close` 应 ≈ 抓取的 `qfq.close`（容差内），作回归护门（替代早期设想的 adjust="qfq" 校验，现就是它本身）。

## 已知数据质量问题

- **`SPCX`**：实测窗口内仅 **1 行**（非真 SpaceX——SpaceX 未上市，此为新浪侧某退市/SPAC 残值）。不报错、会落 1 行；同步后**显式告知用户**该行非真实 SpaceX，由用户决定剔除。
- 近窗口个别 ticker 行数 < 362（如 CRCL/BMNR 257，2025 年内上市）属正常，非缺失。

## 限频与稳健

- 新浪爬虫源，弱于官方 API。`akshare_client` 加：请求间隔（`US_SYNC_MIN_INTERVAL_MS`，默认 ~200ms）+ 最多 3 次指数退避 + 空数据双路径 warn（`df is None` / `len==0`）。
- 逐 ticker 低并发串行；62 只全量可接受。扩全美股的增量/名单同步属 P2（依赖东财名单接口，本机暂不可达，P2 再议）。
