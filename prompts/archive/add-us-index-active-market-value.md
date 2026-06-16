# 交接：美股指数（QQQ / 纳指100）活跃市值 0AMV/AMV —— 可行性验证 + 建管线

> **一句话目标**：给美股指数（纳指100 / QQQ）做一条「活跃市值（AMV / 0AMV）」曲线，对标 A 股已有的 0AMV（中证全指）/ 行业·概念 AMV，落库 + 前端 K 线副图展示。
>
> 本文档自包含，可整段贴给全新会话直接接手。**分两阶段**：**Phase 1 一次性可行性验证**（先做，确认真实风险点）→ **Phase 2 走 `/brainstorming` → spec → `subagent-driven-development` 建管线**。
>
> ⚠️ 本文档里的"已核验事实"是上一会话一手 spike 得到的（权威），但按 `.claude/rules/data-integrity.md`：**进 fail-fast / 落库 / migration 前必须自己再实跑核验一遍**，标了「子代理报告」的更是二手、务必到源头复核。

---

## 背景

- 美股个股 Tab + 纳指100 指数 K 线已全栈交付（spec `docs/superpowers/specs/2026-06-16-us-index-subtab-design/`、`2026-06-16-us-stocks-tab-design/`），但**美股侧只有标准 TA（MA/KDJ/MACD/BBI…），没有任何 AMV/活跃市值**。
- A 股侧有成熟的 0AMV/AMV 体系。本任务把这套"活跃市值"思路搬到美股指数上。
- 上一会话已核实：算 AMV 的灵魂输入「成交额」**美股个股能取到真实值**（不是只能近似），但**指数/ETF 级取不到**——所以只能走「成分股成交额 Σ 聚合」这条路（对应 A 股**行业/概念 AMV**，而非中证全指那种单指数 0AMV）。

---

## ✅ 已核验数据源（上一会话一手 spike；实现期仍须 data-integrity 复跑）

### 1. 纳指100 / QQQ 成分名单（两源都实测本机可直连 HTTP 200）
```text
首选 stockanalysis API（JSON + 权重）:
  curl -sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" \
    "https://stockanalysis.com/api/symbol/e/QQQ/holdings"
  → {"data":{"holdings":[{"no":1,"n":"NVIDIA Corporation","s":"$NVDA","as":"8.14%","sh":"188,690,766"}, ...]}}
  → s=ticker(带$前缀)、as=权重%、sh=持股数。风险:非官方接口,将来可能加反爬/改结构。
兜底 Wikipedia（pandas 解析,无权重,有 ICB 行业分类）:
  html = requests.get("https://en.wikipedia.org/wiki/Nasdaq-100", headers={UA}).text
  tabs = pd.read_html(io.StringIO(html))    # 注意必须 io.StringIO 包裹,直接传字符串 lxml 会当文件路径报错
  → 按"列含 Ticker/Symbol 且 80<=行<=120"定位(对表序漂移鲁棒); 实测第5表,101 行,
    列 ['Ticker','Company','ICB Industry','ICB Subsector']; 样本 AAPL/ABNB/ADBE/ADI/AMD/AMZN/...
不可用: Invesco 官方 CSV(HTTP 406 反爬,带 Accept/Referer 仍拒) / Slickcharts(HTTP 403 反爬)。
```
- 数量 **101 只**（纳指100 因双重股权如 GOOGL/GOOG 实际 ~101 ticker）。QQQ(ETF持仓) ≈ 纳指100(指数成分)，两源基本同一批。

