# 美股数据源 AkShare → Yahoo 全量迁移 — 设计 spec

> 一句话目标：把美股（个股日线 + .NDX 指数 + AMV）的数据源从 **AkShare（新浪 `stock_us_daily`）** 全量切换到 **Yahoo Finance chart API（自建薄封装，非 yfinance 库）**，并用 `Adj Close / Close` 这个恒正的乘法复权因子取代会变负的减法式 qfq 派生因子；彻底移除 akshare 依赖。保留现有「存原始价 + adj_factor → 公式算 qfq」的**数据模型与编排逻辑**不变，下游 NestJS / 前端**代码**零改。

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
| 3 | 重灌窗口 | 分析起点 **2025-01-01**；**fetch 起点 2024-01-01**（≥250 交易行热身缓冲，保 MA240/AMV 自 2025-01-01 满血） |
| 4 | 旧数据处理 | **全新灌后删 `trade_date < '20240101'` 全部行**（含 .NDX 指数表与 AMV 成分行，非仅 tracked）；2024 热身段保留（单源 Yahoo），统一单源、无孤儿 |

> 关于窗口：2025-01-01 窗口本身**不触发负值 bug**（负值只在深历史；实测 AVGO 从 20250102 起 0 坏行）。此窗口下迁移的价值是**口径更正确 + 单一数据源 + 未来回填长历史也不再炸**。

## 关键事实（摸底已落 file:line；进硬断言 / migration 前实现期须再亲验）

| 事实 | 证据 |
|------|------|
| 所有 `ak.` 调用收口在 akshare_client 两方法（延迟 import） | [akshare_client.py:59](../../apps/quant-pipeline/src/quant_pipeline/sync/akshare_client.py)（`stock_us_daily`）、:104（`index_us_stock_sina`） |
| **旧 client 签名是 `fetch_us_daily(ticker, adjust="")`**（第二参是 adjust，抓全量后由调用方切窗），非按日期出网 | akshare_client.py:43；窗口切在 us_daily.py:69 / us_index.py:61 |
| 个股链路两次抓：`adjust=""`(:63) + `adjust="qfq"`(:81)，中段夹 coverage-gap + `(f>0).all()` 守门(:87-104) | us_daily.py:63/81/87-104 |
| `us_daily.py` 是唯一写 us_daily_quote / us_adj_factor / us_daily_indicator 的地方 | 表名常量 us_daily.py:23-25；upsert :144/:159/:179 |
| 个股/指数/AMV 三个独立 run_type | dispatcher `_ROUTES` us_sync :539 / us_index_sync :541 / us_index_amv_sync :543 |
| 指数链路用 `ak.index_us_stock_sina(".NDX")`，落 raw.us_index_daily/us_index_indicator | us_index_orchestrator.py:26（`DEFAULT_INDEX_SYMBOLS=(".NDX",)`）、us_index.py:54 |
| **us_daily_quote 由 us_sync(tracked) 与 us_index_amv_sync(NDX 成分) 共写**；AMV 成分经 sync_us_daily_for_ticker 灌入 | us_index_amv_orchestrator.py:120（调 sync_us_daily_for_ticker，签名已带 start/end） |
| AMV 只读 `Σ(raw.close × raw.volume)` 原始价×量 + .NDX 点位（不×1000） | us_index_amv.py:104-116（量侧）、:137-159（.NDX 点位读 raw.us_index_daily） |
| AMV 热身起点 `resolve_warmup_start` 查 `us_index_daily` 中 `trade_date < start` 的更早行 | us_index_amv.py:66；编排器据其返回值定 fetch_start :106→123 |
| NestJS query 默认 priceMode=qfq，取 qfq_close/qfq_pct_chg | us-stocks-query.sql.ts:101-105；useUsStocksQuery.ts:24 |
| klines 端点 `WHERE qfq_* IS NOT NULL`（qfq 空则该 ticker K 线返回空） | us-stocks.service.ts:183-186 |
| `raw.us_adj_factor` 全仓无读取方（仅 us_daily.py 写存档；实体仅 app.module 根 entities[] + us-stocks.module forFeature 注册，无 SQL 查询） | app.module.ts:138；us-stocks.module.ts:26 |
| 四张 us_* 表所有价格列（含 qfq_*）均 nullable，无 NOT NULL 约束 | migrations/20260616120000-create-us-stocks.sql |
| **qfq 全空 6 只 = AVGO/NVDA(tracked) + FANG/KLAC/LRCX/STX(NDX 成分，不在 us_symbol)**（DB 实测 2026-06-17） | `SELECT ... HAVING count(qfq_close)=0` |
| 依赖用 uv；akshare>=1.18.64 直接依赖；yfinance 未出现 | pyproject.toml:31、uv.lock |

