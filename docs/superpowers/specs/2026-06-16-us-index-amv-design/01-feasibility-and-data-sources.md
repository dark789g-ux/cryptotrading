# 01 · 可行性验证与数据源

> 本文档固化 Phase 1 一次性可行性验证的实测结论。临时脚本在 `tmp/phase1_us_amv/`（实现完成后清理）。

## 1. 东财 `stock_us_hist` —— 本机不可达，弃用

压测：用 `ak.stock_us_hist(symbol="105."+ticker, ...)` 批量取 101 只纳指100 成分成交额（带 3 次重试 +
退避），结果：

```text
101 只 → 成功 1 只(LIN，重试2次)，失败 100 只，成功率 0.99%，430 秒
失败全是 ConnectionError: RemoteDisconnected（东财对本机近乎全程拒连）
```

印证生产代码注释 [akshare_client.py:4](apps/quant-pipeline/src/quant_pipeline/sync/akshare_client.py:4)「东财系本机不可达」，
推翻交接文档「间歇可达」前提。**整条管线不依赖东财。**

## 2. 新浪 `stock_us_daily` —— 可达，volume×close 还原成交额

新浪是现有生产 us-stocks 管线用的源（[us_daily.py:63](apps/quant-pipeline/src/quant_pipeline/sync/us_daily.py:63)）。
实测 101/101 全成、56 秒、全部首次命中。返回列 `date/open/high/low/close/volume`（**无成交额**，
`volume` = 成交股数）。

**成交额还原** = `volume × close`（当天总股数 × 收盘价 ≈ 当天美元换手总额）。

### 2.1 proxy 精度（LIN 同股同日对拍东财真值，615 天）

LIN 是东财唯一取成功的标的，用它做金标准对拍：

```text
新浪(volume×close) vs 东财真实成交额：
  平均绝对误差   0.281%
  中位绝对误差   0.151%
  误差 > 2% 的天  6 / 615（皆暴涨暴跌日，收盘价离当天均价远）
  最大误差       19.3%（个别极端日）
旁证：东财自身「成交量×收盘」对它自己的「成交额」平均误差 0.201%
  → 数学上成交额 ≈ 量×价，proxy 不是巧合。
```

**为何落到 AMV 更小**：AMV 公式里成交额先过 `tdSma(10)` 平滑，单天误差被摊薄；且 101 只 Σ 聚合，
各股误差方向随机相互抵消。**实务可当真值用。**

### 2.2 口径让步（必须在交付说明里标注）

- 个别暴动日（财报 / 崩盘）单股 proxy 可能偏差到百分之十几，但聚合 + 平滑后对整条曲线无伤。
- amount 单位：US `Σ(close×volume)` 已是 USD 美元，**不**再 ×1000（A 股那步 `amt×1000` 是千元→元，
  见 [03-amv-formula.md](./03-amv-formula.md#美股口径差异)）。

## 3. 成分名单 —— Wikipedia 全 101，stockanalysis 退化只给 25

| 源 | 结果 |
|---|---|
| Wikipedia `Nasdaq-100`（pandas read_html） | **稳定全 101 只**（含 GOOGL/GOOG 双重股权）；列 `Ticker/Company/ICB...` |
| stockanalysis API `/api/symbol/e/QQQ/holdings` | **退化只返回 25 只**带权重（疑似分页 / 限流截断），非交接文档说的全 101 |

**结论**：成分全集 = Wikipedia 101；权重（`weight_pct`）只能拿到 top-25，余下 76 只 `weight_pct=NULL`。
本设计**裸 Σ 不加权**，权重仅作参考列存着（未来若做加权再议）。

## 4. `.NDX` 指数点位 —— 可取（用于价格侧）

`ak.index_us_stock_sina(symbol=".NDX")` 返回 3099 行（2014-02-18 起），含 `close=30543.918`。
现有 `us_index_sync` 已把 `.NDX` 灌进 `raw.us_index_daily`（OHLCV，amount 丢弃）。
AMV 价格侧直接读 `raw.us_index_daily WHERE index_code='.NDX'`，**无需重复取数**。

## 5. 一条 QQQ AMV 曲线（量级体检）

新浪取全 101 → `Σ(close×volume)` + `.NDX` 点位 + ×0.1 公式（Phase 1 用简单均线，正式实现改 `tdSma`）：

```text
615 交易日对齐(2024-01-02~2026-06-15) · member_count 99~101(近期满101)
amv_close ~3.5e10 → 4.1e10 平滑波动 · nunique 614/615(无死值)
amv_macd 正常变号(-5.4e8 → +5.3e8) · Σ成交额近60日均 3.18e11 USD/日
```

量级健康、非退化。绝对量级 ~4e10 偏大（未做 /1e6），但**副图有独立 y 轴**，不影响渲染，已与用户确认
保持行业 AMV 口径（×0.1、不缩放）。

## 6. 历史成分近似（已知局限）

历史回算用**当前 101 名单**（不追历史成分变动）。早期未上市 / 后纳入的成分在其上市前无数据 →
当日 `member_count < 101`（仅少数早期日，见上 99~101）。这是「当前名单近似」的固有误差，**可接受**，
作为已知口径让步标注。未来若要精确历史成分，需建成分快照表（超出本 MVP 范围）。
