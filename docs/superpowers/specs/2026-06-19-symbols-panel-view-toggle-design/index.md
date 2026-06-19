# Symbols Panel 视图切换与左右分栏详情设计

## 项目背景与目标

将 `ASharesPanel.vue` 的标题删除、按钮居左、新增视图切换按钮与左右分栏详情交互，并推广到 A 股、Crypto、美股三个 Symbols Panel。新增通用 `SymbolsPanelLayout.vue` 与 `ResizableSplitPane.vue`，抽出各市场详情 `***DetailPanel.vue`，补齐 Crypto 的结构同构。

## 子文档清单

| 文档 | 内容 | 相对链接 |
|------|------|----------|
| 01-background-decisions.md | 背景、范围、关键决策 | [./01-background-decisions.md](./01-background-decisions.md) |
| 02-architecture-components.md | 总体架构、文件清单、`SymbolsPanelLayout`、`ResizableSplitPane`、详情面板抽象、Crypto 组件抽出 | [./02-architecture-components.md](./02-architecture-components.md) |
| 03-dataflow-views-responsive.md | 数据流、状态持久化、两种视图形态、视图切换按钮、响应式适配 | [./03-dataflow-views-responsive.md](./03-dataflow-views-responsive.md) |
| 04-checklist-tests-risks.md | 改造清单、测试策略、风险与回滚 | [./04-checklist-tests-risks.md](./04-checklist-tests-risks.md) |

## 建议阅读顺序

1. [01-background-decisions.md](./01-background-decisions.md)
2. [02-architecture-components.md](./02-architecture-components.md)
3. [03-dataflow-views-responsive.md](./03-dataflow-views-responsive.md)
4. [04-checklist-tests-risks.md](./04-checklist-tests-risks.md)

## 跨文档引用约定

- 子文档之间的引用统一使用相对路径 + 锚点，例如 `./02-architecture-components.md#51-symbolspanellayoutvue`（具体锚点以渲染器生成的小写连字符形式为准）。
- 涉及文件路径时，以 `apps/web/src/` 为根描述，便于实现时定位。
