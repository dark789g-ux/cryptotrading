# 05 · API、数据流与验收

## 数据流

```text
用户填写象限规则 + 资金/区间
        │
        ▼
POST /api/regime-engine/backtests
  body:
    name, startDate, endDate
    capital: { initialCapital, cost }   // 无 positionRatio / maxPositions
    config: RegimeConfigMap             // 必填：完整象限规则
    regimeConfigId?: string             // 可选：仅写 FK 溯源，不用于加载规则
        │
        ▼
写入 regime_backtest_run.config 快照 → triggerRun
        │
        ▼
engine: 每日 classify → 开仓 sizing 取当日象限 r/maxN
        → alloc = cash × r / (1 − r×n)（见 ./02-sizing-algorithm.md#formula）
        → 已持仓出场按开仓时 exit 快照模拟
```

## API 变更要点

| 项 | 变更 |
|----|------|
| 创建回测 | **必须**带完整 `config`；`regimeConfigId` 可选且**仅**写 FK 溯源，**不**用于加载规则；**不再支持**仅凭 `regimeConfigId` 创建 |
| capital | 若仍传入 `positionRatio` / `maxPositions`：**忽略并打 warn 日志，不 400** |
| 配置校验 | trade 象限：仓位必填 + `r×maxN≤1`；trailing_lock：stop/floor/开关字段校验 |
| 配置 CRUD | 一期保留；前端入口删除 |

## 引擎变更要点

- 替换 fixed 路径的 `computeAlloc(..., navRef)` 为现金切分公式（见 [02](./02-sizing-algorithm.md#formula)）  
- 删除对 `capital.positionRatio/maxPositions` 的产品依赖  
- 新增 skip：`budget_full`（`1−r×n≤0`，开仓停开，非强平）  
- 单测覆盖 02 中用例  

## 验收清单

1. 不打开配置页即可配齐规则并跑通回测  
2. UI 上仓位只出现在象限；新建表单无全局仓位字段  
3. 不同象限不同仓位；日切换后开仓按 [02 方案 A](./02-sizing-algorithm.md#regime-switch)；出场仍用开仓快照  
4. `alloc` 在现金不足场景不再系统性「按净值超买」  
5. `/regime-config` 不可达或重定向；Sidebar 无「Regime 配置」  
6. trailing_lock 五参数可配、可保存、有「？」；高级折叠与禁用地板系数符合 [04](./04-trailing-lock-params-ui.md)  
7. 详情可查看本次规则摘要（至少仓位与出场模式）  

## 实现任务切分（供后续 plan）

| 波次 | 任务 | 主要触点 |
|------|------|----------|
| W1 | 现金仓位算法 + 校验 + 单测 | `regime-backtest.engine.ts`, `sizing.ts`, validation |
| W1 | trailing_lock 表单 UI + 后端校验对齐 | `RegimeConfigEditor.vue`, validation |
| W2 | 新建回测内联编辑器 + API 必填内联 config | CreateModal, backtest service/DTO |
| W2 | 下线配置页入口 + redirect + 文案/详情摘要 | router, Sidebar, DetailDrawer |

W1 内两任务文件域基本不相交，可并行。