## 架构与数据流

```text
┌─ Python (apps/quant-pipeline) ─────────────────────────────────────────────┐
│  yahoo_client (新, 替换 akshare_client)                                     │
│    fetch_us_daily(ticker, start, end) ─Yahoo v8 chart(period1/period2)─▶    │
│        df: date/open/high/low/close/volume/adj_close   (列名归一化为小写)   │
│    fetch_us_index(".NDX", start, end)  ─Yahoo v8 chart(^NDX)─▶              │
│        df: date/open/high/low/close/volume             (指数无复权)         │
│                                                                             │
│  us_daily.py (改因子段):                                                    │
│    单次 fetch_us_daily → close + adj_close                                  │
│    factor = adj_close / close   ← 乘法、恒正、(f>0) 守门实务上不再触发       │
│    raw OHLCV(未复权) ─▶ us_daily_quote.{open..volume}  ← AMV 仍吃原始价×量   │
│    factor            ─▶ us_adj_factor                                       │
│    qfq = raw × factor / 最新factor ─▶ us_daily_quote.qfq_*                  │
│    指标(吃 qfq)      ─▶ us_daily_indicator                                  │
│                                                                             │
│  编排器(run_us_*) / dispatcher / cli : 逻辑零改; us_index.py/us_daily.py    │
│    的 client 调用点随签名改传参（见 B/C）                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                          │ (只读, 表 schema 与列语义不变)
                          ▼
   NestJS us-stocks query/klines/summary + 前端面板 + AMV  ── 代码零改
```

**影响面收口**：换源真正改动的是 ① 新建 `yahoo_client.py`（删 `akshare_client.py`）；② `us_daily.py` 因子段 + 其 client 调用点；③ `us_index.py` 的 `fetch_us_index` 调用点（传窗口）。`UsFetchResult{df, empty_path}` dataclass、编排器逻辑、`sync_us_daily_for_ticker`/`sync_us_index_for_symbol` 对外签名（本就带 start/end）、dispatcher/cli、NestJS、前端均不改。下游**代码**零改；但**展示数值会变**（qfq 口径 AkShare→Yahoo、AMV 量级平移，见 D/E）。

## B · 取数层 `yahoo_client`

新建 `apps/quant-pipeline/src/quant_pipeline/sync/yahoo_client.py`：

- 类 `YahooClient`，方法 `fetch_us_daily(ticker, start_date, end_date)` 与 `fetch_us_index(index_code, start_date, end_date)`，返回复用 `UsFetchResult{df, empty_path}`。**注意接口签名变了**：旧 client 是 `(ticker, adjust)` + 抓全量再切窗；Yahoo 必须按 `period1/period2` 出网，故签名改为带日期窗口（调用点改动见 C / §影响面）。
- 限频 `US_SYNC_MIN_INTERVAL_MS`（默认 ~200ms）+ 最多 3 次指数退避 + 空数据双路径 warn（`data_null` / `items_empty`），与 akshare_client 同构。
- **HTTP**：`GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=<unix>&period2=<unix>&interval=1d&events=split%2Cdiv`，仅带 `User-Agent` 头（实测 200，无需 crumb/cookie）。用 stdlib `urllib.request`，**不引入 yfinance**。query1 失败退到 query2。用显式 `period1/period2`（非 `range=max`，后者会被降采样成月线）。
- **解析**：`chart.result[0]`：`timestamp[]` → `trade_date`(YYYYMMDD)；`indicators.quote[0].{open,high,low,close,volume}`；`indicators.adjclose[0].adjclose` → `adj_close`。逐字段 None/NaN 过滤。
- **列契约（归一化小写）**：`fetch_us_daily` 返回 `date/open/high/low/close/volume/adj_close`；`fetch_us_index` 返回 `date/open/high/low/close/volume`（无 adj_close、无 amount）。
- **符号映射**：个股裸 ticker 直传；指数内部 code `.NDX` → Yahoo `^NDX`（仅出网时映射，DB 内仍用 `.NDX`）。

## C · 因子改造 `us_daily.py`

