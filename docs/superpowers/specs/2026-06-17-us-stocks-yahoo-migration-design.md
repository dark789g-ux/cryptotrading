# 美股数据源 AkShare → Yahoo 全量迁移 — 设计 spec

> 一句话目标：把美股（个股日线 + .NDX 指数 + AMV）的数据源从 **AkShare（新浪 `stock_us_daily`）** 全量切换到 **Yahoo Finance chart API（自建薄封装，非 yfinance 库）**，并用 `Adj Close / Close` 这个恒正的乘法复权因子取代会变负的减法式 qfq 派生因子；彻底移除 akshare 依赖。保留现有「存原始价 + adj_factor → 公式算 qfq」架构，下游 NestJS / 前端零改。

## 背景与问题

现状（已实测定位，2026-06-17）：博通 AVGO、英伟达 NVDA 在美股面板「无数据」。根因是 **AkShare 的 `stock_us_daily(adjust="qfq")` 用减法式（累计分红相减）前复权**，高分红 / 长历史股在早期日期被减成**负的复权价**（实测 AVGO 2016 上半年 qfq_close = -0.535 ~ -2.38）。而 [us_daily.py:90](../../apps/quant-pipeline/src/quant_pipeline/sync/us_daily.py) 的因子守门是 `(f > 0).all()` **一票否决**：窗口里只要一个因子 ≤ 0，就 `factor_empty=True` → 整只 ticker 的 qfq 全列写 NULL 并提前 return。前端列表默认 qfq 口径，于是整行价格列空白。

候选源对比（实测）：

| 候选 | 能否给乘法复权 | 实测结论 |
|------|--------|------|
| AkShare 新浪 `stock_us_daily` hfq | ❌ | `adjust="hfq"` 返回 `None`，新浪源美股只有 `""`/`qfq` |
| Tushare 美股（`us_daily_adj`/`us_adjfactor`） | ❌ | **本账号无权限**（见根 [CLAUDE.md](../../CLAUDE.md) 「数据源权限」） |
| **Yahoo `adjclose`** | ✅ | 本机可达（v8 chart API 仅 UA 即 200）；adjclose 全正（含 2016：AVGO 10.22 / NVDA 0.76）；拆股事件齐全；adjclose 末位 = 不复权末位（语义即前复权） |

**乘法（比值）复权是根治方向**：永不为负、保留每日收益率比例（对 MA/KDJ/MACD 指标更正确）。

## 已拍板决策

| # | 决策点 | 选定 |
|---|--------|------|
| 1 | 迁移范围 | **全量**：个股 `us_sync` + 指数 `us_index_sync` + `us_index_amv_sync`，pyproject 移除 akshare |
| 2 | 取数实现 | **自建 Yahoo chart 薄封装**（仿现有 akshare_client，stdlib，不引入 yfinance 库及其传递依赖） |
| 3 | 重灌窗口 | **2025-01-01 起** 至今日 |
| 4 | 旧数据处理 | **清空 tracked 标的现有行后全新灌**（含 .NDX 指数表），统一单源、无孤儿、无跨源拼接 |

> 关于窗口：2025-01-01 窗口本身**不触发负值 bug**（负值只在深历史；实测 AVGO 从 20250102 起 0 坏行）。此窗口下迁移的价值是**口径更正确 + 单一数据源 + 未来回填长历史也不再炸**。

## 关键事实（摸底已落 file:line；进硬断言 / migration 前实现期须再亲验）

