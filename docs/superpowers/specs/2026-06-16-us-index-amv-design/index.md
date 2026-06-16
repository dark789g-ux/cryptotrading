# 美股指数活跃市值（纳指100 / QQQ AMV）· 设计 spec

> 给美股指数（纳指100 / `.NDX`）做一条「活跃市值（Active MV / AMV）」曲线，对标 A 股已有的
> 行业 / 概念 AMV（成分股成交额 Σ 聚合 + 指数点位），落库 + 前端 K 线副图展示。

## 背景与目标

A 股侧已有成熟的 AMV / 0AMV 体系（`market-data/active-mv`、`market-data/oamv`）。美股侧只有标准
TA（MA/KDJ/MACD/BBI），没有任何活跃市值。本任务把「成分股成交额 Σ → 套 AMV 公式」这套思路搬到
美股指数上，**完全镜像 A 股行业 / 概念 AMV 的口径与实现**。

**已完成 Phase 1 一次性可行性验证**（详见 [01-feasibility-and-data-sources.md](./01-feasibility-and-data-sources.md)），
核心结论：
- 文档原计划的东财 `stock_us_hist`（直接给成交额）**本机不可达**（101 只批量取数成功率 0.99%）。
- 改用**现有生产源新浪 `stock_us_daily`**（101/101 全成、56s），它只给 volume（股数），用
  **`成交额 ≈ volume × close`** 还原；用 LIN 同股同日对拍东财真值，**平均绝对误差 0.281%**，
  聚合 + 10 日平滑后误差更小，**实务可当真值用**。
- 用户已批准此 proxy 口径并批准下方完整设计。

## 关键设计决策（已敲定）

| 维度 | 决策 |
|---|---|
| 数据源 | 新浪 `stock_us_daily` 的 `volume × close` 还原成交额（弃东财） |
| 数据流 | **C-clean**：复用 `sync_us_daily_for_ticker` 取数 + 共享存储 `raw.us_daily_quote`，成分股**不**写入策划清单 `raw.us_symbol`（无外键、零污染美股 Tab） |
| 算法口径 | 镜像行业 / 概念 AMV：`tdSma(amount,10)×price/MA5(REF(close,1))×0.1`，**乘数 0.1、不做 /1e6** |
| 权重 | 裸 Σ 成交额（不加权），镜像行业 AMV |
| 价格侧 | `.NDX` 指数点位 OHLC（读 `raw.us_index_daily`） |
| 范围 | 先只做 `.NDX` 一个指数（结构留可扩展） |
| 落库 | 新表 `raw.us_index_amv_daily`（镜像 `industry_amv_daily`）+ 成分表 `raw.us_index_constituent` |
| 触发 | 新 run_type `us_index_amv_sync`（Python worker） |
| 前端 | 复用现成 `0AMV` / `0AMV_MACD` 副图键 + 泛型 `mergeKlineWithAmv`，渲染层零改 |

## 数据流总览

```text
┌─ raw.us_index_constituent (新表; 101只 .NDX 成分; seed自Wikipedia; weight可空) ──┐
│                                                                                │
▼  run_type: us_index_amv_sync  (新; Python worker dispatcher)                   │
①取数  复用 sync_us_daily_for_ticker 拉101只新浪行情 → upsert raw.us_daily_quote │
        (21只与策划股天然去重; 80只填充股只进quote、不进us_symbol → Tab零污染)   │
②算AMV  读 raw.us_daily_quote: Σ(close×volume) by trade_date + COUNT(member)     │
        读 raw.us_index_daily(.NDX) 取点位 OHLC (us_index_sync 已灌、有warmup史)  │
        套 calcAmvSeries(Python移植, ×0.1) + calcMacd + calcZdf + calcSignal     │
        → upsert raw.us_index_amv_daily                                          │
                                                                                │
▼ NestJS  GET /api/us-index-amv (读) + POST /api/us-index-amv/sync (派job)       │
▼ 前端 UsIndexPanel  availableSubplots += 0AMV/0AMV_MACD                          │
   reload() 并行取AMV → mergeKlineWithAmv(泛型, normalizeDateKey容错日期) → 渲染   │
└────────────────────────────────────────────────────────────────────────────┘
```

## 子文档清单（建议阅读顺序）

| # | 文档 | 内容 |
|---|---|---|
| 1 | [01-feasibility-and-data-sources.md](./01-feasibility-and-data-sources.md) | Phase 1 实测结论、proxy 验证、成分名单、已知口径让步 |
| 2 | [02-data-model.md](./02-data-model.md) | 两张新表 DDL + run_type CHECK 三处镜像 + schema 归属 |
| 3 | [03-amv-formula.md](./03-amv-formula.md) | `calcAmvSeries` 等公式 Python 移植规范 + 逐式 parity |
| 4 | [04-python-pipeline.md](./04-python-pipeline.md) | orchestrator / dispatcher / cli / seed / warmup / 取数 |
| 5 | [05-nestjs-and-api.md](./05-nestjs-and-api.md) | us-index-amv 模块 + run_type 三处 + 实体双注册 + 契约 |
| 6 | [06-frontend.md](./06-frontend.md) | UsIndexPanel 接 AMV 副图 + api client + 日期对齐 |
| 7 | [07-testing-and-verification.md](./07-testing-and-verification.md) | pytest / jest / vitest / 真机 e2e + 验证标准 |
| 8 | [08-task-breakdown.md](./08-task-breakdown.md) | 按文件域切分的并行任务清单 + 依赖顺序（供 subagent-driven-development） |

## 跨文档引用约定

- 一律相对路径 + 锚点，例：`[03 美股口径差异](./03-amv-formula.md#美股口径差异)`。
- 所有 file:line 锚点指向**实仓真实代码**（撰写时已落源头核验，行号可能随后续提交漂移，实现期以
  符号 / grep 复核为准，遵循 `.claude/rules/data-integrity.md`）。

## 命名锁定（全 spec 一致）

- 新表：`raw.us_index_constituent`、`raw.us_index_amv_daily`
- 新 run_type：`us_index_amv_sync`
- Python：`sync/us_index_amv_formula.py`、`sync/us_index_amv.py`、`sync/us_index_amv_orchestrator.py`、`sync/us_index_constituent.py`
- NestJS 模块：`market-data/us-index-amv/`；实体 `entities/raw/us-index-amv-daily.entity.ts`、`entities/raw/us-index-constituent.entity.ts`
- API 前缀：`/api/us-index-amv`
- 前端：`api/modules/market/usIndexAmv.ts`（改 `UsIndexPanel.vue`）
