# 任务交接：前端「数据同步」页新增基础数据(trade_cal/stk_limit/suspend_d)同步入口

> 本文自包含,可整段贴给新会话直接接手。**按项目约定:动手实现前先走 `/brainstorming` 敲定架构方向(HARD-GATE),经用户批准后再用 `subagent-driven-development` 实现。** 本文给已核实的事实底座(file:line 为证)+ 核心架构权衡 + 待敲定的开放问题。

## 一句话需求
前端「数据同步」页(`/sync`,`apps/web/src/views/sync/SyncView.vue`)目前有 6 张数据源卡(加密货币 / A股日线 / 资金流向 / 行业概念目录 / 指数日线 ths_daily / 0AMV)+ 一键同步,但 **`trade_cal`(交易日历) / `stk_limit`(涨跌停) / `suspend_d`(停牌) 这三张基础表没有前端同步入口**——目前只能用 Python CLI 同步。需求:在前端加同步入口,让这些基础数据也能在前端补齐。

## ★核心架构权衡(brainstorming 必须先敲定,别直接动手)
这三张表当前**由 Python quant-pipeline CLI 拥有**:实体文件头明确注释「Python sync 拥有 / 只读 entity / 本里程碑不写 service / controller」(`apps/server/src/entities/raw/{trade-cal,stk-limit,suspend}.entity.ts:1-2`),实体已在 `app.module.ts:110-117` 注册为**只读**(无任何 module `forFeature`、无 service/repository 使用)。且**后端无 spawn Python 子进程的先例**(全 `apps/server/src/**` grep `child_process`/`spawn`/`exec python` **0 匹配**——所有现有同步都是 NestJS 直接调 Tushare via `TushareClientService`)。

所以"前端加同步"必须先定走哪条路:

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. NestJS 直写**(倾向) | 仿 ths-index-daily,新建 NestJS sync service/controller 直接调 Tushare,SSE 推进度,写 `raw.trade_cal/stk_limit/suspend_d` | 与现有前端同步范式完全一致、无新机制、SSE 实时进度 | **双写入口**:同一张表 Python CLI 与 NestJS 都能写,口径须保证一致(或让 Python 侧退役) |
| **B. NestJS spawn Python CLI** | 前端→NestJS→子进程跑 `quant sync raw --tables trade_cal,stk_limit,suspend_d` | 复用 Python 既有逻辑、写入口仍单一(Python) | 无先例、跨进程、进度靠解析 CLI stdout、部署依赖 quant venv |
| **C. quant worker job** | 走现有 `ml.jobs` 机制触发(QuantModule 已支持) | 复用 job 基础设施 | 缺 SSE 实时推送、与 SyncView 卡片范式不一致 |

**brainstorming 要与用户敲定**:倾向 A(最贴现有范式),但**双写一致性**是必须解决的点——NestJS 直写的口径(列、复权、入库格式)须和 Python 侧逐一对齐,否则两个入口写出不同结果。或考虑 A 实现后让 Python 侧 trade_cal/stk_limit/suspend_d 同步退役、统一走 NestJS。

## 现状摸底(file:line 为证,别凭模块名猜)

### Python 当前同步入口(quant-pipeline)
- 同步函数:`sync/trade_cal.py:41 sync_trade_cal(start_date,end_date,exchanges)`;`sync/stk_limit.py:32 sync_stk_limit_by_date(trade_date)`;`sync/suspend.py:31 sync_suspend_by_date(trade_date)`。
- 编排:`sync/orchestrator.py:52-59` 固定顺序(**trade_cal 必须最先**,其它表按日循环依赖它);`:256-283` stk_limit/suspend_d 共用分支,先 `_list_open_trade_dates`(`:90-107`,查 `raw.trade_cal WHERE exchange='SSE' AND is_open=1`)取开市日,**trade_cal 未就绪则写 `failedItem(reason='no_open_trade_dates')` 跳过**(`:259-269`)。
- CLI:`cli.py:125-205` `quant sync raw --date-range YYYYMMDD:YYYYMMDD --tables trade_cal,stk_limit,suspend_d`。
- Tushare API 名(代码读出):`trade_cal`(trade_cal.py:24)、`stk_limit`(stk_limit.py:26)、`suspend_d`(suspend.py:25)。