### 2. 美股个股成交额（akshare 东财 `stock_us_hist`，本机间歇可达）
```python
ak.stock_us_hist(symbol="105.AAPL", period="daily",
                 start_date="20260601", end_date="20260615", adjust="")
# → 11 列: 日期/开盘/收盘/最高/最低/成交量/成交额/振幅/涨跌幅/涨跌额/换手率
# 成交额 = 美元真实成交额(非近似)。实测 2026-06-15:
#   AAPL 1.354e10 / NVDA 3.169e10 / MSFT 1.287e10 / GOOGL 1.025e10
```
- symbol 格式 `105.TICKER`（**105=NASDAQ** 前缀；纳指100 成分全 Nasdaq 上市→全用 105.）。106=NYSE / 107=AMEX。
- ⚠️ **东财源间歇抽风**（`ConnectionError: RemoteDisconnected`）——NVDA 第 2 次才成，**必须重试**；批量 101 只的**成功率/耗时是 Phase 1 要量化的真实风险点**。
- ⚠️ **QQQ ETF 自身（`105.QQQ`）5/5 失败**（东财 US"个股"端点不含 ETF）；`.NDX`（新浪 `index_us_stock_sina`）的 amount 恒 0。**指数/ETF 级成交额都取不到**，只能聚合成分股。
- `adjust` 本次只测了 `""`（不复权）；`"qfq"/"hfq"` 是否可用 + 成交额回溯多远，**Phase 1 实测**。
- 现有 us-stocks 个股管线用的是**新浪 `stock_us_daily`（无 amount）**；东财 `stock_us_hist` 有 amount——可考虑顺带增强（开放问题 4）。

---

## A 股参照实现（要镜像的"同类"全链路）

### 0AMV（中证全指，**单指数 OHLC+amount 派生**）—— 本人已读源头核验
- `apps/server/src/market-data/oamv/oamv.service.ts`：
  - `calc0amv`（**:83-115**，亲验）：`v1=SMA(amount×1000,10)/1e6`；`v3=MA5(REF(CLOSE,1))`；四价 `= v1 × {O/H/L/C} / v3 × (0.1×OAMVK0.87 = 0.087)`。
  - `sync0amv`（**:132-157**，亲验）：拉 Tushare `index_daily`，`ts_code='930903.CSI'`，fields `trade_date,open,high,low,close,amount`；`WARMUP_DAYS=30` 预热（SMA 需前置历史，否则首行 NaN）。
- `oamv_daily` 列（子代理报告，复核 `apps/server/src/entities/oamv/oamv-daily.entity.ts`）：4 价 + `amv_dif/dea/macd` + `ma5/30/60/120/240` + `kdj_k/d/j`（15 业务列）。

### AMV 通用公式 + 行业/概念聚合（**QQQ 最像这条**）—— 子代理报告，进硬断言前复核
- `apps/server/src/market-data/active-mv/amv-formula.ts`：`calcAmvSeries`（约 :130-178）= `SMA(volume,10) × price / MA5(REF(close,1)) × 0.1`（**乘数 0.1，无 0.87 折扣**；volume 入参已换算到元）。
- **行业/概念 AMV** = 成分股 `raw.daily_quote.amount` **Σ 聚合**（裸 SQL 跨表加总），价用同花顺指数点位 `ths_index_daily_quotes`（约 `industry-amv.service.ts:64-67`）。← **QQQ 0AMV 的直接范式**：成分股成交额 Σ + 指数点位。
- 个股 AMV：约 `stock-amv.service.ts:220`，价用 qfq OHLC。
- **关键差异**：0AMV 乘数 `0.087`，行业/概念/个股 AMV 乘数 `0.1`。

