# 01 · 背景、实测数据与已锁定决策

## 搬砖系列演进（为什么做分阶段）

全周期（2022.4–2026.5）一套参数已到顶：

| 方案 | test id | run id | 样本 | kelly |
|---|---|---|---|---|
| 搬砖-04L2（无择时基线） | `82f8eb52-…745b` | `cb1ea759-e9bb-4c9d-b402-bdb2ef007dd8` | 40856 | +0.007 |
| 搬砖-05（柱>0 且 DIF>0） | `36d279a9-…0838` | `274d9da0-…ac9d` | 6660 | 0.083 |
| 搬砖-05C（仅柱>0） | `8e5a25ed-…e0db` | `4ded9adc-…caed` | 13747 | 0.1095 |

搬砖 7 条入场（三方案共用，出场 `trailing_lock` 不封顶）：

```json
[
  { "field": "brick_xg",         "operator": "gte", "value": 1,    "compareMode": "value" },
  { "field": "brick_delta",      "operator": "gt",  "value": 0.66, "compareMode": "value" },
  { "field": "ma30",             "operator": "gt",  "compareMode": "field", "compareField": "ma60" },
  { "field": "close",            "operator": "gt",  "compareMode": "field", "compareField": "ma60" },
  { "field": "turnover_rate",    "operator": "lt",  "value": 2,    "compareMode": "value" },
  { "field": "close_ma60_ratio", "operator": "lt",  "value": 1.05, "compareMode": "value" },
  { "field": "vol_ratio_60",     "operator": "lt",  "value": 1.1,  "compareMode": "value" }
]
```

## regime 定义：0AMV MACD 四象限

以信号日 `oamv_daily` 的 `amv_dif` / `amv_macd` 正负切分（与离线 SQL、真机条件、
Phase 2 识别服务共用同一口径，边界归属见 04 文档核查点 5）：

```text
              柱 > 0 (动能回暖)      柱 ≤ 0 (动能转弱)
            ┌─────────────────────┬─────────────────────┐
  DIF > 0   │ Q1 强多头           │ Q2 多头回调          │
            ├─────────────────────┼─────────────────────┤
  DIF ≤ 0   │ Q3 反弹筑底         │ Q4 空头              │
            └─────────────────────┴─────────────────────┘
```

## 实测：04L2 × 四象限 × 按年（2026-06-10 真 DB 跑出，40856 笔全对账）

```text
kelly 按年    2022     2023     2024     2025     2026(至5月)   全期
           ┌────────┬────────┬────────┬────────┬────────────┬───────┐
Q1 强多头   │ -0.089 │ -0.020 │ -0.015 │ +0.229 │  +0.047    │ +0.085│
            │  n=618 │ n=2796 │  n=308 │ n=2599 │   n=339    │ n=6660│
Q2 多头回调 │ +0.017 │ -0.072 │ +0.069 │ -0.116 │  +0.025    │ -0.024│
            │ n=2669 │ n=3474 │ n=1543 │ n=1378 │   n=755    │ n=9819│
Q3 反弹筑底 │ -0.031 │ +0.076 │ +0.128 │ +0.231 │  +0.021    │ +0.127│
            │  n=670 │ n=3223 │ n=1062 │ n=2032 │   n=100    │ n=7087│
Q4 空头     │ +0.038 │ -0.107 │ -0.121 │ -0.107 │  +0.046    │ -0.066│
            │ n=4007 │ n=5043 │ n=4855 │ n=2667 │   n=718    │n=17290│
           └────────┴────────┴────────┴────────┴────────────┴───────┘
（2022 自 4 月起算；2026 仅 5 个月，小样本格慎读；avg_ret 等完整数值见研究日志）
```

三个结论（驱动整个设计）：

1. **Q3 是唯一跨年稳健的象限**：5 年 4 正，唯一亏的 2022 仅 -0.031（n=670 浅亏），
   2023 熊震年仍 +0.076。0.127 被 2024-25 抬高，但方向一致性站得住。
2. **Q1 才是脆弱者**：全期 +0.085 几乎全靠 2025（+0.229, n=2599），2022/2023/2024
   连续三年为负。05C 的 edge 实质 = Q3 + 2025 年的 Q1。
3. **Q2/Q4 无可开采的稳定结构**：逐年正负乱跳（Q4 在 2022 反而 +0.038，须在终态
   报告中诚实标注为反例）。

## 基础设施现状（file:line 已核，实施时复核）

- **`oamv_daily`**：18 列含 `amv_dif/amv_dea/amv_macd`、`ma5/30/60/120/240`、
  `kdj_k/d/j`。覆盖 20210901~20260610 共 1153 行，SSE 交易日零缺失。实体
  `apps/server/src/entities/oamv/oamv-daily.entity.ts`。
- **条件系统大盘字段**：`strategy-conditions.types.ts:59-63` 的
  `ASHARE_MARKET_AMV_COL_MAP` 当前仅暴露 `oamv_dif/oamv_dea/oamv_macd` 三键；
  query-builder（`strategy-conditions.query-builder.ts:156-164`）将每条大盘条件
  译为独立 `EXISTS(SELECT 1 FROM oamv_daily oa WHERE oa.trade_date=i.trade_date
  AND <predicate>)`，缺日 fail-closed；`cross_above/below` 对大盘字段显式禁用。
  `oamv_daily` 的 ma/kdj 列**未**映射，入选后需加键（一行一字段）。
- **signal-stats**：出场三模式 `fixed_n | strategy | trailing_lock`
  （`entities/strategy/signal-test.entity.ts:26-35`）；trailing_lock 在 TS 侧唯一
  可调参数 `max_hold`，止损比例 0.999 硬编码于 simulator。enumerator 主锚表
  `raw.daily_indicator`，LEFT JOIN `raw.daily_quote / raw.daily_basic /
  stock_amv_daily / signal_rolling_indicator`（`signal-stats.enumerator.ts:140-154`）。
  `signal_test_run` 统计列：`sample_count / win_rate / payoff_ratio / kelly_f` 等；
  `signal_test_trade` 含 `ts_code / signal_date(varchar8) / ret / exit_reason`。
  TypeORM 将 numeric 水合为 string，对账时先 cast。
- **锚点数据**：04L2 run `cb1ea759-…07dd8` 的 40856 笔全在 `signal_test_trade`，
  JOIN `oamv_daily` 即可离线任意切分。
- **Python kelly_sweep harness**（`apps/quant-pipeline/`）：曾以真 DB 自校验复现
  TS 锚点（Kelly 0.1755≈0.171）；`kelly_sweep_bandlock_test/` 为其扫参输出。其
  trailing `z` 参数与 TS 实现语义未对齐——本设计仅将其列为后备路径（见 02）。

## 已锁定的六项决策（brainstorming 敲定）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 探索深度 | 直接逐象限调优（四象限同时探索入场×出场） |
| 2 | 验证纪律 | 双保险：train/holdout 切分 + 预登记 top-N + 按年一致性 + 真机对账 |
| 3 | 搜索空间 | 更开放探索；但受"自动化就绪"约束——出场以 TS 可表达为边界 |
| 4 | regime 粒度 | 四象限固定为主轴；大盘 ma240/KDJ 等细分维度降级为入场候选过滤字段 |
| 5 | 落地形态 | 直接奔自动化，一份 spec 两阶段，自动化配置驱动 |
| 6 | 自动化边界 | 每日识别 + 选股清单展示；不自动下单、不做持仓跟踪 |

引擎选型为方案 A（纯 TS：宽锚点真机 run × 离线 SQL 切片），理由与后备路径见
[02-research-protocol.md](./02-research-protocol.md#引擎选型)。
