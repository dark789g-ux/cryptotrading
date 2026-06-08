# 04 · 一键同步接入 · 测试 · 验证 · 文件清单

[← 返回 index](./index.md) · [← 03-frontend](./03-frontend.md)

## 一键同步接入（决策 5：排在最前）

`base-data` 作为 **index 0** 前插现有 7 步。**代价**：前插会把现有 7 步索引整体后移 +1，`markRemainingSkipped(N)` 与编排序列里的字面 index 需 +1（机械改动，须逐处核对）。

### 现有 7 步（前插后变 8 步）

```text
 旧 index   新 index   step key
   —          0        base-data        ★新增，排最前
   0          1        a-shares
   1          2        money-flow
   2          3        ths-index-daily
   3          4        stock-amv
   4          5        industry-amv
   5          6        concept-amv
   6          7        oamv
```

### 改 `components/sync/oneClickSync.types.ts`

| 位置 | 改动 |
|---|---|
| `OneClickStepKey`(3-10) | 追加 `\| 'base-data'` |
| `STEP_LABELS`(54-62) | 加 `'base-data': '基础数据 (日历/涨跌停/停牌)'` |
| `buildInitialSteps()`(79-88) | **数组首位** `emptyStep('base-data')`，其余顺延 |

### 改 `components/sync/useOneClickSync.ts`（566 行）

> 该文件 566 行属 `components/sync/**`，不在 `lint:quant-lines` CI 强制范围；接入只新增 ~15 行。若实测逼近 500 行门槛，把 `runBaseData` 抽到独立小文件。

| 位置 | 改动 |
|---|---|
| 实例化区(55-61) | 加 `const baseDataCtrl = useBaseDataSync(adaptMessage(message))` |
| 新增 `runBaseData()` | 仿 `runThsIndexDaily()`（SSE 步骤）：触发 `baseDataCtrl` 同步、转发进度到该步 state、错误计入 |
| 编排 `start()`(451-503) | **最前**插 `await runBaseData(); if (cancelled.value) { markRemainingSkipped(1); return }`；其后所有现有调用处见下方索引重排说明 |
| `markRemainingSkipped(fromIndex)`(506-510) | 函数体用 `steps.value.length` 动态遍历，**实现无需改** |
| `totalPercent` | 取 `steps.value.length` 动态，无需改 |

**索引重排（`markRemainingSkipped` 入参语义）**：现有代码里该调用的入参是「**剩余待跳过步骤的起始 index**」—— 即跑完位于 index `i` 的步骤后、若取消则传 `i+1`（如旧 a-shares 在 index 0，跑完传 `markRemainingSkipped(1)`）。base-data 前插为 index 0 后**每个原步骤整体下移一位**，故现有每处调用的 `fromIndex` 实参**逐一 +1**（旧 `(1)`→`(2)`、`(2)`→`(3)`…），新 base-data 步取消时用 `markRemainingSkipped(1)`。
> ★`markRemainingSkipped` 的签名与「入参=起始 index」来自 Explore 子代理二手报告。**实现期先亲读 `useOneClickSync.ts:506-510` 确认入参确为起始 index（而非剩余步数/已完成数），再据此逐处改**——若语义不同，重排规则随之调整（遵 data-integrity「二手不进硬改动」）。

> ★实现注意：一键同步里 base-data 用 incremental 默认范围（水位+1 起），不弹 modal，直接跑（仿其它步骤的无交互触发）。

## 测试

### 后端 jest（`pnpm --filter @cryptotrading/server exec jest base-data`）

mock `TushareClientService.query`，覆盖：

1. **依赖顺序**：trade_cal 先于 stk_limit/suspend_d；stk_limit/suspend_d 用的是 trade_cal 落库后查出的开市日。
2. **0 开市日 → 跳过**：trade_cal 范围内无 is_open=1 → `errors` 含 `no_open_trade_dates`，不调 stk_limit/suspend_d。
3. **空数据 failedItem**：某 trade_date stk_limit 返回 0 行 → `errors` 含 `stk_limit_empty` + params，不伪装成功（`success` 不计该日）。
4. **suspend_d 3 列键**：upsert 调用断言冲突键为 `['tsCode','tradeDate','suspendType']`。
5. **is_open 转换**：trade_cal 入库 `isOpen` 为 smallint（'1'→1）。
6. **错误透出**：`result.errors` 完整返回，无 `.catch(()=>[])` 静默。

### 前端 vitest（`pnpm --filter @cryptotrading/web test`）

- `useBaseDataSync`：mock `useSSE`，验 SSE done 事件 → `finished` 置位 + `syncing=false`；`syncProgressVisible` 逻辑；`openModal` 拉 range 算增量默认。

### 类型检查

- `pnpm --filter @cryptotrading/web type-check`
- `pnpm --filter @cryptotrading/server build`

## 真机 e2e 验证标准（落 source，禁二手）

