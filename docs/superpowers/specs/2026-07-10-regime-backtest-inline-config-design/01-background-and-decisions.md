# 01 · 背景与产品定案

## 问题

1. Regime 配置与 Regime 回测分属两页；新建回测需先选已有配置，心智割裂。  
2. 「仓位比例 / 最大持仓」同时出现在配置象限与回测 `capital`，优先级易混淆。  
3. 现算法 `alloc = positionRatio × 昨收净值` 在持仓浮盈后易出现目标买入 > 现金。  
4. `trailing_lock` 仅暴露 `maxHold`，其余参数有默认值但前端不可配。

## 产品定案

| 项 | 定案 |
|----|------|
| 配置入口 | 并入 Regime 回测；下线独立「Regime 配置」页与 Sidebar 项 |
| 仓位比例 / 最大持仓 | **仅象限字段**；`trade` 象限必填 |
| 新建回测表单 | **删除**全局仓位两项；去掉「象限覆盖 capital」提示 |
| 单笔资金 | 见 [02-sizing-algorithm.md](./02-sizing-algorithm.md) |
| 跨 regime | 方案 A：开仓用当日象限 `r/maxN` + 开仓停开（不强制平仓）；出场仍用开仓时 exit（见 [02](./02-sizing-algorithm.md#regime-switch)） |
| 日常 / 0AMV | 一期不产品化；无 active 保持空态 / API 409 |
| trailing_lock UI | 分层暴露全部参数 +「？」说明（见 [04](./04-trailing-lock-params-ui.md)） |

## 非目标（一期）

- 「从回测设为日常生效」/ activate UI  
- 从历史回测复制规则（YAGNI，可二期）  
- 改 `trailing_lock` 引擎语义（仅暴露已有参数）  
- 删除 `regime_strategy_config` 表（可保留供脚本 / 兼容）

## 现状锚点（实现时对照）

- 回测引擎 fallback：`entry?.positionRatio ?? capital.positionRatio`（将废弃产品层 capital 仓位）  
- 配置页：`/regime-config`；回测页：`/regime-backtest`  
- `runDaily` 强依赖 `status=active` 配置；前端无 runDaily 按钮  
- 仓位计算：`computeAlloc` + `regime-backtest.engine.ts`
