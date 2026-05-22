# factors —— 因子库 v1

> 本模块对齐 spec [m1-factor-library.md](../../../../doc/specs/2026-05-17-quant-model-training/m1-factor-library.md)
> 与 doc/量化/03 PIT 与数据质量、doc/量化/07 行业板块因子。

## 一、因子开发流程

新增因子分四步：

1. 在 `price/` / `industry/` / `fundamental/`（财务因子待支持）下**新建一个 `.py` 文件**，单文件单因子（doc/08 §8.2 反模式：禁止单文件多因子混写）。
2. 继承 `Factor` 抽象类，**声明** 5 个类属性：
   - `category`: `"price" | "industry" | "fundamental" | "mixed"`
   - `pit_window_days`: 回看的日历日数（见 §三 "PIT 窗口声明规则"）
   - `description`: 中文一句话语义
   - `required_columns`: 所需的 `df` 列（`("close_adj", "vol", ...)`）
   - 财务因子还需覆盖 `pit_anchor = "ann_date"`（默认 `trade_date`）
3. 用 `@register(factor_id=..., factor_version=...)` 装饰类；装饰器会自动调
   `validate_meta()` 校验必填项，重复注册抛 `ValueError`。
4. 在 `tests/unit/test_factors_<category>.py` 增加单测，至少覆盖：
   PIT 窗口（数据不足返回空）、极值（手算对比）、缺失（NaN）、复权处理。

注意：
- 把因子模块的 `import` 加入 `registry.import_all_factors()`，否则 registry 不会注册。
- `factor_id` 须全局唯一；同一逻辑改一次实现 → `factor_version` 升一档
  （doc/03 §3.5：同 `(ts_code, trade_date)` 不同 `factor_version` 可共存）。
- 单文件 ≤ 500 行（CLAUDE.md）。

## 二、30 个因子清单

### 量价因子（10 / 20 已交付，10 待补）

| factor_id | 状态 | 说明 |
|---|---|---|
| `momentum_20d` | OK | 20 日动量 |
| `momentum_60d` | OK | 60 日动量 |
| `volatility_20d` | OK | 20 日对数收益率标准差 |
| `volume_ratio_20d` | OK | 当日 vol / 过去 20 日均值 |
| `turnover_mean_20d` | OK | 20 日换手率均值 |
| `ma_ratio_20d` | OK | close_adj / MA20 |
| `rsi_14` | OK | Wilder RSI(14) |
| `bollinger_position_20d` | OK | (close - lower) / (upper - lower) |
| `price_max_drawdown_60d` | OK | 60 日最大回撤（负值） |
| `close_to_high_60d` | OK | close / 60 日 close 高点 |
| `momentum_5d` | TODO | 5 日动量（短期反转 / 持续） |
| `volatility_60d` | TODO | 60 日波动率 |
| `amount_mean_20d` | TODO | 20 日成交额均值（流动性） |
| `amplitude_20d` | TODO | 20 日振幅均值 |
| `vwap_dev_20d` | TODO | close / VWAP_20d - 1 |
| `cci_14` | TODO | CCI(14) |
| `kdj_k_9` | TODO | KDJ K(9) |
| `ema_ratio_60d` | TODO | close / EMA60 |
| `down_volume_share_20d` | TODO | 20 日下跌日成交量占比 |
| `gap_open_20d` | TODO | 20 日跳空开盘统计 |

### 行业派生因子（5 / 10 已交付，5 待补）

| factor_id | 状态 | 说明 |
|---|---|---|
| `industry_momentum_20d` | OK | 行业内 pct_chg 均值的 20 日累计 |
| `industry_relative_strength` | OK | alpha vs industry（20 日） |
| `industry_rank_in_sector_mom20` | OK | 20 日动量在行业内的 pct_rank |
| `sector_volume_concentration` | OK | 行业内成交量 HHI |
| `momentum_20d_neu` | OK | 行业中性化的 20 日动量 |
| `industry_momentum_60d` | TODO | 行业 60 日动量 |
| `industry_turnover_20d` | TODO | 行业 20 日换手率均值（拥挤度） |
| `industry_amount_share` | TODO | 行业成交额 / 全市场 |
| `industry_limit_up_count` | TODO | 行业涨停数（需 raw.stk_limit） |
| `industry_neutral_volatility_20d` | TODO | 行业中性化波动率 |

