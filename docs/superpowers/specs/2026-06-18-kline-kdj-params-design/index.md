# KlineChart KDJ 参数即时重算设计

- 日期：2026-06-18
- 状态：已批准，待实现
- 关联文件：`apps/web/src/components/kline/KlineChartToolbar.vue`

## 目标摘要

在 KDJ 指标名称后添加齿轮按钮，点击后在行内 Popover 修改 `N/M1/M2`，点确定后触发后端按新参数重算 KDJ 并刷新 K 线图。本期仅支持 KDJ，优先接入 Crypto 与 A 股详情页。

## 子文档清单

| 序号 | 文件 | 内容 |
|---|---|---|
| 1 | [01-background-and-decisions.md](./01-background-and-decisions.md) | 背景、目标与关键决策 |
| 2 | [02-architecture-and-types.md](./02-architecture-and-types.md) | 总体架构、数据流与类型/状态扩展 |
| 3 | [03-frontend-ui.md](./03-frontend-ui.md) | Toolbar 与 KdjParamsEditor 组件设计 |
| 4 | [04-backend-api.md](./04-backend-api.md) | 后端 recalc 接口与服务设计 |
| 5 | [05-integration-and-error-handling.md](./05-integration-and-error-handling.md) | 前端接入、错误处理、测试计划与文件清单 |

## 建议阅读顺序

按序号顺序阅读。架构与类型看完之后，UI 和后端可并行阅读；最后看集成与错误处理。

## 跨文档引用约定

- 同一目录内的子文档使用相对路径 `./NN-<subtopic>.md`；
- 需要引用具体章节时使用锚点，例如 `./02-architecture-and-types.md#类型与状态扩展`。
