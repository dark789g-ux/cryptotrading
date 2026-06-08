# 01 · 架构总览与数据流

[← 返回 index](./index.md)

## 一句话需求

前端新增一张「基础数据」卡 + 接入一键同步，让 `raw.trade_cal` / `raw.stk_limit` / `raw.suspend_d` 三张基础表能在前端按日期范围补齐，后端走 **NestJS 直接调 Tushare + SSE 推进度**（方案 A）。

## 架构总览

一张卡 → 一个 SSE 端点 → 一个 service 内部**按依赖顺序串行**同步 3 表（完全复刻 Python `orchestrator` 的固定顺序：trade_cal 最先，stk_limit/suspend_d 按开市日循环）。

```text
┌──────────────────────────────────────────────────────────────┐
│  前端「基础数据」卡 (SyncView)                                  │
│   选 [start_date, end_date] + syncMode(incremental/overwrite)  │
└───────────────────────────┬──────────────────────────────────┘
                            │ GET /base-data/sync/run?start_date&end_date&syncMode
                            │ (useSSE 纯 GET, cookie 认证, 无 token)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  BaseDataSyncController  @Controller('base-data')              │
│   @Get('sync/run'): 三 SSE 头 + res.flushHeaders()            │
│                → subject = service.startSync(dto)              │
│                → subject.subscribe(e => res.write('data: '+…)) │
│                → res.on('close', () => sub.unsubscribe())      │
└───────────────────────────┬──────────────────────────────────┘
                            ▼ startSync → setTimeout(0) 异步 sync(dto, onProgress)
┌──────────────────────────────────────────────────────────────┐
│  BaseDataSyncService.sync()  —— 串行 4 步                      │
│  Step1  trade_cal(exchange=SSE,[start,end])                   │
│         → upsert raw.trade_cal      键(exchange, calDate)     │
│  Step2  查 raw.trade_cal 取 [start,end] is_open=1 开市日列表   │
│         └─ 0 开市日 → errors.push('no_open_trade_dates') 跳过 │
│  Step3  逐开市日 stk_limit(trade_date)                        │
│         → upsert raw.stk_limit      键(tsCode, tradeDate)     │
│  Step4  逐开市日 suspend_d(trade_date)                        │
│         → upsert raw.suspend_d 键(tsCode,tradeDate,suspendType)│ ★3 列键
└───────────────────────────┬──────────────────────────────────┘
                            ▼
              done 事件: { success, skipped, errors[] }
```

## 命名约定

| 实体 | 值 |
|---|---|
| 路由前缀 | `base-data`（控制器前缀；SSE：`GET /api/base-data/sync/run`；库存范围：`GET /api/base-data/range`） |
| 模块 | `BaseDataSyncModule` |
| 目录 | `apps/server/src/market-data/base-data-sync/` |
| 服务 | `BaseDataSyncService` |
| 控制器 | `BaseDataSyncController`（`@Controller('base-data')`，方法 `@Get('sync/run')` + `@Get('range')`，单控制器同时承载 SSE 与库存范围） |
| 前端 composable | `apps/web/src/components/sync/useBaseDataSync.ts` |
| 前端 API client | `apps/web/src/api/modules/market/baseDataSync.ts` |
| 一键同步 step key | `base-data` |

> 命名可调；若与既有路由冲突在实现时校正（实现首步先 grep 确认 `base-data` 路由无占用）。

## Tushare 接口 ↔ 实体列对齐（已核实）

**已落官方文档逐一核对**（脚本 `fetch_tushare_doc.py`，trade_cal 用 doc26、stk_limit doc183、suspend_d doc214），非凭实体列名反推：

### trade_cal（doc26，2000 积分）

| 方向 | 字段 |
|---|---|
| 入参 | `exchange`(N, SSE/SZSE/...) · `start_date`(N) · `end_date`(N) · `is_open`(N '0'/'1') |
| 出参 | `exchange` · `cal_date` · **`is_open`(str '0'/'1')** · `pretrade_date` |
| 实体 `raw.trade_cal` | PK(`exchange` varchar8, `cal_date` varchar8) · `is_open` **smallint** NOT NULL · `pretrade_date` varchar8 null · `updated_at` |
| ★对齐要点 | Tushare `is_open` 是**字符串** '0'/'1'，入库须 `parseInt` 转 smallint |

### stk_limit（doc183，2000 积分，单次最多 5800 条）

| 方向 | 字段 |
|---|---|
| 入参 | `ts_code`(N) · `trade_date`(N) · `start_date`(N) · `end_date`(N) |
| 出参 | `trade_date` · `ts_code` · `pre_close`(N) · `up_limit`(Y) · `down_limit`(Y) |
| 实体 `raw.stk_limit` | PK(`ts_code` varchar16, `trade_date` varchar8 @Index) · `pre_close`/`up_limit`/`down_limit` numeric(30,10) null(TS 层 `string\|null`) · `updated_at` |
| ★对齐要点 | A 股约 5000 只，单日一次取完（< 5800 上限），**无需分页**；按 `trade_date` 逐开市日取 |

### suspend_d（doc214，文档未列积分门槛——Python 已能取，账号积分够）

| 方向 | 字段 |
|---|---|
| 入参 | `ts_code`(N) · `trade_date`(N) · `start_date`(N) · `end_date`(N) · `suspend_type`(N, S 停牌/R 复牌) |
| 出参 | `ts_code` · `trade_date` · **`suspend_timing`(日内停牌时间段，可 None)** · `suspend_type`(S/R) |
| 实体 `raw.suspend_d` | PK(`ts_code` varchar16, `trade_date` varchar8 @Index, **`suspend_type` varchar1**) · `suspend_timing` text null · `updated_at` |
| ★对齐要点 | 按 `trade_date` 查询**不传 `suspend_type`** → 返回当日 S+R 全部行，正好喂 3 列复合 PK；**upsert 冲突键必须 3 列** `['tsCode','tradeDate','suspendType']` |

## 双写归属说明（决策 2 的落地约定）

- NestJS 与 Python CLI 都能写这三张表，**接受双写**：因为三表是 Tushare 原样透传（无复权、无衍生计算，schema 由共享实体钉死），两入口走同一组列 + 同一 Tushare 源 + 幂等 upsert（last-writer-wins 于相同内容）→ 不会发散。
- **不退役 Python 侧**：Python orchestrator 把 trade_cal 作为 A 股备料第一步，退役会让 Python 流水线反过来依赖 NestJS 先跑，引入跨子项目耦合，得不偿失。
- **标注义务**：在新建的 `BaseDataSyncService` 文件头注释标明「与 Python `quant sync raw` 双写 raw.trade_cal/stk_limit/suspend_d，原样透传幂等，口径见此 spec」；并更新记忆 `reference_raw_data_sync_ownership.md`。

## data-integrity 关键差异（影响错误处理，详见 02）

| 表 | 某日 0 行的含义 | 处理 |
|---|---|---|
| **stk_limit** | 开市日 0 行 = **可疑**（每只票每开市日都该有涨跌停价） | 硬 warn + `errors.push('stk_limit_empty')` |
| **suspend_d** | 某日 0 行 = **可能正常**（当日无停复牌事件） | 记 warn + `errors.push('suspend_d_empty')`，但**不进跨表硬对齐断言**（避免误杀稀疏的正常空日） |
| **trade_cal** | 范围内 0 行 / 0 开市日 = 异常或边界 | `errors.push('trade_cal_empty')` / `'no_open_trade_dates'` 并跳过后两表 |

[下一篇：02-backend →](./02-backend.md)
