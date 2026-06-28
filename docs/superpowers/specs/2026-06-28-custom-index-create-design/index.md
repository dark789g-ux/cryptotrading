# A 股自定义指数 — 创建指数 Modal 与计算管线

- 创建日期：2026-06-28
- 状态：设计已确认，待实现

## 背景摘要

在「标的 → A 股数据 → A 股指数」区域新增第三个 sub-tab **「我的指数」**，并在 sub-tab 行右侧放置 **「创建指数」** 按钮。点击后弹出 **5 步向导 Modal**，引导用户完成成分选取、权重方案、基期口径配置，保存后由后台 job 合成历史日线、技术指标、资金流与 AMV，行为与同花顺/申万指数一致。

## 已确认决策

| 维度 | 选择 |
|------|------|
| 目标 | 功能型：创建后可查询、K 线、成分股跳转 |
| 计算口径 | 完整版：价格指数 + 全收益、除权除息、权重版本链、衍生指标 |
| 可见性 | 仅创建者可见（`user_id` 隔离） |
| 展示 | 第三个 sub-tab「我的指数」；按钮在 `n-tabs #suffix` |
| 生命周期 | 可编辑；保存后**手动**触发异步重算（job + SSE） |
| 架构 | **方案 1**：独立 `custom-index` 模块 + 统一读 DTO 复用 K 线 Modal |

## 子文档清单

| 文档 | 说明 |
|------|------|
| [01-background-and-goals.md](./01-background-and-goals.md) | 背景、目标、非目标、设计决策 |
| [02-data-model.md](./02-data-model.md) | PostgreSQL schema、权重版本链、ts_code 规则 |
| [03-index-computation.md](./03-index-computation.md) | 点位合成算法、除权除息、版本切换链式链接 |
| [04-api-and-jobs.md](./04-api-and-jobs.md) | REST API、ml.jobs、`custom_index_compute` worker |
| [05-frontend-ui.md](./05-frontend-ui.md) | Tab 改造、5 步 Modal、列设置、K 线复用 |
| [06-derived-metrics.md](./06-derived-metrics.md) | 技术指标、资金流、AMV 派生 |
| [07-testing-and-rollout.md](./07-testing-and-rollout.md) | 测试计划、迁移脚本、分阶段交付 |

## 建议阅读顺序

1. `01` → 明确范围
2. `02` + `03` → 数据与算法（实现核心）
3. `04` → 后端接口与 job
4. `05` → 前端 Modal 与面板
5. `06` → 衍生指标（可与 04 worker 并行实现）
6. `07` → 验收

## 跨文档引用约定

- 统一使用相对路径 + 锚点，例如 `./02-data-model.md#custom_index_definitions`
- 字段名：DB / 写 body 用 snake_case；**API 响应**与前端 TS 用 camelCase（对齐 `IndexLatestRow`）
- 日期：一律 `YYYYMMDD` 字符串，禁止 `new Date()` 解析业务日期

## 系统总览

```text
┌─ SymbolsView / ASharesIndexPanel ─────────────────────────────────────┐
│  同花顺指数 | 申万指数 | 我的指数                    [+ 创建指数]    │
│  ┌─ ASharesIndexCustomPanel ──────────────────────────────────────┐  │
│  │  行情表（status=ready 可点 K 线；computing 显示进度）            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
         │ 创建/编辑                           │ 读取
         ▼                                     ▼
  CreateCustomIndexModal              GET /api/custom-indices/latest
  (5-step wizard)                     GET /api/custom-indices/:id/kline
         │                                     │
         ▼                                     ▼
  POST /api/custom-indices            ASharesIndexKlineModal (category=custom)
         │
         ▼
  ml.jobs run_type=custom_index_compute
         │
         ▼
  quant-pipeline worker → custom_index_daily_* 表
```