| 事实 | 证据 |
|------|------|
| 所有 `ak.` 调用收口在 akshare_client 两方法（延迟 import） | [akshare_client.py:59](../../apps/quant-pipeline/src/quant_pipeline/sync/akshare_client.py)（`stock_us_daily`）、:104（`index_us_stock_sina`） |
| `us_daily.py` 是唯一写 us_daily_quote / us_adj_factor / us_daily_indicator 的地方 | 表名常量 [us_daily.py:23-25](../../apps/quant-pipeline/src/quant_pipeline/sync/us_daily.py)；upsert :144/:159/:179 |
| 个股/指数/AMV 三个独立 run_type | dispatcher `_ROUTES` us_sync :539 / us_index_sync :541 / us_index_amv_sync :543 |
| 个股链路：CLI `us-sync` / worker → run_us_sync → sync_us_daily_for_ticker | cli.py:233、dispatcher.py:129、us_orchestrator.py:55/88 |
| 指数链路用 `ak.index_us_stock_sina(".NDX")`，落 raw.us_index_daily/us_index_indicator | us_index_orchestrator.py:26（`DEFAULT_INDEX_SYMBOLS=(".NDX",)`）、us_index.py:54 |
| AMV 只读 `Σ(raw.close × raw.volume)` 原始价×量 + .NDX 点位（不×1000） | us_index_amv.py:104-116（量侧）、:137-159（.NDX 点位读 raw.us_index_daily） |
| NestJS query 默认 priceMode=qfq，取 qfq_close/qfq_pct_chg | us-stocks-query.sql.ts:101-105；useUsStocksQuery.ts:24 |
| klines 端点 `WHERE qfq_* IS NOT NULL`（qfq 空则该 ticker K 线返回空） | us-stocks.service.ts:183-186 |
| `raw.us_adj_factor` 全仓无读取方（仅 us_daily.py 写入存档） | 实体仅 app.module / us-stocks.module forFeature 注册，无 SQL 查询 |
| 四张 us_* 表所有价格列（含 qfq_*）均 nullable，无 NOT NULL 约束 | migrations/20260616120000-create-us-stocks.sql |
| 依赖用 uv 管理；akshare>=1.18.64 为直接依赖；yfinance 未出现 | apps/quant-pipeline/pyproject.toml:31、uv.lock |
| 相关测试 | test_akshare_index_client.py / test_us_index.py / test_sync_dispatcher_route.py / test_us_index_amv_pipeline.py |

## 架构与数据流

```text
┌─ Python (apps/quant-pipeline) ─────────────────────────────────────────────┐
│  yahoo_client (新, 替换 akshare_client)                                     │
│    fetch_us_daily(ticker, start, end) ─Yahoo v8 chart─▶                     │
│        df: date/open/high/low/close/volume/adj_close   (列名归一化为小写)   │
│    fetch_us_index(".NDX")             ─Yahoo v8 chart(^NDX)─▶                │
│        df: date/open/high/low/close/volume             (指数无复权)         │
│                                                                             │
│  us_daily.py (改因子段):                                                    │
│    factor = adj_close / close   ← 乘法、恒正、(f>0) 守门实务上不再触发       │
│    raw OHLCV(未复权) ─▶ us_daily_quote.{open..volume}  ← AMV 仍吃原始价×量   │
│    factor            ─▶ us_adj_factor                                       │
│    qfq = raw × factor / 最新factor ─▶ us_daily_quote.qfq_*                  │
│    指标(吃 qfq)      ─▶ us_daily_indicator                                  │
│                                                                             │
│  us_index.py / 编排器 / dispatcher / cli : 零改（不感知数据源）            │
└─────────────────────────────────────────────────────────────────────────────┘
                          │ (只读, 契约不变)
                          ▼
   NestJS us-stocks query/klines/summary + 前端面板 + AMV  ── 全部零改
```

**进程边界 / 契约不变性**：编排器只感知 `AkShareClient`→`YahooClient` 的接口（`UsFetchResult{df, empty_path}`），不感知底层 API；`raw.us_*` 表 schema 与列语义不变；NestJS 只读、前端 priceMode 切换不变。换源的影响面被收口在 `yahoo_client.py` + `us_daily.py` 因子段。

## B · 取数层 `yahoo_client`

新建 `apps/quant-pipeline/src/quant_pipeline/sync/yahoo_client.py`，**完全沿用 akshare_client 的接口契约**：

