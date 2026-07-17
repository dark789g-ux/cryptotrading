📍 [手册首页](./README.md) | [第 1 章 接口与工作流](./01-workflow.md) | 第 2 章 字段白名单 | [第 3 章 引擎内部机制](./03-engine-internals.md)

# 第 2 章 字段白名单

> Regime 回测手册 · 字段层

[第 1 章 接口与工作流](./01-workflow.md) §6 的配套文档。Agent 构造 config 的 `entryConditions` / `exitConditions` / `match` / `rankField` 前,必须先查本文确认字段可用。

**权威源**(字段变更时必须同步更新本文):
- `apps/server/src/strategy-conditions/strategy-conditions.types.ts` — 三个 `*_COL_MAP`
- `apps/server/src/strategies/regime-engine/regime-engine.validation.ts` — 各白名单汇聚
- `apps/server/src/strategies/regime-engine/backtest/rank-select.ts` — `RANK_FIELDS`

---

## 1. 入场/出场条件字段白名单(ASHARE_CONDITION_FIELD_WHITELIST)

`entryConditions` 和 `exitMode='strategy'` 时的 `exitParams.exitConditions`,每个条件的 `field` 必须命中本白名单。白名单 = 以下三表并集(共 54 字段:24 指标 + 7 行情 + 7 基本面 + 3 个股AMV + 5 滚动信号 + 3 行业AMV + 5 大盘0AMV,另含受限的 `list_days`)。

条件结构:`{field, operator, value?}`(compareMode=value)或 `{field, operator, compareField, compareMode:'field'}`。

### 1.1 个股技术指标(raw.daily_indicator,前缀 `i.`)

| field | SQL | 含义 |
|---|---|---|
| `macd_dif` | `i.dif` | MACD DIF |
| `macd_dea` | `i.dea` | MACD DEA |
| `macd_hist` | `i.macd` | MACD 柱 |
| `kdj_j` | `i.kdj_j` | KDJ J 值 |
| `kdj_k` | `i.kdj_k` | KDJ K 值 |
| `kdj_d` | `i.kdj_d` | KDJ D 值 |
| `bbi` | `i.bbi` | 多空指标 |
| `ma5` | `i.ma5` | 5 日均线 |
| `ma30` | `i.ma30` | 30 日均线 |
| `ma60` | `i.ma60` | 60 日均线 |
| `ma120` | `i.ma120` | 120 日均线 |
| `ma240` | `i.ma240` | 240 日均线(年线) |
| `atr14` | `i.atr_14` | 14 日 ATR |
| `profit_loss_ratio` | `i.risk_reward_ratio` | 风险报酬比 |
| `roc10` | `i.roc10` | 10 日 ROC |
| `roc20` | `i.roc20` | 20 日 ROC |
| `roc60` | `i.roc60` | 60 日 ROC |
| `vwap5` | `i.vwap5` | 5 日 VWAP |
| `vwap10` | `i.vwap10` | 10 日 VWAP |
| `vwap20` | `i.vwap20` | 20 日 VWAP |
| `brick` | `i.brick` | 砖图状态 |
| `brick_delta` | `i.brick_delta` | 砖图变化量 |
| `brick_xg` | `i.brick_xg` | 砖图选股标志(boolean,SQL 强转 int) |
| `obv10d` | `i.obv10d` | OBV 10 日能量潮 |

### 1.2 个股行情(raw.daily_quote,前缀 `q.`)

| field | SQL | 含义 |
|---|---|---|
| `close` | `q.close` | 收盘价 |
| `open` | `q.open` | 开盘价 |
| `high` | `q.high` | 最高价 |
| `low` | `q.low` | 最低价 |
| `volume` | `q.vol` | 成交量 |
| `amount` | `q.amount` | 成交额 |
| `pct_chg` | `q.pct_chg` | 涨跌幅 |

### 1.3 基本面(raw.daily_basic,前缀 `m.`)

| field | SQL | 含义 |
|---|---|---|
| `turnover_rate` | `m.turnover_rate` | 换手率 |
| `volume_ratio` | `m.volume_ratio` | 量比 |
| `pe` | `m.pe` | 市盈率 |
| `pe_ttm` | `m.pe_ttm` | TTM 市盈率 |
| `pb` | `m.pb` | 市净率 |
| `total_mv` | `m.total_mv` | 总市值 |
| `circ_mv` | `m.circ_mv` | 流通市值 |

### 1.4 个股活跃市值(stock_amv_daily,前缀 `sa.`)

| field | SQL | 含义 |
|---|---|---|
| `amv_dif` | `sa.amv_dif` | 个股 AMV-MACD DIF |
| `amv_dea` | `sa.amv_dea` | 个股 AMV-MACD DEA |
| `amv_macd` | `sa.amv_macd` | 个股 AMV-MACD 柱 |