### 财务因子（0 / 0 本轮无交付）

财务因子（PE_TTM_pit、ROE_TTM_pit、营收增速等）必须用 `ann_date` 作 PIT 锚点（doc/03 §3.1 第一铁律）。
`Factor.pit_anchor='ann_date'` 已在基类支持，待后续轮次按相同模式补齐。

## 三、PIT 窗口声明规则

`pit_window_days` 表示 T 日计算因子时需要回看的"日历日上限"。换算口径：

| 需要的交易日数 N | 推荐的 `pit_window_days` | 说明 |
|---|---|---|
| 1 | 5 | 仅 T 日数据 + 周末缓冲 |
| 5 | 10 | 1 周交易日 |
| 20 | 35 | 1 月交易日 + 节假日 |
| 60 | 115 | 3 月交易日 + 节假日（春节/国庆叠加需更大裕度） |
| 120 | 180 | 半年 |
| 250 | 380 | 1 年 |

口径推导：A 股一年约 244 个交易日 + 121 个非交易日 ≈ 1.5 倍系数。本仓库
统一上取整后再 +5 日缓冲，避免节假日聚集时窗口不够。

**绝对禁止**：
- `pit_window_days` 写 0 或负值（`validate_meta()` 拒绝）
- 在 `compute` 内额外抓取 T 日之外的数据（runner 已保证窗口；额外 IO = PIT 漏洞）
- 财务因子用 `pit_anchor='trade_date'`（必须 `ann_date`）

## 四、后复权价处理（doc/03 §3.2 复权陷阱）

runner 在 `load_window_data` 中按窗口口径反推后复权价：

```python
af = panel["adj_factor"]
max_af = af.groupby(level="ts_code").transform("max")
panel["close_adj"] = panel["close"] * af / max_af
```

因子全部用 `close_adj` 计算，**不用** `raw.daily_quote.close`（未复权）。
单测在 conftest 第 30 日故意构造一次 1.1 倍分红跳变，验证 `momentum_20d`
使用 `close_adj` 后值连续；如换成 `close` 则在跨越分红日的窗口出现 > 5% 的偏差。

## 五、行业归属（doc/07 §7.4 + doc/03 三幽灵 Bug 之一）

行业派生因子读取 `df["industry_l1"]`，由 runner 用 PIT 安全的查询解析：

```sql
SELECT im.con_code AS ts_code, im.index_code AS industry_l1
FROM raw.index_member im
JOIN raw.index_classify ic ON ic.index_code = im.index_code
WHERE ic.level = 'L1'
  AND im.in_date <= :trade_date
  AND (im.out_date IS NULL OR im.out_date > :trade_date)
```

**绝对禁止**：
- 用 `raw.index_member` 的"当前快照"回测历史（survivor bias / wrong industry）
- 用 ETF 价代替行业指数（doc/07 §7.4：含管理费/溢价/跟踪误差）

## 六、运行 / 验证

```bash
# 单测
cd apps/quant-pipeline
uv run pytest tests/unit/test_factors_*.py

# 注册数量自检（应输出 15）
uv run python -c "from quant_pipeline.factors.registry import list_factors; print(len(list_factors()))"

# 历史日人工核对（需 Part C 同步完成 raw.* 后）
uv run python -c "
from quant_pipeline.factors.runner import run_factors
print(run_factors(factor_version='v1', date_range='20240603:20240603',
                  factor_ids=['momentum_20d']))
"

# 查 PG
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
SELECT trade_date, ts_code, factor_id, value
FROM factors.daily_factors
WHERE trade_date='20240603' AND factor_id='momentum_20d'
ORDER BY value DESC LIMIT 5;
"
```

## 七、与其它 Part 的依赖

- 依赖 **Part C**（sync）：runner 需要 `raw.trade_cal`、`raw.index_member`、
  `raw.index_classify` 三张 Python 侧同步的表；Part C 未完成前 runner 优雅
  退化（warn + 跳过该日），不抛 500。
- 依赖 **Part E**（quality）：本批因子的 `# TODO: 集成测试` 由 Part E 在
  小样本真实数据上补齐契约测试。
- 阻塞 **M2**（features / labels）：需要 `factors.daily_factors` 已写入。