### 美股现有管线（要复用/扩展）
- Python `apps/quant-pipeline/src/quant_pipeline/`：`sync/akshare_client.py`（限频/重试/空数据双路径 warn 骨架——直接复用其重试应对东财抽风）、`sync/us_index.py`、`sync/us_indicators.py`（标准 TA 17 列，无 amv）、`sync/us_orchestrator.py`、`worker/dispatcher.py`（`_ROUTES` run_type 路由）、`cli.py`。
- NestJS：`apps/server/src/market-data/us-index-daily/`（指数只读查询 + 派 job 范式）、`market-data/us-stocks/`（个股取数）。
- 实体：`apps/server/src/entities/raw/us-index-daily-{quote,indicator}.entity.ts`（`raw.us_index_daily` **无 amount 列**）。
- 前端：`apps/web/src/components/symbols/UsStocksTabsContainer.vue`（美股二级 tab）、`us-index/UsIndexPanel.vue`、`api/modules/market/usIndexDaily.ts`、`components/kline/KlineChart.vue`。**`composables/kline/subplotConfig.ts` 副图键含 `0AMV`/`0AMV_MACD`**——A 股 0AMV 面板就用这俩副图键，美股指数 AMV 可复用同款渲染。

---

## Phase 1 · 一次性可行性验证（先做，不建表）

目的：把"真实风险点"打通确认，再决定值不值得建管线。

1. **拉 101 成分**：stockanalysis API 主 + Wikipedia 兜底，两源交叉核对名单一致性（差异列出）。
2. **东财批量取数压测**（核心风险点）：用 `stock_us_hist("105."+ticker)` 取 101 只近 N 日（如 60 交易日）成交额，**统计：成功率、平均重试次数、总耗时、失败标的清单**。确认带重试后成功率能否接受。顺带实测 `adjust="qfq"` 是否可用、成交额能回溯多远。
3. **Σ 聚合 + 套公式**：按日 Σ 成分股成交额 → 套 AMV 公式（先用行业/概念那套 `×0.1`）算一条 QQQ AMV 曲线；价格侧先用 `.NDX` 指数点位或成分股加权（开放问题 1/2，Phase 1 可先随便选一种看量级）。
4. **产出**：可行性结论（东财成功率/耗时是否可接受、口径是否合理、曲线数值量级是否正常）+ 数据样本，交回用户决定是否进 Phase 2。

> Phase 1 全程**只读 + 临时脚本**，不落库、不改生产代码、不建 run_type。

---

## Phase 2 · 建管线（Phase 1 通过后）

走 `/brainstorming` 敲定下方开放问题 → 写 spec（拆 <300 行子文档）→ spec 自审（派子代理）→ 用户审 → `subagent-driven-development` 实现。镜像「A 股行业/概念 AMV（成分 Σ）+ us-stocks 取数 + us-index 落库/查询/前端」。

### 待 brainstorming 敲定的开放问题
1. **算法口径**：用行业/概念 AMV 的 `×0.1`，还是模拟 0AMV 的 `×0.087`？价格侧用 `.NDX` 指数点位（新浪）还是成分股加权？「聚合成交额 + 指数点位」如何组合进公式。
2. **权重**：成交额是裸 Σ（A 股行业是裸 Σ amount）还是按 QQQ 权重（stockanalysis 的 `as%`）加权？价格侧是否加权。
3. **成分名单管理**：建 `raw.us_index_constituent` 表定期刷新（stockanalysis 主 + Wiki 兜底）？多久刷一次？成分变动如何影响历史回算（用当前名单近似 vs 历史快照）。
4. **取数稳定性 + 是否增强 us-stocks**：东财 101 只重试策略、失败标的处理（跳过 warn / 整体 failed_items）；要不要把 amount 补进现有 us-stocks 个股管线（`stock_us_hist` 替/补 `stock_us_daily`）顺带增强。
5. **回溯范围**：成交额回溯多久（东财 `stock_us_hist` 实测上限）；历史成分用当前名单近似的误差是否可接受。
6. **落库 + 前端**：新 `raw.us_index_amv` 表 vs 扩 `us_index_indicator` 加 amv 列；前端接 KlineChart 的 `0AMV`/`0AMV_MACD` 副图（已有键）。
7. **触发**：新 run_type `us_index_amv_sync` vs 复用 `us_index_sync`；CLI 命令。

---

## 硬约束 / 项目规范（务必遵守）