### 1.5 滚动信号(signal_rolling_indicator,前缀 `d.`)

| field | SQL | 含义 |
|---|---|---|
| `pos_120` | `d.pos_120` | 120 日价格分位 |
| `pos_60` | `d.pos_60` | 60 日价格分位 |
| `close_ma60_ratio` | `d.close_ma60_ratio` | 收盘/MA60 比值 |
| `vol_ratio_60` | `d.vol_ratio_60` | 60 日量比 |
| `vol_ratio_120` | `d.vol_ratio_120` | 120 日量比 |

### 1.6 行业 AMV(前缀 `ia.`,个股所在行业指数)

| field | SQL | 含义 |
|---|---|---|
| `ind_amv_dif` | `ia.amv_dif` | 行业 AMV DIF |
| `ind_amv_dea` | `ia.amv_dea` | 行业 AMV DEA |
| `ind_amv_macd` | `ia.amv_macd` | 行业 AMV 柱 |

### 1.7 大盘 0AMV(oamv_daily,前缀 `oa.`,全市场活跃市值)

| field | SQL | 含义 |
|---|---|---|
| `oamv_dif` | `oa.amv_dif` | 大盘 0AMV DIF |
| `oamv_dea` | `oa.amv_dea` | 大盘 0AMV DEA |
| `oamv_macd` | `oa.amv_macd` | 大盘 0AMV 柱 |
| `oamv_close` | `oa.close` | 大盘 0AMV 收盘 |
| `oamv_ma240` | `oa.ma240` | 大盘 0AMV 年线(大盘择时闸门) |

### 1.8 特殊字段(⚠️ 受限)

| field | SQL | 含义 | 限制 |
|---|---|---|---|
| `list_days` | 子查询(无表前缀) | 上市时长(自然日) | **仅可用于 entryConditions,不可用于 match 分桶**(match 要求字段带 `q./i./m./sa./d.` 前缀,见 §3.2) |

### 1.9 现算字段(derived field)

以下字段不在 `ASHARE_CONDITION_FIELD_WHITELIST` 预算列中,但通过 `isDerivedField()` 旁路判定为合法字段,可在 `entryConditions` / `exitConditions` / `compareField` 中使用。

#### 1.9.1 MA 任意周期

正则 `/^ma\d+$/` 匹配的所有字段均合法。其中 `ma5/ma30/ma60/ma120/ma240` 在 §1.1 预算列中已有,走 SQL；其他周期(如 `ma10/ma15/ma20` 等)走内存现算(Phase 2)。

| field | 计算 | 走预算 or 现算 |
|---|---|---|
| `ma5` | 5 日 SMA | 预算列(SQL) |
| `ma10` | 10 日 SMA | 现算(内存) |
| `ma15` | 15 日 SMA | 现算(内存) |
| `ma20` | 20 日 SMA | 现算(内存) |
| `ma30` | 30 日 SMA | 预算列(SQL) |
| `ma60` | 60 日 SMA | 预算列(SQL) |
| `ma120` | 120 日 SMA | 预算列(SQL) |
| `ma240` | 240 日 SMA | 预算列(SQL) |

> 校验层不区分预算/现算——只要匹配正则就放行。实际走哪条路径由 `DerivedFieldRegistry.split()` 决定。

#### 1.9.2 KDJ 自定义参数

`kdj_j` / `kdj_k` / `kdj_d` 三个字段已在 §1.1 预算列中(固定 9/3/3 参数)。不带 `kdjParams` 时走预算 SQL；带 `kdjParams: {n, m1, m2}` 时走现算。校验层同样不区分,字段名匹配即放行。

> **现算字段的 compareField 可以引用预算字段**:如 `{field:'ma20', operator:'gt', compareField:'ma60', compareMode:'field'}`,其中 `ma20` 走现算、`ma60` 走预算 SQL。引擎在 Phase 2 重算 `ma20` 时会同时注入 `ma60` 的预算值(siblingResults),在内存中完成比较。反向亦然(预算字段 vs 现算 compareField)。

设计详见 [第 3 章 引擎内部机制](./03-engine-internals.md)。

---

## 2. 排序因子白名单(rankField)

trade 象限的 `rankField` 必须命中本表(含 `'none'`)**或**为 §1.9 的现算字段(如 `ma20`)。同一天有多个信号时,按此字段排序选前 N 只。

> 现算字段做 rankField 时,排序值由 Phase 2 `phase2RankValue` 补算(与预算字段走 SQL 不同)。

