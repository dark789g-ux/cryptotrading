# 策略参数规范

> 本文档记录策略表单字段设计的讨论共识，作为后续迭代的基准。

---

## 表单分组结构

```
资金配置        initialCapital / positionRatio / maxPositions
入场信号        kdjN / kdjM1 / kdjM2 / kdjJOversold
                maConditions（动态列表）
                recentLowWindow / recentLowBuffer / entryMaxDistFromLowPct
KDJ 参数        kdjKMax / kdjDMax / kdjJMax
高点参数        recentHighWindow / recentHighBuffer
止损策略        stopLossMode / fixedStopLossPct（条件显示）
出场管理        enablePartialProfit / partialProfitRatio（条件显示）
                enableTrailingStop / trailingDrawdownPct（条件显示）
                enableBreakevenStop / breakevenTriggerR（条件显示）
                takeProfitTargets（分批止盈动态列表）
                enableTrailingProfit / trailingProfitTriggerR / trailingProfitDrawdownPct（条件显示）
风控参数        stopLossFactor / minRiskRewardRatio / cooldownHours / requireAllPositionsProfitable
回测区间        dateStart / dateEnd
```

> **变更说明**（2026-04）：原"信号参数"区块拆分：`recentLow*` 迁入"入场信号"，剩余 `recentHigh*` 重命名为"高点参数"；新增"入场信号"区块独立为 `EntrySignalSection.vue` 子组件。

---

## 字段规范

### 入场信号

入场信号独立为 `EntrySignalSection.vue` 子组件（`v-model:params`，与 `ExitManagementSection` 同模式）。

#### KDJ 周期与超卖阈值

| 字段 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `kdjN` | number | 9 | 1–99 | KDJ 计算周期 N |
| `kdjM1` | number | 3 | 1–99 | KDJ K 线平滑周期 M1 |
| `kdjM2` | number | 3 | 1–99 | KDJ D 线平滑周期 M2 |
| `kdjJOversold` | number | **10** | -200–200 | J 超卖阈值：J < 此值才触发入场信号 |

**KDJ 重算机制**：数据库预存的是 9/3/3 计算的 KDJ。当 `kdjN/M1/M2 != 9/3/3` 时，引擎在主循环前调用 `precomputeAllKdj(data, N, M1, M2)` 预计算全量 KDJ（O(n) 摊销），并通过 `precomputedKdj` 参数注入 `scanSignals`；等于 9/3/3 时直接使用行内预存值，无额外开销。

`kdjJOversold` 与既有 `kdjJMax` 并存：`kdjJMax` 是硬限制（J < kdjJMax 才通过），`kdjJOversold` 是超卖判定（J < kdjJOversold 才入场）。两者均在 signal-scanner 中 AND 检查。

