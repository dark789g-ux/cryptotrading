# 06 TuShare 7000 积分接口清单

↩ [返回索引](00-index.md)

---

## 6.1 优先级定义

| 优先级 | 含义 |
|---|---|
| **P0** | 必须有，数据层骨架 |
| **P1** | 强信号源，能直接出 alpha |
| **P2** | 增强类，进阶后加 |
| **P3** | 知道有，按需 |

---

## 6.2 P0 骨架接口（9 个，必拉）

| 接口 | 积分 | 用途 |
|---|---:|---|
| `stock_basic` | 120 | 全市场列表 + list/delist_date（PIT universe） |
| `trade_cal` | 120 | 交易日历 |
| `daily` | 2000 | 日线 OHLCV + pct_chg |
| `daily_basic` | 2000 | 每日基本面 22 字段（PE/PB/turnover/circ_mv 等） |
| `adj_factor` | 2000 | 复权因子（**必须独立存**） |
| `stk_limit` | 2000 | 当日涨跌停价格 |
| `suspend_d` | 2000 | 停复牌信息 |
| `index_classify` | 2000 | 申万行业分类 |
| `index_member_all` | 2000 | 申万行业成份**历史快照**（PIT 必需） |

---

## 6.3 P1 强信号源

### 财务因子

| 接口 | 积分 | 用途 |
|---|---:|---|
| `fina_indicator` | 2000 | TuShare 已算好的 80+ 指标 |
| `income` / `balancesheet` / `cashflow` | 2000 | 三表原始 |
| `forecast` | 2000 | 业绩预告（**事件驱动核心**） |
| `express` | 2000 | 业绩快报（比正式财报早 30 天） |
| `dividend` | 2000 | 分红送股 |
| `disclosure_date` | 500 | 财报披露计划 |

### 资金流向

| 接口 | 积分 | 用途 |
|---|---:|---|
| `moneyflow_dc` | 5000 | 东财个股资金流 |
| `moneyflow_ths` | 5000 | 同花顺个股资金流（**双口径互校**） |
| `moneyflow_ind_dc` | 5000 | 东财行业资金流 |
| `moneyflow_mkt_dc` | 5000 | 大盘资金流（择时） |
| `moneyflow_hsgt` | 2000 | 沪深港通整体资金流 |
| `hsgt_top10` | 2000 | 沪深股通十大成交股（**北上资金标的级**） |

### 涨停板生态

| 接口 | 积分 | 用途 |
|---|---:|---|
| `limit_list_d` | 2000 | 涨跌停统计（连板/封单） |
| `kpl_list` | 5000 | 开盘啦榜单（涨停/炸板/强势） |
| `kpl_concept` / `kpl_concept_cons` | 5000 | 题材热点 |
| `limit_step` | 5000 | 涨停天梯 |

### 龙虎榜

| 接口 | 积分 | 用途 |
|---|---:|---|
| `top_list` | 2000 | 每日明细 |
| `top_inst` | 2000 | 机构席位 |

### 概念板块

| 接口 | 积分 | 用途 |
|---|---:|---|
| `ths_index` / `ths_member` / `ths_daily` | 5000 | 同花顺概念 |
| `ths_hot` | 5000 | 同花顺热榜 |
| `dc_index` / `dc_member` / `dc_hot` | 5000 | 东财概念 |

---

## 6.4 P2 增强类

| 类目 | 接口 | 积分 |
|---|---|---:|
| 股东持仓 | `top10_holders` / `top10_floatholders` | 2000 |
| 股东持仓 | `stk_holdernumber`（户数）/ `stk_holdertrade`（增减持） | 5000 |
| 限售/大宗 | `share_float` / `block_trade` / `repurchase` / `pledge_stat` | 2000 |
| 限售/大宗 | `pledge_detail` | 5000 |
| 融资融券 | `margin` / `margin_detail` | 2000 |
| 指数 | `index_daily` / `index_weight` / `index_dailybasic` | 2000 |
| 基金/ETF | `fund_basic` / `fund_daily` / `fund_portfolio` / `fund_share` | 120-2000 |
| 周月线 | `weekly` / `monthly` / `pro_bar` | 2000 |
| 技术指标 | `stk_factor`（含 MACD/KDJ/RSI） | 5000 |

---

## 6.5 P3 按需

| 类目 | 接口 | 积分 |
|---|---|---:|
| 宏观 | `cn_gdp` / `cn_cpi` / `cn_ppi` / `cn_m` / `cn_pmi` / `shibor` | 120-500 |
| 公司 | `stock_company` / `namechange` / `anns_d` | 500-2000 |
| 新闻 | `news` / `major_news` / `cctv_news` / `report_rc` | 2000-5000 |
| 沪深港 | `hs_const` / `ggt_top10` | 120-2000 |
| 新股 | `new_share` / `bak_basic` | 120 |

---

## 6.6 7000 积分够不上的接口

| 接口 | 备注 |
|---|---|
| `stk_mins`（分钟数据） | 1min 通常要 10000，60min 部分可用 |
| Tick / L2 行情 | 7000 完全无 |
| 全量分笔成交 | 极高 |

**判定方法**：调用时返回"权限不足"即跳过。同步层落白名单 / 黑名单缓存，避免重复试错。

---

## 6.7 限频策略

| 用户级别 | 每分钟上限 |
|---|---|
| 120-1999 分 | 60-200 次 |
| 2000-4999 分 | 200-500 次 |
| **5000-7999 分** | **500-800 次** |
| 8000+ 分 | 1000+ 次 |

**实操**：
- 同步任务每次调用之间留 0.15 秒间隔（≈ 400 次/分钟，留余量）
- 同步任务记 `last_success_date`，**只增量不全量**
- 高频接口（kpl_*）独立限频，单独测试

---

## 6.8 分批同步建议

```
Day 1   ─ P0 全部 + 5 年历史回填
Day 2   ─ P1 财务（fina_indicator + 三表 + forecast/express/dividend）
Day 3-4 ─ P1 资金流 / 涨停 / 龙虎榜 / 概念
Day 5+  ─ P2 增量（持仓/两融/限售）
```

---

## 6.9 7000 积分覆盖矩阵

```
                  日频    季频    事件    横截面
────────────────────────────────────────────────
量价         ✅       —       ✅       ✅
基本面       ✅       ✅      ✅       ✅
资金流       ✅       —       —        ✅
龙虎榜       ✅       —       ✅       —
涨停生态     ✅       —       ✅       ✅
概念板块     ✅       —       —        ✅
股东持仓     —        ✅      ✅       ✅
两融         ✅       —       —        ✅
指数/ETF     ✅       ✅      —        —
宏观         —        ✅      ✅       —
新闻/公告    ✅       —       ✅       —
覆盖率       95%      90%     100%     90%
```

**结论**：7000 积分对 A 股**截面选股策略已 100% 够用**，唯一显著缺失是分钟级行情（日内择时用），但日频选股策略不需要。

---

↩ [返回索引](00-index.md) | 上一篇：[05 LightGBM 训练体系](05-LightGBM训练体系.md) | 下一篇：[07 行业板块因子](07-行业板块因子.md)
