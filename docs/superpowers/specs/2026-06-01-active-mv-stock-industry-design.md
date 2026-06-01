# 个股 / 行业「活跃市值」指标（Active MV / AMV）设计

> 状态：待实施 | 日期：2026-06-01 | 关联：上一代指数级 0AMV（`market-data/oamv`）
> v2：经独立 spec 审阅修订（修正行业双 join 链路、MACD 复用路径、热身归因、索引、边界处理等）。

## 0. 前置 gate（实施第 1 阶段之前必须先跑通并核对）

行业版依赖「同花顺指数 → 成分股」映射（`ths_member_stocks`）。该表当初仅为资金流面板采集，
**可能未覆盖全部 `type='I'` 行业指数**。因此实施前置动作（独立于 §12 阶段，先做）：

1. 跑 `index-catalog` 的 `syncMembers('I')` 补齐全部行业指数成分股；
2. 核对：`SELECT ts_code, COUNT(*) FROM ths_member_stocks GROUP BY ts_code` 的指数数
   ≈ `SELECT COUNT(*) FROM ths_index_catalog WHERE type='I'`，无大面积缺失才进阶段 1。

## 1. 概述与目标

为**个股**与**行业指数**各自构建一条类 0AMV 的「活跃市值」曲线（AMV），在其上算 MACD，
以 `DIF>0 且 MACD柱>0` 作多头择时信号。交付到「算 + 落库 + API + 前端面板」一层；
信号阈值不做回测校准——MACD 符号判据零阈值、量纲无关，无需逐标的校准。

**与 0AMV 的关系**：沿用「量 × 价」骨架，但砍掉拟合系数 `k` 与 `/1e6`（对符号信号无影响，见 §3 说明），
信号从「单日涨幅阈值」改为「AMV 序列的 MACD 符号」。指数级 0AMV 模块**保持不动**，本设计为并列新模块。

## 2. 关键决策（已与用户确认）

| 项 | 决策 |
|----|------|
| 用途 | 择时/趋势信号（个股 + 行业各自产多/空/中性） |
| 个股「量」 | 自身 `raw.daily_quote.amount`（千元，计算时 ×1000 换算到元） |
| 个股「价」 | **前复权** qfq（避开除权跳空假信号） |
| 行业「量」 | 同花顺指数成分股的 `amount` 之和（`ths_member_stocks` 聚合，见 §3.2 双 join） |
| 行业「价」 | 同花顺指数现成 `ths_index_daily_quotes` 的 OHLC（该表**无 amount**，仅取价） |
| 量纲 | 去掉 `/1e6`（符号信号无关；仅放大显示数值）；`amount×1000` 是单位换算，**不可省** |
| 信号 | 多头 `DIF>0 且 柱>0`；空头 `DIF<0 且 柱<0`；其余中性；边界 `DIF=0` 或 `柱=0` 判中性 |
| MACD 口径 | **自写** `calcMacd(values)`（通达信式 tdEma，同 0AMV）；`indicators.ts` 仅导出整包 `calcIndicators`，不直接复用 |
| 架构 | 独立模块 `market-data/active-mv/` + 两张独立宽表 |
| 历史回填 | 250 交易日（额外 ~90 交易日热身后裁掉，见 §6） |
| 完整性诊断 | 行业表加 `member_count` 列 |
| 前端 | **方案 B**：价格 K 线作主图，新增 `0AMV` / `0AMV_MACD` 两个副图（动共享副图基建，须回归 3 调用点，见 §8） |

## 3. 指标定义

> **符号信号正数缩放不变**：`MACD(c·X)=c·MACD(X)`，`c>0` 不改 `>0/<0`。
> 故 `/1e6`、`0.1`、`k` 等正常数对 `DIF/柱` 符号无影响——砍掉 `/1e6`、`k`，`0.1` 仅习惯量级（可删）。
> 注意区分：`amount×1000` 是**单位换算**（千元→元），不是缩放系数，**不可省**。
> 副作用：AMVc 显示数值变大（个股可达千万级），ECharts 自动缩放，不影响判据；嫌难看可加纯展示除数。

### 3.1 个股版（逐股，`raw.daily_quote` 按 `trade_date` 升序）

