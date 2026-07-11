# Regime 回测内联配置设计

## 背景与目标（摘要）

将「Regime 配置管理」并入「Regime 回测」：在新建回测时当场编辑象限规则并运行；下线独立配置页。仓位比例 / 最大持仓仅属于象限；单笔买入改为按剩余现金切分；跨 regime 时**开仓 sizing** 用当日象限 `r/maxN` + **开仓停开**条件（不强制平仓）；**已持仓出场**仍用开仓时 exit 快照。同期暴露 `trailing_lock` 全部出场参数（分层 UI +「？」说明）。

日常 `runDaily` / 0AMV 一期不产品化。

## 子文档清单

| 文档 | 说明 |
|------|------|
| [01-background-and-decisions.md](./01-background-and-decisions.md) | 背景、产品定案、非目标 |
| [02-sizing-algorithm.md](./02-sizing-algorithm.md) | 现金切分仓位算法与跨 regime 开仓停开 |
| [03-ui-create-flow.md](./03-ui-create-flow.md) | 新建回测 UI、配置页下线 |
| [04-trailing-lock-params-ui.md](./04-trailing-lock-params-ui.md) | trailing_lock 参数分层 UI |
| [05-api-and-acceptance.md](./05-api-and-acceptance.md) | API / 数据流 / 验收 |
| [06-implementation-plan.md](./06-implementation-plan.md) | 开发计划（SubAgent 编排 + 分 Task） |

## 建议阅读顺序

1. `01` 定案总览  
2. `02` 仓位算法（引擎行为变更）  
3. `03` 创建流 UI  
4. `04` 出场参数 UI（可与 `03` 并行实现）  
5. `05` 接口与验收  
6. `06` 开发计划（实现时按此执行）  

## 跨文档引用约定

统一用相对路径 + 锚点，例如 `./02-sizing-algorithm.md#formula`。