- 类 `YahooClient`，方法 `fetch_us_daily(ticker, start_date, end_date) -> UsFetchResult`、`fetch_us_index(index_code) -> UsFetchResult`（`UsFetchResult{df, empty_path}` 复用既有 dataclass 或同形）。
- 限频 `US_SYNC_MIN_INTERVAL_MS`（默认 ~200ms）+ 最多 3 次指数退避 + 空数据双路径 warn（`data_null` / `items_empty`），与 akshare_client 同构。
- **HTTP**：`GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=<unix>&period2=<unix>&interval=1d&events=split%2Cdiv`，仅带 `User-Agent` 头（实测 200，无需 crumb/cookie）。用 stdlib `urllib.request`，**不引入 yfinance**。query1 失败可退到 query2。
- **解析**：`chart.result[0]`：`timestamp[]` → `trade_date`(YYYYMMDD)；`indicators.quote[0].{open,high,low,close,volume}`；`indicators.adjclose[0].adjclose` → `adj_close`。逐字段 None/NaN 过滤（复用 `_f`）。
- **列契约（归一化为小写，与现有下游一致）**：`fetch_us_daily` 返回 `date/open/high/low/close/volume/adj_close`；`fetch_us_index` 返回 `date/open/high/low/close/volume`（无 adj_close、无 amount）。
- **符号映射**：个股裸 ticker 直传；指数内部 code `.NDX` → Yahoo `^NDX`（仅出网时映射，DB 内仍用 `.NDX`）。

## C · 因子改造 `us_daily.py`

替换因子派生段（现 :63-104：两次抓 raw+qfq、coverage-gap、`(f>0).all()` 一票否决）：

```text
单次 fetch_us_daily(ticker, start, end) → 含 close 与 adj_close
factor = adj_close / close                 # 乘法因子，恒正
guard : factor.notna().all() and (factor > 0).all() and 末位 finite > 0
        （保留为不变量哨兵：实务上恒成立；若 Yahoo 数据异常致失败 → 仍走
          factor_empty → us_orchestrator failed_items(us_factor_empty)，fail-loud）
其余写库逻辑不变：
  raw OHLCV(未复权) → us_daily_quote.{open..volume}
  factor            → us_adj_factor
  qfq = raw × factor / 最新factor → us_daily_quote.qfq_*
  指标(输入 qfq)    → us_daily_indicator
```

收益：少一次网络抓取；删除 coverage-gap 分支；深历史不再触发 factor_empty。`raw.close/volume` 仍写**未复权原始值**，保住 AMV 语义。数据模型零改（沿用既有 nullable 列）。

## D · 指数 + AMV

- **指数 `.NDX`**：[us_index.py](../../apps/quant-pipeline/src/quant_pipeline/sync/us_index.py) 零改（client 已归一化列名），落 raw.us_index_daily / us_index_indicator。
- **AMV**：[us_index_amv.py](../../apps/quant-pipeline/src/quant_pipeline/sync/us_index_amv.py) 代码零改（读 `Σ(close×volume)` + .NDX 点位）。但**数值会变**：Yahoo 的 close/volume 与新浪不同 → AMV 绝对量级整体平移。
  - ⚠️ **volume 语义必须实测确认**：摸底子代理提出「Yahoo 拆股后可能给调整后 volume」的疑虑（二手转述）。实现期对一只拆过股标的（如 NVDA / AVGO，2024 年 10:1）亲验：写入 `raw.us_daily_quote.volume` 必须是**未复权原始成交量**；若 Yahoo 返回的是调整后量，则在 client 层用拆股因子还原，保证 AMV 不被复权量污染。
  - AMV golden 对拍基准（`amv_parity_golden.json`）锁算法自洽、非跨源绝对值；换源后量级变，**需重跑并重新 baseline**。

## E · 数据清理 + 重灌（窗口 2025-01-01）

1. **清理 migration**（`docker exec psql` + 配套 `.ps1`，遵循 migrations 规范）：删除全部 **tracked** 标的在 `us_daily_quote`/`us_adj_factor`/`us_daily_indicator` 的现有行；`.NDX` 在 `us_index_daily`/`us_index_indicator`/`us_index_amv_daily` 的现有行一并清。
2. **CLI 重灌**（路径 A，不依赖重启 server/worker）：依次 `us-sync`、`us-index-sync`、`us-index-amv-sync`，窗口 `20250101:<今日>`。
3. ⚠️ **AMV 热身**：AMV 显示起点 2025-01-01 需 ~150 交易行预热（MACD 慢线）；清空 pre-2025 后早期 AMV 会热身退化。AMV 编排器本有 `resolve_warmup_start` 自取热身窗口（会回灌 2024 末成分行）——实现期确认其行为，必要时让 AMV fetch_start 早于 2025-01-01 取热身（这些热身行属 AMV 成分、可接受）。
4. **残留**：6 只 qfq 全空里另外 4 只**未跟踪**的，不在 tracked 清理范围、保持现状（不展示、无影响）。