```text
v1[t]   = tdSma( amount[t] × 1000, 10 )             # 量：成交额(千元→元) 通达信10日SMA
v3[t]   = MA5( qfq_close[t-1] )                      # 价基准：前复权前一日收盘的5日均
AMVc[t] = v1[t] × qfq_close[t] / v3[t] × 0.1         # 核心值
AMVo/h/l[t] = v1[t] × qfq_{open/high/low}[t] / v3[t] × 0.1
{DIF,DEA,柱}[t] = calcMacd(AMVc, 12, 26, 9)          # 自写, 通达信 tdEma; 柱 = 2×(DIF−DEA)
zdf[t]  = (AMVc[t] − AMVc[t-1]) / AMVc[t-1] × 100    # 仅展示, 不驱动信号; 分母≤0 落 NULL
signal[t] = +1 if DIF[t]>0  且 柱[t]>0
            -1 if DIF[t]<0  且 柱[t]<0
             0 otherwise  (含 DIF=0 或 柱=0 边界)
```

**异常处置**：`v3[t] ≤ 0` 或 `AMVc[t] ≤ 0`（停牌/脏数据）→ 当日**不产指标**，同步响应体记 `stock_amv_empty`；
zdf 分母为 0/负 → 落 `NULL`，不写 Inf/NaN。

### 3.2 行业版（逐个 `type='I'` 同花顺行业指数 idx，**双 join**）

```text
成分股   = ths_member_stocks WHERE ts_code = idx          # idx 形如 881101.TI; 取 con_code 列
                                                          # con_code 形如 000001.SZ
─ 量 join: ths_member_stocks.con_code (.SZ/.SH) = raw.daily_quote.ts_code (.SZ/.SH)
amt[t]   = Σ_{con∈成分股} daily_quote.amount(con, t) × 1000     # 缺失/停牌股跳过并计数
member_count[t] = 当日有 amount 的成分股数
v1[t]    = tdSma( amt[t], 10 )
─ 价 join: ths_member_stocks.ts_code (.TI) = ths_index_daily_quotes.ts_code (.TI)  # 两侧均 .TI
indexOHLC[t] = ths_index_daily_quotes(idx, t).{open,high,low,close}              # 指数点位作价
v3[t]    = MA5( index_close[t-1] )
AMVc[t]  = v1[t] × index_close[t] / v3[t] × 0.1
AMVo/h/l[t]、{DIF,DEA,柱}、zdf、signal、异常处置  同 §3.1（empty 标 industry_amv_empty）
```

> 关键：**量、价是两条不同的 join，用不同列、不同后缀**。量走 `con_code`↔个股表（`.SZ/.SH`）；
> 价走 `ts_code`↔指数日线表（两侧均 `.TI`）。`ths_index_daily_quotes` **无 amount**，绝不从它取量。

## 4. 数据流

```text
个股: raw.daily_quote(qfq OHLC + amount) ──逐股套公式──▶ calcMacd ──▶ stock_amv_daily
行业: ths_member_stocks ─con_code→个股表─┐
      raw.daily_quote.amount ────────────┼─Σ当日成交额=量─┐
      ths_index_daily_quotes(ts_code→.TI)┴─指数OHLC=价────┴─套公式─▶ calcMacd ─▶ industry_amv_daily
                                                                          │
                                                          GET API ◀───────┘──▶ 前端 K线+信号面板
```

## 5. 数据模型

两张宽表，仿 `raw.daily_indicator`（原 `a_share_daily_indicators`，已改名搬入 `raw` schema）。
随附 `migrations/*.sql` + 配套 `.ps1`（`docker exec`）。