#### MA 动态条件

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maConditions` | `MaCondition[]` | `[]` | MA 条件列表，所有条件 AND 连接 |

```typescript
type MaOperand = 'close' | 'ma5' | 'ma30' | 'ma60' | 'ma120' | 'ma240'
interface MaCondition { left: MaOperand; right: MaOperand }
```

- 每条条件语义：`left > right`（运算符固定为 `>`）
- 可用操作数：CLOSE、MA5、MA30、MA60、MA120、MA240（与数据库预存列对应）
- UI：`n-dynamic-input`，每行两个 `n-select` + 固定 `>` 符号
- **空列表回退**：`maConditions.length === 0` 时，signal-scanner 回退到硬编码条件 `CLOSE > MA60 AND MA30 > MA60 AND MA60 > MA120 AND CLOSE > MA240`，保证旧策略行为不变

#### 阶段低点（从原"信号参数"迁入）

阶段低点计算：先向前扫描 `recentLowWindow` 根 K 线找最低价，再向前追溯最多 `recentLowBuffer` 根 K 线——若找到更低点则更新并继续追溯，直到无更低点为止。

| 字段 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `recentLowWindow` | number | 9 | ≥1 | 初始扫描窗口 N 根 K 线 |
| `recentLowBuffer` | number | 50 | ≥0 | 追溯缓冲上限 Y 根 K 线 |
| `entryMaxDistFromLowPct` | number | 5 | 0.1–50 | 入场价高出阶段低点的百分比上限 |

**`entryMaxDistFromLowPct` 与 `maxInitLoss` 的关系**：
- `entryMaxDistFromLowPct > 0`：signal-scanner 使用 `entryMaxDistFromLowPct / 100` 作为距低点限制
- `entryMaxDistFromLowPct = 0`（旧策略默认值）：回退 `config.maxInitLoss`（固定 1%），保证旧策略行为不变
- `maxStopLossPct` 提案被否决：与 `entryMaxDistFromLowPct` 高度重叠（止损设在低点时两者近似相等），只保留后者

---

### 高点参数（原"信号参数"拆分后剩余）

阶段高低点使用**独立**的 window 和 buffer 参数，互不干扰。

| 字段 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `recentHighWindow` | number | 9 | ≥1 | 计算阶段高点时，向前取最近 N 根 K 线的最高价作为初始候选，影响止盈目标价 |
| `recentHighBuffer` | number | 50 | ≥0 | 在窗口之外继续向前追溯，找更高的连续高点 |

**引擎实现**：`calcRecentLow(df, idx, window, buffer)` / `calcRecentHigh(df, idx, window, buffer)`，`RECENT_WINDOW` 常量已废弃。

---

### 止损策略

**定义**：入场时立即生效的止损方式，不含持仓期间的动态调整逻辑（动态调整归入出场管理）。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `stopLossMode` | `'atr' \| 'fixed'` | `'atr'` | `atr`：止损价 = 阶段低点 × stopLossFactor；`fixed`：止损价 = 入场价 × (1 - fixedStopLossPct%) |
| `fixedStopLossPct` | number(%) | 2 | 仅 `fixed` 模式生效，UI 条件显示 |

---

### 出场管理

**定义**：持仓期间所有退出逻辑的统一分组，包含止损动态调整和多种止盈机制。移动止损/保本止损属于「止损动态调整」，不归入「止损策略」（止损策略仅管入场时的初始止损）。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enablePartialProfit` | boolean | false | 开启后，价格触及阶段高点时按 `partialProfitRatio` 减仓 |
| `partialProfitRatio` | number(0–1) | 0.5 | 阶段止盈卖出比例；条件显示（enablePartialProfit=true） |
| `enableTrailingStop` | boolean | false | 移动止损：收盘新高后，止损上移至「最高收盘价 × (1 - trailingDrawdownPct%)」 |
| `trailingDrawdownPct` | number(%) | 3 | 移动止损回撤幅度；条件显示 |
| `enableBreakevenStop` | boolean | false | 保本止损：收盘 R ≥ breakevenTriggerR 时将止损上移至入场价 |
| `breakevenTriggerR` | number | 1.0 | 保本触发盈亏比 R；条件显示 |
| `takeProfitTargets` | `{rrRatio, sellRatio}[]` | [] | 分批止盈档位列表（动态列表），按 rrRatio 升序；收盘 R ≥ rrRatio 时按 sellRatio 卖出 |
| `enableTrailingProfit` | boolean | false | 移动止盈：收盘 R ≥ trailingProfitTriggerR 时激活，追踪最高收盘价，回撤超阈值全平 |
| `trailingProfitTriggerR` | number | 2.0 | 移动止盈激活 R；条件显示 |
| `trailingProfitDrawdownPct` | number(%) | 5 | 移动止盈回撤阈值；条件显示 |

**引擎执行顺序（收盘后）**：
1. 阶段止盈后止损调节（原有逻辑）
2. MA5 收盘规则（原有逻辑）
3. 分批止盈（新）
4. 移动止盈（新）
5. 更新止损价：移动止损 → 保本止损（新）

---

### 风控参数（含 Tooltip 规范）

| 字段 | Tooltip 文案 |
|---|---|
| `stopLossFactor` | 止损价 = 基准参考价 × 止损因子（基准价由止损类型决定）。= 1 时止损贴近基准；< 1 时在基准下方（更宽松）；> 1 时在基准上方（更紧） |
| `minRiskRewardRatio` | 入场前要求「(阶段高点 - 入场价) ÷ (入场价 - 止损价)」≥ 该值，否则放弃信号 |
| `cooldownHours` | 标的止损出场后，在该时长内禁止再次开仓，避免反复打脸 |
| `requireAllPositionsProfitable` | 开启后：当前所有持仓的止损价须已上移至成本之上（止损价 > 入场价），才允许开新仓；空仓不受限 |

**Tooltip 设计原则**：止损因子的说明不绑定具体止损方式（「阶段低点」只是 atr 模式下的一种基准），描述保持泛用，公式中的「基准参考价」由 `stopLossMode` 决定。

---

## UI 规范

- Tooltip 触发元素：圆形 `?` 文字图标，14×14px，border-radius 50%，cursor: help
- 条件显示字段使用 `v-if` 联动，无需用户折叠/展开
- 出场管理独立为 `ExitManagementSection.vue` 子组件（避免 StrategyModal.vue 超 500 行）
- 分批止盈使用 `n-dynamic-input`，每行格式：「达到 [R倍] R 卖出 [比例] 仓」

---

## 向前兼容性

- 旧策略 `params` JSON 缺少新字段时，后端通过 `DEFAULT_CONFIG` 默认值兜底
- 所有新开关默认 `false`，`stopLossMode` 默认 `'atr'`（当前行为），不影响历史回测结果
- `lookbackBuffer` 字段在 `BacktestConfig` 中保留（linter 未移除），实际由 `recentLowBuffer` / `recentHighBuffer` 替代；后续可在确认无历史依赖后删除
