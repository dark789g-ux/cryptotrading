# 前端「数据同步」页新增基础数据(trade_cal/stk_limit/suspend_d)同步入口 — 设计 spec

> 本目录是 `prompts/add-base-data-sync-frontend.md` 交接需求经 `/brainstorming` 敲定后的设计文档。
> 已按长 spec 拆分规则切分为 index + 4 份子文档（各 < 300 行）。

## 背景与目标（摘要）

前端「数据同步」页（`/sync`，`apps/web/src/views/sync/SyncView.vue`）现有 6 张数据源卡 + 一键同步，但 **`trade_cal`（交易日历）/ `stk_limit`（涨跌停）/ `suspend_d`（停牌）三张基础表没有前端同步入口** —— 目前只能用 Python CLI（`quant sync raw`）同步。本需求：在前端新增同步入口，让这三张表也能在前端补齐，并接入一键同步日常例程。

这三张表当前**由 Python quant-pipeline CLI 拥有**（实体只读、`app.module.ts` 仅根 entities 注册、无 service/controller）。本设计选择 **NestJS 直接调 Tushare 写库**，与现有 6 张卡完全同范式。

## 已敲定的设计决策（brainstorming 结论）

| # | 决策点 | 选定 | 关键理由 |
|---|---|---|---|
| 1 | 架构方向 | **A. NestJS 直写 + SSE** | 仿 ths-index-daily，与现有 6 卡同范式，无新机制；B(spawn Python)无先例、C(quant job)缺 SSE |
| 2 | 双写归属 | **接受双写 + 文档标注** | 三表是 Tushare 原样透传（无复权/衍生），同源 + 幂等 upsert → 写出必然一致；不动 Python(它流水线仍需 trade_cal 先行) |
| 3 | 同步范围 | **仅 3 张基础表** | YAGNI；正是当前 kdj 分析暴露的缺口；另 3 张 Python-owned 表(index_classify/index_member/fina_indicator)性质不同，不纳入 |
| 4 | 卡片粒度 | **一张「基础数据」卡，内部依赖顺序串同步** | 三表有强依赖(trade_cal 先行，stk_limit/suspend_d 读其开市日)；一个 endpoint 内部串行，UX 简单、代码少 |
| 5 | 一键同步 | **接入，排在最前** | trade_cal 是日历骨架；让日常一键例程自动保持三表新鲜（正是本需求起因） |
| 6 | SyncView 瘦身 | **抽 DataSourceCardHeader 子组件 + 逻辑进 composable** | SyncView 已 509 行超 500 通用指南；抽统一卡头(纯展示无逻辑)低风险瘦身回 <500 |

## 子文档清单与阅读顺序

1. [`01-architecture.md`](./01-architecture.md) —— 架构总览、数据流、Tushare 接口 ↔ 实体列对齐表、命名约定、双写归属说明。**先读这份建立全局。**
2. [`02-backend.md`](./02-backend.md) —— 后端模块/控制器/服务设计：SSE 范式、字段映射、依赖顺序、data-integrity 错误处理、DTO/Event/Result 类型。
3. [`03-frontend.md`](./03-frontend.md) —— 前端：useBaseDataSync composable、API client、SyncView 瘦身(DataSourceCardHeader 抽取)、加卡、range 端点驱动增量默认。
4. [`04-one-click-and-testing.md`](./04-one-click-and-testing.md) —— 一键同步接入(含索引重排)、测试(jest/vitest)、真机 e2e 验证标准、文件清单、硬约束清单。

## 跨文档引用约定

- 文档间一律用相对路径 + 锚点，例如 [`./02-backend.md#字段映射验证已落源头`](./02-backend.md#字段映射验证已落源头)。
- 代码引用用 `file:line`（可点击），且**所有 file:line 在 brainstorming 阶段已派 Explore 子代理 + 亲查 Tushare 文档核实**，非二手转述。

## 验证状态底座（已核实，可直接信任）

- **Tushare 三接口已落官方文档核实**（trade_cal doc26 / stk_limit doc183 / suspend_d doc214），字段与实体列逐一对齐，见 [`01-architecture.md`](./01-architecture.md#tushare-接口--实体列对齐已核实)。
- **ths-index-daily 是 SSE 范式模板**（控制器三头 + flushHeaders + Subject，服务 startSync + isSyncing 锁 + setTimeout(0)），细节见 [`02-backend.md`](./02-backend.md)。
- **三实体只读、仅 `app.module.ts:112-114` 根 entities 注册、无 forFeature**；新模块须补 `forFeature`。
- **`apps/server/src` 无 spawn Python 先例**（0 处 child_process），印证方案 A 是唯一贴合现状的路。