```text
stock_amv_daily                          industry_amv_daily
├─ id            BIGSERIAL PK            ├─ id            BIGSERIAL PK
├─ ts_code       VARCHAR  (个股代码)     ├─ ts_code       VARCHAR  (同花顺指数代码 .TI)
├─ trade_date    VARCHAR(8)              ├─ trade_date    VARCHAR(8)
├─ amv_open      DOUBLE PRECISION        ├─ amv_open      DOUBLE PRECISION
├─ amv_high      DOUBLE PRECISION        ├─ amv_high      DOUBLE PRECISION
├─ amv_low       DOUBLE PRECISION        ├─ amv_low       DOUBLE PRECISION
├─ amv_close     DOUBLE PRECISION        ├─ amv_close     DOUBLE PRECISION
├─ amv_dif       DOUBLE PRECISION        ├─ amv_dif       DOUBLE PRECISION
├─ amv_dea       DOUBLE PRECISION        ├─ amv_dea       DOUBLE PRECISION
├─ amv_macd      DOUBLE PRECISION (柱)   ├─ amv_macd      DOUBLE PRECISION (柱)
├─ amv_zdf       DOUBLE PRECISION NULL   ├─ amv_zdf       DOUBLE PRECISION NULL
├─ signal        SMALLINT                ├─ signal        SMALLINT
├─ updated_at    TIMESTAMPTZ now()       ├─ member_count  INTEGER  (完整性诊断)
│                                        ├─ updated_at    TIMESTAMPTZ now()
├─ UNIQUE(ts_code, trade_date)           ├─ UNIQUE(ts_code, trade_date)
├─ CHECK(signal IN (-1,0,1))             ├─ CHECK(signal IN (-1,0,1))
├─ INDEX(ts_code, trade_date DESC)       ├─ INDEX(ts_code, trade_date DESC)
└─ INDEX(trade_date, signal)             └─ INDEX(trade_date, signal)
   ↑ 供 signals?tradeDate= 单日扫全市场     ↑ 同左
```

> `INDEX(trade_date, signal)` 必加：§7 的 `signals?tradeDate=` 按单日扫全表（个股 ~4000 股 ×310 日 ≈ 124 万行），
> 无此索引会全表扫描。

## 6. 后端模块（`apps/server/src/market-data/active-mv/`，每文件 ≤ 500 行）

| 文件 | 职责 |
|------|------|
| `amv-formula.ts` | 公共纯函数：`tdSma`（同 0AMV）、`tdEma`、`calcMacd(values,12,26,9)`、`calcAmvSeries`（量价合成）、`calcSignal`（三态含边界）。**全部通达信式递推，与 0AMV 同口径** |
| `stock-amv.service.ts` | 个股算法 + 增量同步落库（读 `raw.daily_quote`） |
| `industry-amv.service.ts` | 行业算法（成分股 Σamount 聚合，**走裸 SQL** 规避 QueryBuilder `.select()` 水合坑）+ 同步落库 |
| `active-mv.controller.ts` | API（**不**加 `@UseGuards(AuthGuard)`，全局守卫已注册，见 nestjs 规则） |
| `active-mv.module.ts` | 注册；注入 `raw.daily_quote` / `ths_member_stocks` / `ths_index_daily_quotes` / 两张 amv repo + `DataSource`（裸 SQL）。**本模块不直连 Tushare，仅读本地表**（成分股补采是 §0 独立 gate） |
| `active-mv.types.ts` | TS 接口 |
| `entities/active-mv/{stock,industry}-amv-daily.entity.ts` | 两实体 |

**MACD 不复用 `indicators.ts`**：该文件仅导出整包 `calcIndicators(rows)`（吃 close/high/low/volume），
无独立 MACD/EMA 导出；在 AMVc 序列上单算 MACD 须自写 `calcMacd`，并与 0AMV 的 `tdEma`（首值种子、分母 n+1）同风格。

**热身**：AMVc 首段有 NaN（`tdSma` 递推 + `MA5(REF(close,1))` 首行 NaN）；EMA12/26 虽首值种子无 NaN，
但前段数据不足时数值**未收敛**（EMA26 衰减因子 ≈ (25/27)^n，~90 根后收敛到 0.1%）。
因数据全在本地 `raw.*` 表，直接按 `trade_date` 倒序多取 **250 + 90 = 340 交易行**计算，再裁掉热身段落库
（无需 0AMV 那种自然日↔交易日换算，本地表按行取即可）。

## 7. API