重启后端后端到端：前端点同步看进度 + 落库，再用 `docker exec` 亲查：

1. **更新到最新交易日**：`raw.trade_cal`(is_open=1) / `stk_limit` / `suspend_d` 的 `MAX(trade_date)` 推进到最新开市日。
2. **行级完整**：trade_cal 有 is_open 标记；某开市日 stk_limit 的 `up_limit` 全非空（`docker exec crypto-postgres psql ... -c "SELECT count(*) FROM raw.stk_limit WHERE trade_date='YYYYMMDD' AND up_limit IS NULL"` = 0）。
3. **跨表对齐（stk_limit 强 / suspend_d 弱）** —— 可执行口径，非方向性描述：
   - **stk_limit 强对齐**：验证区间每个开市日 `d`，断言 `count(stk_limit WHERE trade_date=d) >= count(DISTINCT ts_code FROM daily_quote WHERE trade_date=d)`；退化最弱可接受为集合包含 `{stk_limit.trade_date} ⊇ {daily_quote.trade_date}`（同期）。对照 `.claude/rules/data-integrity.md` 的「跨表行数对齐：当日行数 >=」。
   - **suspend_d 弱对齐**：**不做**上述行数/集合断言（某日无停复牌即合法 0 行），仅校验 `MAX(trade_date)` 推进到最新开市日。
4. **data-integrity 可见**：构造/观察某日 Tushare 返回 0 行 → 前端 done 事件能看到对应 `xxx_empty` failedItem，不伪装成功。
5. **SyncView 行数**：改完 `(Get-Content apps/web/src/views/sync/SyncView.vue | Measure-Object -Line).Lines` < 500。
6. **一键同步**：一键跑通，base-data 作为第 1 步先行，后续 7 步索引/skip 正确。

> 验证命令实际执行并贴输出（遵 `verification-before-completion`），不空口声称通过。

## 文件清单

### 新增

| 文件 | 作用 |
|---|---|
| `apps/server/src/market-data/base-data-sync/base-data-sync.module.ts` | 模块 + forFeature + providers |
| `apps/server/src/market-data/base-data-sync/base-data-sync.controller.ts` | SSE run + range 端点 |
| `apps/server/src/market-data/base-data-sync/base-data-sync.service.ts` | sync/startSync/getStoredRange |
| `apps/server/src/market-data/base-data-sync/base-data-sync.types.ts` | DTO/Event/Result/Range 类型 |
| `apps/server/src/market-data/base-data-sync/*.spec.ts` | jest 单测 |
| `apps/web/src/components/sync/useBaseDataSync.ts` | composable |
| `apps/web/src/components/sync/DataSourceCardHeader.vue` | 统一卡头(瘦身) |
| `apps/web/src/api/modules/market/baseDataSync.ts` | API client |
| `apps/web/src/components/sync/useBaseDataSync.spec.ts` | vitest |

### 修改

| 文件 | 改动 |
|---|---|
| `apps/server/src/app.module.ts` | imports 追加 `BaseDataSyncModule` |
| `apps/web/src/views/sync/SyncView.vue` | 6 卡头改 DataSourceCardHeader + 新增基础数据卡 + 解构 + modal 绑定 |
| `apps/web/src/components/sync/oneClickSync.types.ts` | key/label/buildInitialSteps 加 base-data(首位) |
| `apps/web/src/components/sync/useOneClickSync.ts` | 实例化 + runBaseData + 编排最前 + 索引 +1 |
| 记忆 `reference_raw_data_sync_ownership.md` | 标注 NestJS 也写这三表(双写) |

## 硬约束清单（实现期务必带走）

1. **接口名以官方文档为准**：三接口本 spec 已落 doc26/183/214 核实；实现期若再触 Tushare 仍走 `tushare-sync-dev`。
2. **进硬断言的事实落源头**：字段映射已亲查文档；upsert 冲突键、is_open 转换等进代码前再对实体定义/真 DB 一条样本复核，禁采信二手。
3. **空数据双路径 warn / 0 行 failedItem / 禁 `.catch(()=>[])`**：见 [02-backend](./02-backend.md#data-integrity-错误处理硬规范)。
4. **依赖顺序**：trade_cal 先于 stk_limit/suspend_d（后两者取其开市日）。
5. **双写口径对齐**：NestJS 直写列/格式与 Python 侧逐一对齐（原样透传），文件头注释 + 更新记忆标注双写。
6. **forFeature 双注册**：三实体已在 app.module entities，新模块补 forFeature（无新 migration）。
7. **后端 `nest start` 无 watch**：改 `apps/server` 后必重启再验证。
8. **Vue 单文件 < 500 行**（本设计交付门槛）；PowerShell 禁 `&&` 用 `;`；源文件 UTF-8、文件 I/O 显式 `encoding='utf-8'`、对象键名英文。
9. **派 Explore 子代理显式传 `model: sonnet`**。