**删除** us_daily.py:81-104（第二次 `adjust="qfq"` 抓取 + coverage-gap 分支 + 旧 `(f>0).all()` 对齐守门）。**改** :63 那次抓取为单次 `fetch_us_daily(ticker, start_date, end_date)`，返回含 `adj_close` 的 df（不再传 `adjust=""`）。新因子段：

```text
df = client.fetch_us_daily(ticker, start, end)   # 含 close 与 adj_close
factor = df.adj_close / df.close                 # 乘法因子，恒正
guard  : factor.notna().all() and (factor>0).all() and 末位 finite>0
         （保留为不变量哨兵：实务恒成立；若 Yahoo 数据异常致失败 → 仍走
           factor_empty → us_orchestrator failed_items(us_factor_empty)，fail-loud）
其余写库逻辑不变：
  raw OHLCV(未复权) → us_daily_quote.{open..volume}
  factor            → us_adj_factor
  qfq = raw × factor / 最新factor → us_daily_quote.qfq_*
  指标(输入 qfq)    → us_daily_indicator
```

收益：少一次网络抓取；删 coverage-gap；深历史不再触发 factor_empty。`raw.close/volume` 仍写**未复权原始值**，保住 AMV 语义。数据模型零改（沿用既有 nullable 列）。窗口切片（旧 :69）保留，但 fetch 已按 period1/period2 取窗，切片成为冗余保险。

## D · 指数 + AMV

- **指数 `.NDX`**：[us_index.py](../../apps/quant-pipeline/src/quant_pipeline/sync/us_index.py) 仅改 `fetch_us_index` 调用点（:54 传入窗口），其余零改；落 raw.us_index_daily / us_index_indicator。
- **AMV**：[us_index_amv.py](../../apps/quant-pipeline/src/quant_pipeline/sync/us_index_amv.py) 代码零改（读 `Σ(close×volume)` + .NDX 点位）。AMV 成分（含上文 FANG/KLAC/LRCX/STX）经 `sync_us_daily_for_ticker` 走同一新取数路径。但**数值会变**：Yahoo 的 close/volume 与新浪不同 → AMV 绝对量级整体平移。
  - ⚠️ **volume 语义必须实测确认**：摸底子代理提出「Yahoo 拆股后可能给调整后 volume」的疑虑（二手转述）。实现期对一只拆过股标的（NVDA / AVGO，2024 年 10:1）亲验：写入 `raw.us_daily_quote.volume` 必须是**未复权原始成交量**；若 Yahoo 返回调整后量，则在 client 层用拆股因子还原。
  - AMV golden 对拍基准（`amv_parity_golden.json`）锁算法自洽、非跨源绝对值；换源后量级变，**需重跑并重新 baseline**。

## E · 清理 + 重灌

**fetch 起点 2024-01-01（热身缓冲），分析起点 2025-01-01。先灌后删（避免中途失败致面板更空）**：

1. **CLI 重灌**（路径 A，不依赖重启 server/worker）：依次 `us-sync`、`us-index-sync`，窗口 `20240101:<今日>`；再 `us-index-amv-sync`（分析起点 2025-01-01，其 `resolve_warmup_start` 从已灌的 2024 .NDX + 成分行取热身 → AMV 自 2025-01-01 满血）。重灌对窗口内现有行是 upsert 覆盖（幂等），不产生空窗。
2. **校验**：行数 / qfq 非空 / 指标自 2025-01-01 满血 / AMV 落库非空通过后，**再**执行清理 migration。
3. **清理 migration**（`docker exec psql` + 配套 `.ps1`，遵循 migrations 规范）：删除 `us_daily_quote`/`us_adj_factor`/`us_daily_indicator`/`us_index_daily`/`us_index_indicator`/`us_index_amv_daily` 六表中 `trade_date < '20240101'` 的**全部行**（清掉 pre-2024 孤儿，含 4 只 AMV 成分孤儿 FANG/KLAC/LRCX/STX）。2024 热身段保留（单源 Yahoo）。
4. 因「先灌后删」，任一步失败时旧数据仍在，可重试；清理只在重灌校验通过后发生。

**热身**：fetch 自 2024-01-01 给 ~250 交易行缓冲 → MA240/MA120 等长回看指标与 AMV 的 MA/MACD **自 2025-01-01 即满血**。2024 年内（分析起点之前）的长指标仍热身退化，属可接受。

## F · 依赖

