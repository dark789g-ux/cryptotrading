# 01 · 总架构与数据流

## 用户已拍板的决策

| # | 决策点 | 选定 |
|---|--------|------|
| 1 | 标的范围 | **先精选清单，预留扩展**：v1 用 CSV 播种 tracked 集；schema 支持扩到全美股 |
| 2 | 同步运行路径 | **Python quant-pipeline + ml.jobs worker**（AkShare 是 Python 库，抓数必须在 Python） |
| 3 | 面板功能深度 | **基础列 + 技术指标列（默认隐藏），无评分/买入信号** + 前复权/不复权口径切换 |
| 4 | 精选清单维护 | **同步全名称表 + tracked 标记位**（v1 实际用 CSV 播种 tracked；AkShare 全名单同步 P2） |
| 5 | 衍生计算位置 | **Python 端到端全包**：抓完 raw+因子后 SQL 算 qfq、Python 算指标，全写 `raw.us_*`；NestJS 只读 |

## 数据流总览

```text
┌─ Python (apps/quant-pipeline) ──────────────────────────────────────────┐
│  akshare_client ──AkShare(新浪)──▶ stock_us_daily(ticker)                │
│    · adjust=""        → 不复权 OHLCV   → raw.us_daily_quote(原始列)       │
│    · adjust="hfq-factor" → 后复权因子  → raw.us_adj_factor               │
│  同 job 内:                                                              │
│    · SQL: qfq = 原始价 × 当日因子 / 最新因子 → raw.us_daily_quote.qfq_*   │
│    · Python 指标(MA/KDJ/MACD/BBI/ATR…，输入 qfq) → raw.us_daily_indicator │
└──────────────────────────────────────────────────────────────────────────┘
                                  │ (只读)
┌─ NestJS (apps/server) ──────────▼───────────────────────────────────────┐
│  market-data/us-stocks: /api/us-stocks/{query,klines,summary,symbols,…} │
│  写 us_symbol.tracked；POST /sync → 写 ml.jobs(run_type=us_sync)         │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
┌─ Vue (apps/web) ────────────────▼───────────────────────────────────────┐
│  SymbolsView 第4 Tab → UsStocksPanel（照搬 ASharesPanel，砍评分/信号）    │
└──────────────────────────────────────────────────────────────────────────┘
```

## 进程边界（关键设计原则）

- **Python 独占 `raw.us_daily_quote / us_adj_factor / us_daily_indicator` 的写**（含派生 qfq 与指标）。进程边界干净：Python 写、NestJS 只读，无跨进程衍生数据交接。
- **`raw.us_symbol` 两方写不同列**：Python `us_symbol` fetcher / CSV 播种写 `ticker/name/theme/...`（`ON CONFLICT DO UPDATE` **不覆盖 tracked**）；NestJS 只改 `tracked` 标记位。契约靠列归属切分，互不踩。
- 代价（已接受）：技术指标公式在 Python 再实现一份（复用 quant-pipeline 现有 `features/builder.py`，缺的从 `indicators.ts` 移植）。仅展示用、非量化模型，靠 TS↔Python 抽样对拍把漂移卡在容差内。

## `us_sync` run_type 与触发双路径

新增 run_type `us_sync`，**4 处登记（缺一不可，与 [05](./05-nestjs-module.md#run_type-白名单四处登记缺一不可) 同一份清单）**：
1. NestJS `ALLOWED_RUN_TYPES`（`create-job.dto.ts:60-73`）。
2. `MlJobRunType` 类型联合（`entities/ml/ml-job.entity.ts`，独立定义点，漏改则类型不过）。
3. Python dispatcher `_ROUTES["us_sync"] = _runner_us_sync`（`worker/dispatcher.py:387-407`）。
4. Python CLI 子命令（见下）。

触发双路径（与现有 quant sync 同构）：

```text
路径 A · CLI 直跑(本次灌数用)   quant us-sync --date-range 20250101:20260612 [--tickers ... | --tracked]
                               cli.py 直调 run_us_sync()，不写 ml.jobs，不依赖 worker/server
路径 B · Web 触发(面板按钮)     前端 POST /api/us-stocks/sync → NestJS 写 ml.jobs(us_sync,params)
                               → Python quant-worker 轮询领取 → _runner_us_sync → run_us_sync()
                               → 进度经现有 ml.jobs SSE 桥回传前端
```

两路共用同一 `run_us_sync()` 编排函数，语义一致（参考现有 `run_sync()` CLI/Worker 双路）。

## 同步 UX 分歧（明示权衡）

A 股「同步」在一键 `SyncView` 的 NestJS-SSE 串行流里；**美股同步走 ml.jobs（路径 B）**，故 v1 把美股同步按钮放在 `UsStocksPanel` 面板内（enqueue job + 复用量化 jobs 的 SSE 进度），**不进**一键同步流。后续若要可再把 `us_sync` 挂进一键流（P2）。本次真实灌数用路径 A（CLI），与上述 UX 无关。