```text
POST /api/active-mv/stock/sync       { startDate, endDate, syncMode, tsCodes? }
POST /api/active-mv/industry/sync    { startDate, endDate, syncMode }
GET  /api/active-mv/stock/:tsCode?days=250        # 单股 AMV K线 + DIF/DEA/柱 + signal
GET  /api/active-mv/industry/:tsCode?days=250     # 单行业 AMV K线 + 指标 + signal
GET  /api/active-mv/stock/signals?tradeDate=      # 某日个股信号榜（按 signal/DIF 排序）
GET  /api/active-mv/industry/signals?tradeDate=   # 某日行业信号榜
```

## 8. 前端（方案 B：价格主图 + 2 个新副图）

主图保持**个股/行业指数自身的价格 K 线**；在共享副图系统中**新增两种副图类型**，与价格主图**同一时间轴对照**，
使 `DIF>0 且 柱>0` 的多/空信号能直接贴着真实价格看：
- `0AMV`：活跃市值线（画 `amv_close`，单线）
- `0AMV_MACD`：活跃市值的 MACD（柱 + DIF/DEA 双线，仿现有 `MACD` 副图）

**触及的共享文件（a-share / crypto / backtest 三调用点共用，须回归）**：
- `composables/kline/subplotConfig.ts`：`SubplotKey` 增 `'0AMV' | '0AMV_MACD'`；
  `ALL_SUBPLOT_KEYS`、`DEFAULT_SUBPLOT_HEIGHT_PCT`、`DEFAULT_SUBPLOT_ORDER`、`defaultPrefsFor` 同步补齐。
- `composables/kline/klineChartOptions.ts`：buildGrid/buildXAxes/series 增两副图渲染（`0AMV` 线、`0AMV_MACD` 柱+线）。
- `KlineChartBar` 类型增字段：`'0AMV'`、`'0AMV.DIF'`、`'0AMV.DEA'`、`'0AMV.MACD'`（仿 `'KDJ.K'` 点号约定）。

**挂载范围（`availableSubplots` 门控，默认）**：
- 个股 K 线视图、行业指数 K 线视图：**开** `0AMV` / `0AMV_MACD`；
- crypto、backtest：**关**（无活跃市值数据源）；
- 现有指数级 0AMV 面板（930903）暂不动，可后续同款接入。

**数据投递（方案 D2，与独立模块架构一致）**：
- 后端**不改**现有 K 线接口；0AMV 走 §7 独立接口（`GET /active-mv/{stock,industry}/:tsCode`）；
- 前端拉回后按 `trade_date` **字面相等** merge 进 `KlineChartBar`（`datetime` 规则：两接口日期格式必须统一为
  `YYYY-MM-DD`，否则副图对不齐，缺日填 `null`）；客户端 `api/modules/market/active-mv.ts`。

**命名说明**：副图 `0AMV` 显示的是**当前主图标的（个股/行业）自己的活跃市值**，与指数级 930903 的 0AMV
是同一公式、不同标的；key 以数字开头（`'0AMV'`）仅作数据键 / 类型字面量，**不得**用作 CSS 选择器或 DOM id。

面板**显式标注**：信号未针对个股/行业回测校准；行业量基于成分股当前快照（见 §11 PIT）。

## 9. 错误处理 / 数据完整性（遵循 `.claude/rules/data-integrity.md`）

- **join 后缀核对**（实施前用真实数据各取一条验证，不凭断言）：
  量侧 `ths_member_stocks.con_code` ↔ `raw.daily_quote.ts_code` 须同为 `.SZ/.SH`；
  价侧 `ths_member_stocks.ts_code` ↔ `ths_index_daily_quotes.ts_code` 须同为 `.TI`。不一致 fail-fast + 明确日志。
- **成分股覆盖**：`member_count[t]` < 该指数在 `ths_member_stocks` 的**当前成分总数**（非 `catalog.count`）时
  `logger.warn`（记 covered/expected）；整行业当日 0 成分股有行情 → 不产指标 + `failedItems` 标 `industry_amv_empty`。
- **空数据双路径 warn**：`payload.data===null` 与 `items.length===0` 各 warn 一次，附 apiName+params。
- **增量 0 行**：push 响应体 `errors`/`failedItems`（`*_empty`），**不**伪装「已同步」。
- **upsert 前按 (ts_code, trade_date) 去重**，保留最后一条。
- **禁 `.catch(()=>[])` 静默吞错**：错误透出响应体 + 日志打印具体来源。

