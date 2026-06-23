# 申万行业指数接入（含 PE/PB）— 设计

> 独立 spec。与 `2026-06-23-market-index-dynamic-scope-design` 无代码耦合，
> 唯一共享文件域是 `one-click-sync/`（两任务各加一个 step），见 [03-one-click-sync.md](./03-one-click-sync.md) 末尾「共享文件域协调」。

## 一句话目标

为 A 股指数体系接入**申万行业指数日线（含 PE/PB 估值）**，作为独立第 4 类 `category='sw'`，与现有同花顺行业(industry)/概念(concept)/大盘(market)并存。前端「A 股指数」面板新增「申万指数」sub-tab，支持一/二/三级切换。

## 背景

现有指数体系只接了同花顺（`ths_daily`/`ths_index`）：有概念 Tab + 换手率，但**无 PE/PB 估值**，行业归类是同花顺版（第三方题材分类）。申万（申万宏源）是 A 股**业界公认官方行业分类**，`sw_daily` **含 PE/PB**，三级层级严密（2021 版 31 一级 / 134 二级 / 346 三级）。两者并存：同花顺看题材，申万看标准行业 + 估值。

## 数据流

```text
  Tushare index_classify               Tushare sw_daily (按 trade_date 横拉)
  (market=SW, 31/134/346 三级)                   │
         │                                       ▼
         ▼                            index_daily_quotes
   sw_index_catalog                    (category='sw', +pe +pb 新列)
   (三级层级目录)                                 │
         │                              recalculateForSymbols
         │ level IN 查询                  (MA/MACD/KDJ/BBI/BRICK)
         ▼                                       │
   前端申万 sub-tab ◄──── index_daily_indicators ◄┘
   (层级切换 + pe/pb + K线Modal)

  入口:  首次全量 GET /api/sw-index-daily/sync (AdminOnly)
         日常增量 one-click-sync sw-index-daily step
```

## 已定决策（2026-06-23 brainstorming 拍板）

1. **独立 sub-tab 并存**（不替代同花顺）
2. **三级全要**（2021 版 31/134/346），申万 sub-tab 内一/二/三级切换
3. **`category='sw'`** 独立第 4 类（`varchar(8)` 无 CHECK，`'sw'`=2 字符安全）
4. **PE/PB 进 `index_daily_quotes`**：migration 加 `pe`/`pb` double nullable，申万填、其它合法 NULL
5. **新建 `sw_index_catalog` 表**（不污染 `ths_index_catalog`）
6. **采集**：`index_classify` 灌目录 + `sw_daily` 按 `trade_date` 横拉，镜像现有 ths 通路
7. **并入一键同步 step**（增量），首次全量走独立 `GET /api/sw-index-daily/sync`
8. **历史回填近 5 年**（sw 2021 版起，近 5 年 ≈ 全史，无丢早期数据风险）
9. **vol 换算「手」统一**（万股 ×100），amount 万元 ×10→千元，pe/pb 直填，mv 万元一致
10. **复用 `recalculateForSymbols`**（申万 K 线自动有 MA/MACD/KDJ/BBI/BRICK）
11. **申万 AMV 本次不做**（独立增量，后续）

## 子文档清单

| 文档 | 内容 |
|------|------|
| [01-data-model.md](./01-data-model.md) | migration A(pe/pb) + B(sw_index_catalog) + 实体 + category |
| [02-backend-sync.md](./02-backend-sync.md) | SwIndexDailySyncService + 单位换算 + data-integrity + controller |
| [03-one-click-sync.md](./03-one-click-sync.md) | 并入 sw-index-daily step 改动点（6 后端 + 3 前端） |
| [04-frontend.md](./04-frontend.md) | sub-tab + pe/pb 列 + level 查询 + K线Modal |
| [05-validation-and-tasks.md](./05-validation-and-tasks.md) | 验证标准 + 风险 + SDD 任务拆分 |

## 阅读顺序

`01` → `02` → `03` → `04` → `05`。01/02 是后端数据基础；03 依赖 02 的 service；04 依赖 01/02；05 是验收 + SDD 拆分。

## 硬约束

- **Tushare 接口名/字段/单位/积分**必须先用 `tushare-sync-dev` skill 查文档（`index_classify` / `sw_daily`），禁止凭记忆/变量名/历史代码推断
- **data-integrity**：单位换算在 fetcher 落库前做；空数据双路径 warn（`data=null` 且 `items.length=0`）；0 行显式 `failedItems`（`sw_daily_empty`）；禁 `.catch(()=>[])`
- 新实体须 **module forFeature + app.module 根 entities 数组双注册**（漏后者编译绿但运行时 EntityMetadataNotFound 500）
- 单文件 ≤500 行（`lint:quant-lines`）；源文件 UTF-8；migration `*.sql` + 同名 `.ps1` 配对
- 涉及 `.vue` 改动合并前跑 `vite build`（不只 type-check）

## 相关

- 大盘宽基动态范围（独立任务）：`../2026-06-23-market-index-dynamic-scope-design/index.md`
- 交接来源（实施后归档）：`prompts/add-sw-index-integration.md`
