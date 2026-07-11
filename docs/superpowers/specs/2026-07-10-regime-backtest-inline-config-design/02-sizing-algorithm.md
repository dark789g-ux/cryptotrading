# 02 · 仓位算法（现金切分）

## 目标

在无杠杆、不主动再平衡的前提下，使计划买入金额不超过可用现金，并支持「每笔目标占比 + 最大持仓 + 预留现金缓冲」。

## 配置约束

对每个 `action=trade` 的象限：

- `positionRatio`：必填，`(0, 1]`  
- `maxPositions`：必填，正整数  
- 校验：`positionRatio × maxPositions ≤ 1`（允许故意留现金，例如 20%×4=80%）

`flat` 象限不要求仓位字段。

## 公式 {#formula}

开仓当日（已通过出场模拟、未因其它 skip 拒绝）：

```text
r    = 今日象限.positionRatio
maxN = 今日象限.maxPositions
n    = 当前实际持仓数（全账户）
cash = 当前现金

若 n ≥ maxN           → skip: slots_full
若 1 − r×n ≤ 0        → skip: budget_full   （新规则下开仓预算已满；停开，不强制平仓）
否则:
  alloc = cash × r / (1 − r×n)
  实扣 = alloc + alloc × 买入费率
  若 cash < 实扣 或 alloc < MIN_ALLOC_YUAN（现 1 元）→ skip: cash_short / sized_out
```

同日多信号：按引擎既有顺序**逐笔**评估；每笔 `taken` 成交后立即更新 `n` 与 `cash`，再算下一笔。

### 示例（用户确认）

`maxN=4`，`r=0.2`：

| 已有仓位 n | 本笔占剩余现金 |
|------------|----------------|
| 0 | 20% |
| 1 | 25% |
| 2 | ≈33.3% |
| 3 | 50% |
| 4 | 不开 |

浮盈浮亏**不**修正「已占用权重」；只用现金与持仓个数。

## 跨 regime（方案 A）{#regime-switch}

无切换专用公式。每日**开仓 sizing** 取**当前象限**的 `r/maxN`，套用上式。  
**开仓停开**（旧称「熔断」）= 不再开新仓；**不**强制平仓、**不**改已有持仓的出场逻辑（出场仍用开仓时写入的 exit 快照）。

```text
切换到更大 r 且 n 已多 → 可能 1−r×n≤0 → 停开，等旧仓自然出场
切换到更小 r           → 按新 r 继续切现金
新 maxN < n            → slots_full，停开
```

## 与其它 sizing 模式

产品路径**仅**上述 fixed 现金切分。`anchorMode`、以及 `signal_weighted` / `source_kelly` 等非 fixed 模式：一期保持引擎旧语义且 **UI 不暴露**；新建回测不传这些字段。

## 与旧逻辑差异

| | 旧 | 新 |
|--|----|----|
| 基数 | 昨收净值 `navRef` | 当前现金 `cash` |
| capital.positionRatio | 象限 null 时兜底 | 产品层删除；引擎不再依赖 |
| capital.maxPositions | 同上 | 同上 |
| computeAlloc（fixed） | `ratio × nav` | 改为上式，或引擎内联等价实现 |

## 测试要点

- n=0..maxN−1 的 alloc 比例与上表一致  
- `r×n ≥ 1` 时不开仓  
- regime 切换后 r/maxN 变化的开仓停开与继续开仓用例  
- 费率导致 cash_short  
- 校验拒绝 `r×maxN > 1`