## 10. 测试策略（遵循 `.claude/rules/database-sql.md`）

- `amv-formula.spec.ts`：手算固定值验 `tdSma` / `calcMacd`（对一组已知序列核对 DIF/DEA/柱）/ `calcAmvSeries` /
  `calcSignal` 三态边界（`DIF=0`、`柱=0`、`DIF<0且柱<0` 等）。仿 `a-shares-query.sql.spec.ts`。
- 个股：mock `raw.daily_quote` 验前复权价、**除权日不产假信号**、`v3≤0`/`AMVc≤0` 落 empty。
- 行业：mock 成分股 + `daily_quote` 验 Σamount 聚合、`member_count`、双 join 后缀。
- ⚠️ **跨表聚合的裸 SQL / QueryBuilder mock 单测验不出水合正确** → 行业 Σamount 聚合**标注必须真机/集成验证**，
  单测全绿不等于字段对。QueryBuilder `.select()` 一律用实体属性名；行业聚合优先裸 SQL。

## 11. 风险与实施前必须验证项

1. **成分股无 PIT**（致敬 `project_pit_window_guard`）：Tushare `ths_member` 的 `in_date/out_date 暂无`，
   名单是**当前快照**。用当前名单回溯历史 amount 有**成分漂移/幸存者偏差**；择时趋势用途可接受，
   但 spec 与面板须**显式标注**，不得当作精确历史。
2. **个股 qfq 的 PIT**：前复权基准是「最新交易日」，未来发生除权时历史 qfq 值会变 → 重跑同步会改写历史 AMVc。
   所幸「价」用比值 `qfq_close/MA5(qfq_close)`，整段乘性复权因子在比值内大部分抵消，对 MACD 符号影响小；
   仍须知悉：AMV 历史不是冻结的，随除权重算。
3. **join 后缀**（见 §9），实施前以真实数据核对。
4. **首次全量回填量**：~4000 股 ×（250+90）交易行 → 按日期范围分批；可评估复用 worker pool。
5. **量级不可横向比较**：去 `/1e6` 后各标的 AMVc 绝对值不可跨标的比；本次信号为自参照符号判据，
   不涉横截面比较，可接受。
6. **共享副图基建回归**（方案 B）：`subplotConfig` / `klineChartOptions` 被 a-share/crypto/backtest 共用，
   新增 `0AMV`/`0AMV_MACD` 后须验证三调用点**默认偏好下视觉布局不变**（`subplotConfig.ts` 头部注释的硬约束）；
   `localStorage` 持久化的旧 prefs 需经 `normalizePrefs` 兼容（新 key 缺省补齐，不报错）。

## 12. 实施阶段（便于 `dispatching-parallel-agents` 按独立文件域并行）

| 阶段 | 文件域 | 内容 |
|------|--------|------|
| 1 公式+模型 | `amv-formula.ts`、两实体、`migrations/*.sql`+`.ps1` | 公共公式（含 `calcMacd`）、建表（含索引/CHECK） |
| 2 个股 | `stock-amv.service.ts` + controller 个股部分 | 算法+同步+API |
| 3 行业 | `industry-amv.service.ts` + controller 行业部分 | 双 join 成分股聚合+同步+API |
| 4 前端 | `subplotConfig.ts` + `klineChartOptions.ts` + `KlineChartBar` 类型 + `api/modules/market/active-mv.ts` + 个股/行业 K 线视图门控 | 方案 B 两副图 + 前端 merge；**回归 a-share/crypto/backtest 三调用点** |
| 5 测试 | `*.spec.ts` + 集成验证脚本 | 单测+真机验证（含三调用点副图回归） |

> 阶段 0（成分股补采）须先于阶段 1。阶段 2/3 共享 controller 与 module，需在阶段 1 先定好接口骨架与
> `amv-formula.ts` 签名，避免并行写同文件冲突。
> 阶段 4 动**共享副图基建**（`subplotConfig`/`klineChartOptions`），非纯新增——拆并行任务时须单独占用这两文件，
> 不与其它前端任务争用，且完成后回归三个 K 线调用点的默认视觉布局。