- [pyproject.toml](../../apps/quant-pipeline/pyproject.toml) 移除 `akshare>=1.18.64`，`uv lock` 刷新；**不加 yfinance**。删除 `akshare_client.py`。确认 akshare 无其它 run_type 使用（延迟 import，仅美股三 run_type 触发）。

## 测试计划

- **新增** `test_yahoo_client.py`：mock HTTP → 断言列归一化、adj_close 透出、空数据双路径（result 缺失 / 空 timestamp）、重试耗尽 raise、符号映射 `.NDX→^NDX`、period1/period2 拼装。
- **新增** `us_daily` 因子单测：`factor = adj_close/close` 恒正、guard 不变量、qfq = raw×factor/最新factor、raw 列写未复权值。
- **改** `test_akshare_index_client.py`→`test_yahoo_client` 指数路径（列契约去 `amount`、改 mock 目标）；`test_us_index.py` fixture 去 `amount`、`fetch_us_index` 调用加窗口参数。
- **改** 个股/指数调用点相关测试：凡断言 `fetch_us_daily(ticker, adjust=...)` / `fetch_us_index(symbol)` 旧签名处，改为带日期窗口签名。
- **重跑 + 重 baseline** AMV：`test_us_index_amv_formula.py` / `test_us_index_amv_pipeline.py` + `amv_parity_golden.json`。
- **零改** `test_sync_dispatcher_route.py`（路由不感知源）。
- **真机 / CLI e2e**：重灌后验 AVGO/NVDA qfq 非空、面板渲染、前复权/不复权口径切换、K 线副图 VOL/KDJ/MACD、summary 涨跌计数、AMV 落库非空。验完恢复任何被改的用户偏好。

## 风险

| 风险 | 缓解 |
|------|------|
| Yahoo 限频 / 偶发 5xx / 接口变动 | 薄封装限频 + 3 次退避 + query1→query2 兜底；空数据双路径 warn |
| Yahoo volume 复权语义不明 | 实现期对拆股标的亲验，必要时 client 层还原原始量（见 D） |
| AMV 量级平移 | 重跑 + 重 baseline golden（见 D/E）；AMV 是相对指标、不做跨源绝对对比 |
| 长回看指标 / AMV 早期热身退化 | fetch 自 2024-01-01 留 ~250 交易行缓冲 → 自 2025-01-01 满血（见 E） |
| 重灌中途失败致面板更空 | 先灌后删 + 校验通过再清理（见 E） |
| 二手转述进硬断言 | 关键事实表 file:line，实现期进 migration / 守门前再亲验（CLAUDE.md 数据完整性铁律） |

## 验证标准（总览）

- Python pytest 全绿（含新增 yahoo_client / 因子单测 + 重 baseline 的 AMV）。
- `uv lock` 后 akshare 不在依赖树；全仓 grep 无 `import akshare` / `ak.` 残留。
- 清理 migration 幂等、配套 .ps1 可 `docker exec` 执行；先灌后删顺序落实。
- 真机 e2e：AVGO/NVDA qfq 非空 + 面板/口径切换/K 线副图/AMV 全过 + 指标自 2025-01-01 满血，0 failed_items。

## 任务清单与文件域切分（供 subagent-driven-development）

| 任务 | 文件域 | 依赖 |
|------|--------|------|
| T1 取数层 | 新建 `sync/yahoo_client.py` + `test_yahoo_client.py`；删 `akshare_client.py` | — |
| T2 因子改造 | `sync/us_daily.py` 因子段 + client 调用点 + 因子单测 | T1 |
| T3 指数调用点 + 测试适配 | `sync/us_index.py:54` 调用点；`test_us_index.py` / `test_akshare_index_client.py` 重命名改写 | T1 |
| T4 AMV 重 baseline | `test_us_index_amv_*` + `amv_parity_golden.json`（重灌后生成） | T1/T2 + 重灌 |
| T5 依赖 | `pyproject.toml` + `uv lock` | T1（删 client 后） |
| T6 清理 migration | `migrations/<ts>-*.sql` + `.ps1`（删六表 `trade_date < '20240101'` 全行） | — |
| T7 重灌 + e2e | CLI 三 run_type 先灌（us-sync/us-index-sync 窗口 20240101+，AMV 分析起点 2025-01-01）→ 校验 → 清理 → 真机验证 | T1-T6 |

> 注：编排层（run_us_* / dispatcher / cli）与 `sync_us_daily_for_ticker`/`sync_us_index_for_symbol` 对外签名不改；改动落在 client 调用点。
