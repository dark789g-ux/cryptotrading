# 指数合成算法

## 概述

Worker（`quant-pipeline`）负责从成分股 OHLCV + 复权因子合成自定义指数日线。算法采用 **固定权重 Laspeyres 链式链接**（chain-linked），在权重版本切换日做 rebalance 链接，与主流指数编制实践一致。

```text
对每个 trade_date D:
  1. PIT 取 active weight version → members + weights
  2. 过滤：D 日有有效收盘价且未停牌的成分
  3. 计算成分日收益 r_i(D)
  4. 加权组合收益 R(D) = Σ w_i × r_i(D)
  5. Index(D) = Index(D-1) × (1 + R(D))
     [D = actual_start_date 时用 base_point 初始化；见下文]
  6. 版本切换日：rebalance + chain link（见下文）
```

---

## 成分有效性与缺失处理

| 场景 | 处理 |
|------|------|
| 成分停牌（无成交） | 当日不参与计算；权重按比例重新归一化到可交易成分 |
| 成分未上市（D < list_date） | 跳过 |
| 成分已退市（D > delist_date） | 跳过；若全部成分不可交易则该日 NULL |
| 有效成分 < 2 | 该日不产出点位，写 warning |
| 缺少 adj_factor | 用 `close/pre_close` 比值；缺失时 skip 并记 warning |

---

## 价格序列选取

### 价格指数（`index_type = price`）

使用成分 **前复权收盘价**：

```text
P_i(D) = daily_quote.close × adj_factor(D) / adj_factor(latest)
```

或直接使用已存储的前复权价（若 `a_share` 查询层已有）。收益：

```text
r_i(D) = P_i(D) / P_i(D-1) - 1
```

### 全收益指数（`index_type = total_return`）

在价格指数基础上加入分红再投资：

```text
TR_i(D) = TR_i(D-1) × (P_i(D)/P_i(D-1) + div_yield_i(D))
```

`div_yield_i(D)` 来自 Tushare `daily_basic` 或 `dividend` 除息事件；实现时优先用 **复权因子变动分解**（`adj_factor` 变化中超出价格变动部分视为分红），与现有 A 股复权体系一致。

---

## 权重计算（版本创建时）

在 version 的 `effective_date`（取最近可用交易日 T）计算：

| weight_method | 公式 |
|---------------|------|
| `equal` | w_i = 1 / N |
| `float_mv` | w_i = float_mv_i(T) / Σ float_mv |
| `custom` | 用户输入，服务端校验 Σ = 1 |

`float_mv` 来源：`raw.daily_basic.float_mv` @ T，缺失则 fallback 总市值或等权并 warning。

---

## 权重版本切换（Chain Link）

当 D = 新版本 `effective_date`：

```text
1. 用旧版本权重计算 D-1 收盘指数 level_old
2. 按新版本权重 rebalance（不重设基点）
3. 链接：新序列从 D 起 Index(D) = level_old × (1 + R_new(D))
   其中 R_new 用新权重 × 成分收益
4. 旧版本 expire_date = prev_trade_date(D)
```

**不**在调仓日重置基点（区别于「删了重建」）。

---

## OHLC 合成

V1 采用简化规则（与多数合成指数一致）：

| 字段 | 规则 |
|------|------|
| `close` | 链式链接收盘点位 |
| `open` | close(D-1) × (1 + 加权 open-to-prev_close 收益) |
| `high/low` | `close(D) × (1 + Σ w_i × (high_i(D)/P_i(D) - 1))` 与 `close(D) × (1 + Σ w_i × (low_i(D)/P_i(D) - 1))` |
| `pre_close` | 前日 close |
| `vol_hand` / `amount` | 成分简单求和（展示用，非指数官方口径） |

---

## 计算阶段（worker stage）

```text
Stage 1  load_members     ──▶ 加载版本链 + 成分
Stage 2  sync_quotes      ──▶ 批量拉成分 OHLCV/adj（PostgreSQL 只读）
Stage 3  compute_index    ──▶ 写入 custom_index_daily_quotes
Stage 4  compute_indicators ──▶ MA/MACD/KDJ/BBI/砖图
Stage 5  compute_money_flow ──▶ 聚合 money_flow_stocks
Stage 6  compute_amv      ──▶ AMV 序列
Stage 7  finalize         ──▶ status=ready
```

进度映射：`compute_progress` 按 stage 权重分配（quotes 占 50%，其余各 10%）。

---

## 除权除息

- 成分层：依赖 `raw.adj_factor` 已同步数据；worker **不**调 Tushare
- 指数层：不因单个成分除息单独调整基点（已反映在 adj 价/全收益公式中）
- 若 effective_date 落在除权日：使用除权后复权价计算新权重

---

## 边界：base_date 与实际起始日 {#actual-start-date}

- 用户填写的 `base_date` 为**语义基期**（权重快照日、版本 `effective_date` 默认值）
- **实际起始日** `actual_start_date` = 所有成分均有有效收盘价的首个共同交易日（≥ base_date）
- **`base_point` 落在 `actual_start_date`**：该日 `close = base_point`，而非用户填的 base_date（若二者不同）
- Step 5 预览须展示两者；若 `actual_start_date - base_date > 30` 个交易日 → ⚠ warning，不阻断

## 全收益分红缺失 {#total-return-fallback}

若某日无法取得分红/复权分解数据：**该日按价格指数口径计算成分收益**，写入 job warnings，**不**修改 `index_type`、**不**改 `status`。

---

## 技术指标计算 {#indicators}

**V1 固定**：Python worker `indicators.py` port NestJS `technicalindicators` 等价参数（MA/KDJ/MACD/BBI/砖图）。不回调 NestJS。

---

## Python worker 模块布局

```text
apps/quant-pipeline/src/quant_pipeline/custom_index/
├─ compute.py           # 主入口 compute_custom_index(job)
├─ weight_resolver.py   # PIT 版本解析
├─ price_index.py       # 价格指数
├─ total_return.py      # 全收益
├─ indicators.py        # 调用 shared 指标函数
└─ money_flow.py        # 聚合
```

注册：`dispatcher.py` 增加 `'custom_index_compute': compute_custom_index`。