### NestJS 只读实体 + 注册
- `apps/server/src/entities/raw/trade-cal.entity.ts` / `stk-limit.entity.ts` / `suspend.entity.ts`(头注释"Python sync 拥有")。
- `app.module.ts:110-117` 已在根 `entities` 注册(M1 Part C);**无 forFeature**——新增 sync service 时须补对应 module 的 `TypeOrmModule.forFeature([...])`(否则无法 `@InjectRepository`)。

### NestJS「带 SSE 进度同步」范式(以 ths-index-daily 为模板)
- Controller:`market-data/ths-index-daily/ths-index-daily-sync.controller.ts:9-36`,`GET /ths-index-daily/sync/run`,`@Header` 设 SSE 头,`startSync(dto)` 返回 `Subject`,`subject.subscribe → res.write('data: '+JSON+'\n\n')`,`res.on('close')` unsubscribe。
- Service:`...sync.service.ts:53 sync(dto,onProgress)` + `:261 startSync` 用 RxJS Subject + `setTimeout(...,0)` 异步跑,`onProgress` 回调 `subject.next(event)`。
- **data-integrity**:`...sync.service.ts:154-165` `rows.length===0 → logger.warn + errors.push({apiName:'xxx_empty',params})`,最终 `{type:'done',result:{success,skipped,errors}}` 推前端。
- 双注册:`app.module.ts` entities 数组 + module `forFeature`(如 `ths-index-daily.module.ts:15-19`)。

### 前端加卡范式
- composable:`apps/web/src/components/sync/useThsIndexDailySync.ts:125-138` 标准 exports(`show/syncing/syncMode/syncDateRange/dateRangeLabel/canConfirm/syncProgressVisible/sse/finished/openModal/confirmSync`),用 `useSSE` 消费 `${API_BASE}/.../sync/run?${qs}`(纯 GET SSE,无 token)。
- modal:`components/sync/DataSyncModal.vue:94-113` props(show/title/description/icon/syncing/syncMode/syncDateRange/dataDateRangeLabel/canConfirm/finished) + emits(update:* / confirm) + `#extra` slot 注进度条。
- 一键同步:`components/sync/useOneClickSync.ts` + `oneClickSync.types.ts:79-88` 现 7 步骤(a-shares/money-flow/ths-index-daily/stock-amv/industry-amv/concept-amv/oamv);新卡要接一键同步须:① `OneClickStepKey` 加 key(`:3-10`) ② `STEP_LABELS`/`buildInitialSteps`(`:54-88`) ③ `useOneClickSync.ts:56-61` 实例化 composable + `:467-503` 编排里按序调。
- API client:sync 接口在 `apps/web/src/api/modules/market/`(如 `moneyFlow.ts` 的 `syncRunUrl`);新表仿建 `rawSync.ts` 或合并。
- SyncView.vue 加卡:在 `:9-251` 的 `data-source-grid` 加一张 `<section class="data-source-card">`,script 里实例化对应 composable(`:384-507` 模式)。注意 SyncView 已较长,加卡 + 抽 composable 时守 **Vue 单文件 ≤500 行**(SyncView 当前 ~510 行含 style src,新逻辑尽量进 composable)。

## 待 brainstorming 敲定的开放问题
1. **架构方向**(上表 A/B/C)+ 双写一致性怎么处理。
2. **同步哪些表**:仅 trade_cal/stk_limit/suspend_d,还是连同另 3 张同样"Python 拥有"的 `index_classify/index_member/fina_indicator`(app.module.ts:113-115)一并做?
3. 一张卡同步全部基础表(内部按依赖顺序串) vs 每表一卡?
4. 增量/全量 + 日期范围口径?依赖顺序(**trade_cal 必须先于 stk_limit/suspend_d**)怎么在 service 里保证。
5. 要不要接"一键同步"(若接,trade_cal 应排在所有 A 股相关步骤之前)?
6. 进度推送:SSE(仿 ths-index-daily)还是简单返回?

