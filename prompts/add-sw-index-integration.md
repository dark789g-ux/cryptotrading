# 接入申万行业指数(含 PE/PB)

> 自包含交接提示词。整段贴给全新会话/agent 即可接手,不依赖前置对话。

## 一句话目标

为 A 股指数体系接入**申万行业指数日线(含 PE/PB 估值)**,作为独立第 4 类 `category='sw'`,与现有同花顺行业(industry)/概念(concept)/大盘(market)并存。前端「A 股指数」表新增「申万」Tab,支持一/二/三级切换。

## 背景:为什么接申万

现有指数体系只接了同花顺(`ths_daily`/`ths_index`):有概念 Tab + 换手率,但 **无 PE/PB 估值**,行业归类是同花顺版(第三方题材分类)非业界标准。申万(申万宏源)是 A 股**业界公认官方行业分类**,`sw_daily` **含 PE/PB**,三级层级严密(2021 版 31/134/346)。两者不冲突,可并存:同花顺看题材,申万看标准行业 + 估值。

## 现状摸底(file:line 为证,别凭模块名猜)

- **分类判据**:`ths_index_catalog.type` 单字母(`I`行业/`N`概念/`M`大盘)→ 物化进 `index_daily_quotes.category`。`apps/server/src/market-data/index-catalog/index-catalog-query.service.ts:27-31`(TYPE_TO_CATEGORY)、`apps/server/src/market-data/index-daily/index-daily.service.ts:96`(`WHERE q.category = $1`)
- **表结构**:`index_daily_quotes` / `index_daily_indicators` **无 PE/PB 列**;`category` 列 `length:8`、**无 DB CHECK 约束**(加新值不必改约束,但值 ≤8 字符;`'sw'`=2 OK)。见 `apps/server/src/entities/index-daily/index-daily-quote.entity.ts`、`index-daily-indicator.entity.ts`
- **行业/概念同步**:`ThsIndexDailySyncService` 按 `trade_date` 横拉 `ths_daily`(当日全部 < 3000 行)。`apps/server/src/market-data/ths-index-daily/ths-index-daily-sync.service.ts:106`(type IN I,N)、`:121-127`(params={trade_date})
- **大盘同步(对照)**:`MarketIndexSyncService` 遍历 `MARKET_INDEX_LIST` 逐个拉 `index_daily`,独立入口 `/api/ths-index-daily/sync/market`(AdminOnly),**不在一键同步**。`apps/server/src/market-data/ths-index-daily/market-index-sync.service.ts:87`、`apps/server/src/market-data/ths-index-daily/ths-index-daily-sync.controller.ts:43`
- **一键同步编排**:6 个 service,**无** marketIndex。`apps/server/src/market-data/one-click-sync/step-runners.ts:36-39`
- **指标计算**:可复用 `ThsIndexDailyIndicatorService.recalculateForSymbols`(按 tsCode 算 MA/MACD/KDJ/BBI/BRICK,与 category 无关)
- **前端消费面**:集中在 `apps/web/src/components/symbols/a-shares-index/`。`types.ts:11`(IndexCategory=market|industry|concept)、`ASharesIndexPanel.vue:84-86`(下拉)、`aSharesIndexColumns.ts:14`(CATEGORY_LABEL)

## 已定方向(用户 2026-06-23 拍板)

1. **接入目的**:独立 Tab 并存(不替代同花顺)
2. **层级**:三级全要(2021 版 31 一级/134 二级/346 三级),前端申万 Tab 内提供一/二/三级切换
3. **category='sw'** 独立第 4 类(length 8 够)
4. **PE/PB 进 `index_daily_quotes`**:migration 加 `pe`/`pb` double nullable,申万填、其它合法 NULL
5. **新建 `sw_index_catalog` 表**:存 `ts_code/name/level(1|2|3)/l1_name/l2_name/l3_name/count/published`。**不污染** `ths_index_catalog`
6. **采集**:`index_classify` 灌目录 + `sw_daily` 按 `trade_date` 横拉(当日全部 < 4000 行),写库 `category='sw'`。**镜像现有 ths 通路**
7. **指标**:复用 `recalculateForSymbols`,申万 K 线自动有 MA/MACD/KDJ/BRICK 副图

## 接口事实(均经 `tushare-sync-dev` skill 查官方文档核证,禁止凭记忆改)