- **data-integrity**（`.claude/rules/data-integrity.md`）：接口名 / 字段名（`成交额`）/ symbol 格式（`105.NDX?`、`105.TICKER`）进 fail-fast / 落库 / migration 前**自己实跑核验**；空数据**双路径 warn**（`data=null` 与 `items=0`）；0 行 → `failed_items`（禁伪装成功）；**禁 `.catch(()=>[])` 静默吞错**；东财间歇失败必须重试 + 失败透出。
- **run_type 三处都要改**（本会话踩过，POST 派 job 撞 DB CHECK 约束 500）：`ml-job.entity.ts` runType 联合 + `create-job.dto.ts` 白名单 + **DB 约束 `ml_jobs_run_type_check`**（quant-pipeline alembic `db/migrations/versions/` 权威 + NestJS `apps/server/migrations/*.sql`+`.ps1` 镜像，DROP IF EXISTS+重建真超集）。jest mock create()/CLI job_id=None 都测不出，只真机 UI 同步暴露。
- **datetime**（`.claude/rules/datetime.md`）：`trade_date` 存 `varchar(8) YYYYMMDD`；akshare 给 `YYYY-MM-DD` 需转；K 线 `open_time` 与副图对齐**字符串字面相等**（us-index 现用 `YYYY-MM-DD`，副图懒挂载坑见下）。
- **DB/migration**：`.sql` + 同名 `.ps1`（`docker exec crypto-postgres psql -U cryptouser -d cryptodb`）；实体**双注册**（module forFeature + `app.module.ts` 根 `entities[]`）。
- **前端**：单文件 ≤500 行；合并前必跑 `pnpm --filter @cryptotrading/web build`（vite，type-check 查不出 SFC 编译错）；注释勿含 `*/` token；**懒 tab-pane 数据加载用 `onMounted`**（n-tabs show:lazy 里 `onActivated` 首挂载不触发——本会话真机 e2e 踩过）。
- **NestJS**：Controller 禁 `@UseGuards(AuthGuard)`（全局已注册）；**改后端必须重启**（`nest start` 无 watch）。
- **派 agent 禁 worktree 隔离**（Windows 锁文件）；按文件域切批次避冲突。子代理派发显式 `model: opus`（Explore 摸底可 sonnet）。
- **环境**：Windows PowerShell（禁 `&&` 用 `;`）；源文件 UTF-8；`uv run --directory apps/quant-pipeline ...` 跑 Python。

---

## 验证标准

- **Phase 1**：101 成分两源一致；东财批量取数成功率 + 耗时报告；一条 QQQ AMV 曲线（数值量级合理）。
- **Phase 2**：pytest（成分拉取/成交额取数空数据双路径/Σ 聚合/AMV 公式与 A 股一致性对拍）；jest（查询接口、sync 写对 run_type）；vitest + vite build；真机 e2e（CLI 首灌 → 重启后端 → 美股指数面板 0AMV 副图渲染 + 切 tab resize）。

---

## 前序进度 / 待续

- 数据源全部一手 spike 验证（成分名单 stockanalysis/Wiki、成交额东财 stock_us_hist）；A 股 0AMV `calc0amv` 公式本人已读源头（oamv.service.ts:83-157）。**尚未写任何 AMV 相关代码**。
- 上一会话已修：美股 UI 同步按钮两 latent bug（date_range 冒号串 cea49b3 + run_type CHECK 约束 b1b7ff8）、纳指100 首屏 onMounted（7b468d5）；美股数据已更新至 2026-06-15。
- 相关记忆：`project_us_index_subtab`、`project_us_stocks_tab`（含东财 stock_us_hist 可达订正）、`reference_run_type_check_constraint`、`reference_lazy_tab_pane_onactivated`。
- **下一步**：新会话先做 Phase 1 一次性验证 → 回报用户 → 决定是否 Phase 2 brainstorming 建管线。
- 完成后按 `prompts/` 约定：删除本文件或移入 `prompts/archive/`。