## 硬约束/项目规范(务必带走)
- **不假设、暴露权衡、用中文**(CLAUDE.md);多解读都列出。
- **接口名以官方文档为准**(`.claude/rules/data-integrity.md`):实现前触发 `tushare-sync-dev` skill。本会话已查 **trade_cal**(参数 exchange/start_date/end_date/is_open;输出 exchange/cal_date/is_open/pretrade_date;2000 积分)、**stk_limit**(参数 ts_code/trade_date/start_date/end_date;输出 trade_date/ts_code/pre_close/up_limit/down_limit;2000 积分;单次 5800 条);**suspend_d 接口文档尚未查,实现前必查**。
- **空数据双路径 warn**:`payload.data===null` 与 `data.items.length===0` 都要 warn + apiName + params。
- **fetcher 0 行显式 failedItems**(`xxx_empty`),禁 `.catch(()=>[])` 静默吞错,错误透出响应体 `errors`。
- **依赖顺序**:trade_cal 先于 stk_limit/suspend_d(后两者取开市日)。
- 若走方案 A(NestJS 直写):列名/复权/入库格式须与 Python 侧逐一对齐(进硬断言前查真 DB 一条样本,子代理报告=二手不直接采信)。
- 新增 TypeORM service 须 module `forFeature`(实体已在 app.module entities,补 forFeature 即可;这些表已建,**不需新 migration**)。
- 后端 `dev` 是 `nest start`(无 watch),改 `apps/server` 后**必须重启**新路由才生效。
- Vue 单文件 ≤500 行;终端 PowerShell 禁 `&&` 用 `;`;源文件 UTF-8、文件 I/O 显式 encoding='utf-8'、对象键名用英文。
- 派 Explore 子代理显式传 `model: sonnet`。

## 验证标准
1. 前端点击同步后,`raw.trade_cal`(is_open=1)/`stk_limit`/`suspend_d` 的 MAX(trade_date) 更新到最新交易日。
2. 行级完整:trade_cal 有 is_open 标记;stk_limit 当日 up_limit 全非空(`docker exec` 抽查)。
3. 跨表对齐:stk_limit/suspend_d 覆盖同期 `daily_quote` 的交易日。
4. data-integrity:某日 Tushare 返回 0 行时前端能看到 warn/failedItem,不伪装成功。
5. 重启后端跑真机端到端(`pnpm --filter @cryptotrading/server build` + 重启 + 前端点同步看进度+落库)。

## 参考文件位置
- 前端:`apps/web/src/views/sync/SyncView.vue`、`components/sync/{DataSyncModal,useThsIndexDailySync,useOneClickSync,OneClickSyncPanel}.*`、`components/sync/oneClickSync.types.ts`、`api/modules/market/moneyFlow.ts`。
- 后端范式:`apps/server/src/market-data/ths-index-daily/ths-index-daily-sync.{controller,service}.ts`、`ths-index-daily.module.ts`、`app.module.ts:110-117`。
- 只读实体:`apps/server/src/entities/raw/{trade-cal,stk-limit,suspend}.entity.ts`。
- Python 侧(对齐口径参考,别 import):`apps/quant-pipeline/src/quant_pipeline/sync/{trade_cal,stk_limit,suspend,orchestrator}.py`、`cli.py:125`。
- Tushare 客户端:`apps/server/src/.../tushare-client.service.ts`(现有 NestJS 调 Tushare 的入口)。

## 前序进度 / 待续
- 本会话(2026-06-08)用 `quant sync raw --date-range 20260529:20260607 --tables trade_cal,stk_limit` 把这两张表从 20260528 补到 **20260605**(成功,行级+跨表完整性已验),并基于补好的数据用「信号前向统计」框架跑了 kdj 阈值分析——正是这个过程暴露了"trade_cal/stk_limit 只能 CLI 同步、前端无入口"的缺口,催生本需求。
- `suspend_d` 这次没同步(kdj 分析用不上),但本需求把它一并纳入。
- 下一步:新会话 `/brainstorming` 以本文为输入 → 派 Explore 复核上述 file:line(尤其确认 ths-index-daily SSE 范式细节、SyncView 当前行数)→ 逐个敲定 6 个开放问题(架构方向最关键)→ 出 spec → subagent-driven-development 实现。