| 接口 | 关键约束 | 字段/单位 | 积分 |
|------|---------|----------|------|
| `sw_daily`(申万行情) | 入参全可选,**可按 trade_date 横拉**;单次 4000 行 | **含 pe/pb/float_mv/total_mv**;vol=**万股**、amount=**万元**、mv=**万元**;默认 2021 版 | 5000 |
| `index_classify`(申万目录) | 2021 版 31/134/346;成分股 <5 不发布 | 一/二/三级 code+name、是否发布、成分股数 | 2000 |
| `index_member_all`(申万成分) | 两方向(行业→股 / 股→行业);单次 2000 行 | l1/l2/l3 code+name、ts_code、**in_date/out_date/is_new** | 2000 |

**成分股调整频率**:Tushare 文档未标;公开规则主干为**半年度**(6/12 月第二个周五生效,出处是中证-申万**联名**指数方案,**纯申万行业指数精确频率无权威出处,待核**申万宏源官方《编制方案》)。**PIT 回测以 `index_member_all.in_date/out_date` 实证为准,不依赖规则**。

## 单位换算(硬规矩,落库前在 fetcher 做)

| 字段 | sw_daily | 现库 | 换算 |
|------|----------|------|------|
| vol | 万股 | `vol_hand`=手 | **×100**(1 手=100 股) |
| amount | 万元 | `amount`=千元 | **×10** |
| total_mv/float_mv | 万元 | `*_mv_wan`=万元 | 一致,不换算 |
| pe/pb | 有 | 无(新增列) | 直填 |

> 不换算会差 10/100 倍且混在同列查不出——最大的坑。

## 待敲定的开放问题

1. **进一键同步?** → 推荐先独立入口 `/sync/sw`(仿 `/sync/market`),跑稳后再并 Step3.5
2. **历史回填范围** → 推荐全史(sw_daily 默认 2021 版,首次全量 overwrite,参照 ths 全量回填口径)
3. **vol 单位** → 换算到「手」统一(推荐) vs 单独保留「万股」语义
4. **申万 AMV** → 本次不做(现有已有同花顺行业/概念 AMV,申万 AMV 独立增量,后续)

## 硬约束 / 项目规范

- **Tushare 接口名/字段/单位/积分**必须先查文档(`tushare-sync-dev` skill),禁止凭记忆/变量名/历史代码推断
- **data-integrity**:单位换算在 fetcher 落库前做;空数据双路径 warn(`data=null` 且 `items.length===0`);0 行显式 `failedItems`(apiName 标 `xxx_empty`);禁 `.catch(()=>[])` 吞错
- `category` 加值不必改 DB CHECK(length:8,无 CHECK);但 migration 加 `pe`/`pb` 列 + 建 `sw_index_catalog` 表 + 灌目录仍需 `migration/*.sql` + `.ps1` 配对
- 新实体须 **module forFeature + app.module 根 entities 数组双注册**(漏后者编译绿但运行时 EntityMetadataNotFound 500)
- 单文件 ≤500 行(`lint:quant-lines`);源文件 UTF-8;timestamptz 列
- 涉及 `.vue` 改动合并前跑 `vite build`(不只 type-check)

## 验证标准

- **数据层**:sw 行情抽样对拍(pe/pb 直填;vol 万股→手 ×100、amount 万元→千元 ×10 核对);目录三级计数 = 31/134/346
- **接口**:`GET /api/indices/latest?type=sw` 返回申万指数列表;`pe`/`pb` 仅 sw 行非空,其它 category 合法 NULL
- **前端**:申万 Tab + 一/二/三级切换 + `pe`/`pb` 列(其它 category 隐藏/置空)+ K 线 Modal(复用 `ASharesIndexKlineModal`,副图含 MA/MACD/KDJ/BRICK)
- **门禁**:后端 jest + 前端 type-check + `vite build` + `lint:quant-lines` 全绿;migration `docker exec` 可执行

## 相关未决

大盘宽基同步(从白名单改动态)是**另一个独立改动域**,见 `prompts/improve-market-index-sync.md`(用户尚未拍板,接手时先确认方向,勿与本任务混做)。

## 前序进度

- 评估完成、方案骨架已定、用户已拍板 2 个关键抉择(独立 Tab + 三级全要)
- **未开工**:无任何代码/migration/实体改动;`tmp_index_basic_probe.py` 为一次性探测脚本(应删,不进仓库)
- 下一步:进入 brainstorming/SDD,先定 4 个开放问题,再按 ths 通路镜像实现