## F · 依赖

- [pyproject.toml](../../apps/quant-pipeline/pyproject.toml) 移除 `akshare>=1.18.64`，`uv lock` 刷新 uv.lock；**不加 yfinance**（自建 client 用 stdlib）。
- 删除 `akshare_client.py`。确认 akshare 无其它 run_type 使用（延迟 import，仅美股三 run_type 触发）。

## 测试计划

- **新增** `test_yahoo_client.py`：mock HTTP 响应 → 断言列归一化、adj_close 透出、空数据双路径（result 缺失 / 空 timestamp）、重试耗尽 raise、符号映射 `.NDX→^NDX`、period1/period2 拼装。
- **新增** `us_daily` 因子单测：`factor = adj_close/close` 恒正、guard 不变量、qfq = raw×factor/最新factor 正确、raw 列写未复权值。
- **改** `test_akshare_index_client.py`→`test_yahoo_client` 指数路径（列契约去 `amount`）；`test_us_index.py` fixture 去 `amount`。
- **重跑 + 重 baseline** AMV：`test_us_index_amv_formula.py` / `test_us_index_amv_pipeline.py` + `amv_parity_golden.json`。
- **零改** `test_sync_dispatcher_route.py` / `test_us_index_amv_pipeline.py` 编排层（不感知源；仅 fixture 涉源处微调）。
- **真机 / CLI e2e**：清理→重灌后，验 AVGO/NVDA qfq 非空、面板渲染、前复权/不复权口径切换、K 线副图 VOL/KDJ/MACD、summary 涨跌计数、AMV 落库非空。验完恢复任何被改的用户偏好。

## 风险

| 风险 | 缓解 |
|------|------|
| Yahoo 限频 / 偶发 5xx / 接口变动 | 薄封装限频 + 3 次退避 + query1→query2 兜底；空数据双路径 warn |
| Yahoo volume 复权语义不明 | 实现期对拆股标的亲验，必要时 client 层还原原始量（见 D） |
| AMV 量级平移 | 重跑 + 重 baseline golden（见 D/E）；AMV 是相对指标、不做跨源绝对对比 |
| AMV 早期热身退化 | 依赖编排器 `resolve_warmup_start` 自取热身（见 E） |
| 二手转述进硬断言 | 关键事实表标注的 file:line，实现期进 migration / 守门前再亲验（CLAUDE.md 数据完整性铁律） |

## 验证标准（总览）

- Python pytest 全绿（含新增 yahoo_client / 因子单测 + 重 baseline 的 AMV）。
- `uv lock` 后 akshare 不在依赖树；全仓 grep 无 `import akshare` / `ak.` 残留。
- 清理 migration 幂等、配套 .ps1 可 `docker exec` 执行。
- 真机 e2e：AVGO/NVDA qfq 非空 + 面板/口径切换/K 线副图/AMV 全过，0 failed_items。

## 任务清单与文件域切分（供 subagent-driven-development）

并行安全的文件域切分（避免相互覆盖）：

| 任务 | 文件域 | 依赖 |
|------|--------|------|
| T1 取数层 | 新建 `sync/yahoo_client.py` + `test_yahoo_client.py`；删 `akshare_client.py` | — |
| T2 因子改造 | `sync/us_daily.py` 因子段 + 新增因子单测 | T1（用 YahooClient 接口） |
| T3 指数/测试适配 | `test_us_index.py` fixture、`test_akshare_index_client.py` 重命名/改写 | T1 |
| T4 AMV 重 baseline | `test_us_index_amv_*` + `amv_parity_golden.json`（重灌后生成） | T1/T2 + 重灌 |
| T5 依赖 | `pyproject.toml` + `uv lock` | T1（删 client 后） |
| T6 清理 migration | `migrations/<ts>-*.sql` + `.ps1` | — |
| T7 重灌 + e2e | CLI 三 run_type + 真机验证 | T1-T6 |

> 注：T2 改完因子段后，`us_orchestrator` / `dispatcher` / `cli` / `us_index*` 编排层不需改动（不感知源）。