| rankField | 含义 | 代码内默认 rankDir(`DEFAULT_DIR`) |
|---|---|---|
| `turnover_rate` | 换手率 | desc |
| `pct_chg` | 涨跌幅 | desc |
| `amount` | 成交额 | desc |
| `pos_120` | 120 日价格分位 | **asc**(注意:代码默认升序,非直觉) |
| `circ_mv` | 流通市值 | **asc**(注意:代码默认升序,选小市值) |
| `amv_macd` | 个股 AMV 柱 | desc |
| `obv10d` | OBV 10 日能量潮 | desc |
| `none` | 不排序(取信号列表顺序) | 不需要 rankDir |

> **注意**:trade 象限的 `rankDir` 在 `rankField≠none` 时**必填**(见 [第 1 章 §5.2](./01-workflow.md)),上表"代码内默认"仅是 `rank-select.ts` 的 `DEFAULT_DIR` 回退值,Agent 构造 config 时仍应显式传 `rankDir`。

---

## 3. match 分桶条件字段白名单

`match` 条件(`RegimeBucketCondition`)的 `field` 白名单**按 type 分两套**,与 entryConditions 白名单不同。

### 3.1 type='index'(大盘指数级)字段白名单

`match.target` 为大盘指数代码(见 §4)。field 必须命中以下 24 个:

```
open, high, low, close, pre_close, change, pct_change, vol_hand, amount,
ma5, ma30, ma60, ma120, ma240,
dif, dea, macd, kdj_k, kdj_d, kdj_j, bbi, brick, brick_delta, brick_xg
```

含义:指数的 OHLCV、均线、MACD、KDJ、BBI、砖图等指标。数据源 `index_daily_indicators` / `index_daily_quotes`。

### 3.2 type='stock'(个股级)字段白名单

`match.target` 为个股 ts_code。field 白名单 = §1.1-1.5 中**带表别名前缀**(`q./i./m./sa./d.`)的字段子集。

**排除**:`list_days` 这种无前缀的字段不能用于 stock 分桶(求值器无法定位表)。其余 §1.1-1.5 的字段均可用。

### 3.3 大盘指数代码(match 的 target,经 DB 验证有数据)

以下指数在 `index_daily_quotes` 表有完整数据(2021-01-04 ~ 2026-07-16,1340 根),可直接用作 `type='index'` 的 target:

| 指数代码 | 名称 |
|---|---|
| `000001.SH` | 上证指数 |
| `399001.SZ` | 深证成指 |
| `399006.SZ` | 创业板指 |
| `000300.SH` | 沪深300 |
| `000016.SH` | 上证50 |
| `000905.SH` | 中证500 |
| `000985.CSI` | 中证全指 |

> **ts_code 后缀规则**:
> - `.SH` = 上交所发布(如 000001 上证指数、000300 沪深300、000016 上证50)
> - `.SZ` = 深交所发布(如 399001 深证成指、399006 创业板指)
> - `.CSI` = 中证指数公司发布(如 000985 中证全指)
>
> **注意**:000905(中证500)和 000852(中证1000)按发布方应为 `.CSI`,但 Tushare 数据源实际提供的是 `.SH`,DB 中也按 `.SH` 存储。后缀由 Tushare 数据源决定,以 DB 实际可用为准。
>
> 验证 DB 中可用指数的命令:
> ```bash
> docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
>   SELECT DISTINCT ts_code FROM index_daily_quotes ORDER BY ts_code;"
> ```

**反例**:`399005.SZ`(中小板指)在库中无数据,用了会导致 match 条件永远不命中。

---

## 4. operator 白名单(通用,match 和 entryConditions 共用)

| operator | 语义 |
|---|---|
| `gt` | 大于 |
| `gte` | 大于等于 |
| `lt` | 小于 |
| `lte` | 小于等于 |
| `eq` | 等于 |
| `neq` | 不等于 |
| `cross_above` | 上穿(当日满足且前一交易日不满足) |
| `cross_below` | 下穿(当日满足且前一交易日不满足) |

`cross_above` / `cross_below` 用于金叉/死叉类条件(如 MACD DIF 上穿 DEA、KDJ J 上穿 0 轴)。前一交易日数据来源:`entryConditions` 用 `raw.daily_indicator`,`match` index 类用 `index_daily_indicators`。

---

## 5. compareMode 说明

| compareMode | 用法 | 示例 |
|---|---|---|
| `value`(默认) | `field` 与数字常量 `value` 比较 | `{field:'kdj_j', operator:'lt', value:0}` — KDJ J 小于 0 |
| `field` | `field` 与同 target 的另一字段 `compareField` 比较 | `{field:'close', operator:'gt', compareField:'ma60', compareMode:'field'}` — 收盘上穿 60 日均线 |

`compareMode='field'` 时**不可**提供 `value`;`compareMode='value'`(或省略)时**不可**提供 `compareField`。违反则 400。
