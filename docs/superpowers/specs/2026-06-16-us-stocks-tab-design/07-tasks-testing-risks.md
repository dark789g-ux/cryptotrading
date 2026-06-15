# 07 · 任务顺序 / 测试 / 风险

## 任务依赖顺序与文件域切分（互不相交，便于并行）

```text
T1 DB+实体   migrations/<ts>-create-us-stocks.sql + .ps1; entities/raw/us-*.entity.ts; app.module entities[]
              (基础, 其它任务依赖其表/实体)
T2 Python    quant-pipeline: akshare_client / us_symbol / us_daily / us_orchestrator / dispatcher / cli
              (依赖 T1 表存在; 灌数关键路径)
T3 NestJS    market-data/us-stocks/* + create-job.dto ALLOWED_RUN_TYPES + MlJobRunType
              (依赖 T1 实体; 与 T2 文件域不交)
T4 前端      SymbolsView + components/symbols/UsStocksPanel + us-stocks/* + api/usStocks + 偏好 scope 扩展
              (依赖 T3 接口形状; 与 T2 文件域不交)
T5 集成      migration apply → 冒烟(CLI 1-2 只) → 真实灌数(CSV 62 只) → 重启 server 验面板
```

关键路径（满足 /goal）：**T1 → T2 → T5 冒烟 → T5 灌数**。T3/T4 是「能在 Tab 里看到数据」所需，可与灌数并行推进。

## 测试计划

- **Python pytest**：
  - `akshare_client` 空数据双路径 warn（`None` / 空）+ 0 行→`failed_items`。
  - `us_daily` 幂等 upsert（重跑零漂移）、date_range 过滤、pct_chg 计算。
  - 指标 TS↔Python 抽样对拍在容差内。
- **NestJS jest**：query（priceMode 选列 + 排序映射 + 不放大 COUNT）、tracked toggle 只改 tracked、sync enqueue 写 `run_type='us_sync'`。
- **前端 vitest**：`usStocksColumns` 产物、`resolveColumnGroup` 命中新基础列、偏好 scope 往返不丢 usStocks。
- **必跑** `pnpm --filter @cryptotrading/web build`（SFC 编译，vue-tsc/type-check 查不出 SFC 编译错——见 active-mv 教训）。

## 冒烟测试步骤（CLI，不重启用户 dev）

1. `migration .ps1` 建表 → `\d raw.us_daily_quote` 等核对四表。
2. `quant us-sync --date-range 20250101:20260612 --tickers NVDA,MSFT`。
3. 查 DB：`raw.us_daily_quote` NVDA/MSFT 行数 > 0、OHLC 非空、`qfq_close` 非空；`raw.us_adj_factor` 行数对齐；`raw.us_daily_indicator` `ma5/kdj_j/macd` 非空。
4. 复权因子语义校验（02 §2）：抽 NVDA，比自算 qfq vs `adjust="qfq"` ground truth 在容差内。

## 真实灌数步骤（/goal 交付）

1. `quant us-symbols seed --csv "doc/us_stocks_themes (1).csv"` → 验 `raw.us_symbol` 62 行、tracked=true。
2. `quant us-sync --date-range 20250101:20260612 --tracked`。
3. 汇总落库：每只 `us_daily_quote` 覆盖 `[20250101,20260612]`、qfq/指标非空；`failed_items` 如实列出（预期含 `SPCX`，可能含个别需前缀/退市 ticker），逐条报告，不静默。
4. 重启 server（征得用户同意）→ 美股 Tab 渲染、口径切换、列设置；验完恢复默认列偏好。

## 风险 / 权衡

- **AkShare 逐 ticker 抓取**：精选清单（62）可控；扩到全美股需另设增量策略（P2）。
- **爬虫源稳定性**：弱于官方 API，靠重试 + `failed_items` 兜，不假装成功。
- **`SPCX` 未上市**：预期取不到，进 failed_items，正常。
- **复权因子语义**：可能含加法项；靠 02 §2 的 ground-truth 校验把关，必要时改重算逻辑。
- **指标双实现漂移**：Python vs TS，靠对拍卡容差；仅展示用、非模型。
- **Alembic**：DDL 由 NestJS migration 建，Python 不建表，规避 Alembic 漂移（参考既有 drift 教训）。

## YAGNI（明确不做）

评分列、买入信号列、AMV/砖块美股版、filter presets、`us_trade_cal`、脏区表、AkShare 全名单自动同步（P2）、把美股挂进一键同步流（P2）。
