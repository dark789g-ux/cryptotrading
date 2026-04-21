# 方案：止损线调整参数化

## 需求来源

`StrategyModal.vue` 131-157（止损策略区域）目前只控制了**初始止损价怎么算**（阶段低点/固定百分比/信号中点价），但持仓期间的**止损上调逻辑**全部是硬编码的：

- 阶段止盈后 → 止损强制移到 `(入场价 + 最高收盘价) / 2`
- MA5 首次上升后 → 止损强制移到 `(入场价 + 最高收盘价) / 2`

用户无法自定义：
1. **什么时候**上调止损（是否在某个时机上调）
2. **怎么调整**（调到中点价还是保本价）

## 现有相关参数梳理

| 参数 | 作用时机 | 当前状态 |
|------|----------|----------|
| `stopLossMode` / `stopLossFactor` | 开仓时 | 已参数化 ✅ |
| `enablePartialProfit` / `partialProfitRatio` | 盘中触及阶段高点 | 已参数化 ✅ |
| `enableTrailingStop` / `trailingDrawdownPct` | 每日收盘后 | 已参数化 ✅ |
| `enableBreakevenStop` / `breakevenTriggerR` | 每日收盘后 | 已参数化 ✅ |
| 阶段止盈后的止损上调 | 阶段止盈减仓后 | **硬编码** ❌ |
| MA5 上升后的止损上调 | MA5 由平/跌转升时 | **硬编码** ❌ |

## 新增参数设计

在 `StrategyModal.vue` 131-157 区域新增以下参数：

### 1. 阶段止盈后的止损上调

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableProfitStopAdjust` | `boolean` | `true` | 阶段止盈后是否上调止损（兼容现有行为） |
| `profitStopAdjustTo` | `'midpoint' \| 'breakeven'` | `'midpoint'` | 上调目标：`midpoint` = (入场价 + 最高收盘价) / 2；`breakeven` = 入场价 |

### 2. MA5 上升后的止损上调

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableMa5StopAdjust` | `boolean` | `true` | MA5 首次上升后是否上调止损（兼容现有行为） |
| `ma5StopAdjustTo` | `'midpoint' \| 'breakeven'` | `'midpoint'` | 上调目标，同上 |

### 3. 阶梯追踪止损

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enableLadderStopLoss` | `boolean` | `false` | 是否启用阶梯追踪止损 |

开启后，持仓期间按以下规则链动态上调止损价：

| 规则 | 触发条件 | 调整方式 |
|------|----------|----------|
| ① | 首次出现 **收盘价** 高于入场价 | 止损上移至 **入场价**（保本） |
| ② | 首次出现 **最低价** 高于入场价 | 止损上移至 **最低价**（保本） |
| ③ | 保本后，后续每根 K 线的 **最低价** 高于当前止损线 | 止损上移至该 K 线的 **最低价** |
| ④ | 止损线首次高于 **信号 K 线最高价** | 后续不再抬高止损线（封顶冻结） |

> **规则说明**：
> - 规则② 比规则① 更敏感（最低价高于入场价意味着整根 K 线都在成本之上），实际执行时先检查规则②、再检查规则①；两者互斥，只触发一次保本。
> - 规则③ 在保本后生效，以每根 K 线的最低价为新止损，实现"随低点不断抬升"的追踪效果。
> - 规则④ 的"信号 K 线"指触发买入信号的那根 K 线（与 `signal_midpoint` 止损模式中的概念一致）。封顶后止损线不再随规则③ 上移，但已有的硬止损、移动止损、保本止损等逻辑仍正常生效。

## 计算公式

统一上调规则：**仅上移、不下移**。

```
if (target === 'midpoint') {
  newStop = max(stopPrice, (entryPrice + maxClose) / 2)
} else if (target === 'breakeven') {
  newStop = max(stopPrice, entryPrice)
}
```

## 与现有参数的关系

- `enableTrailingStop` / `trailingDrawdownPct`：**保持独立**，每日收盘后根据 `maxClose` 执行移动止损。
- `enableBreakevenStop` / `breakevenTriggerR`：**保持独立**，每日收盘后 R 达标时执行保本止损。

## 涉及文件与改动要点

### 1. `apps/web/src/components/backtest/StrategyModal.vue`

在 `<n-divider>止损策略</n-divider>` 区域内、`stopLossFactor` 表单下方新增参数 UI：

```vue
<n-divider style="margin:8px 0">止损上调规则</n-divider>

<n-form-item>
  <template #label>
    <LabelWithTip label="阶段止盈后上调止损">
      触发阶段止盈后，是否以及如何上调剩余仓位的止损价
    </LabelWithTip>
  </template>
  <div class="adjust-row">
    <n-switch v-model:value="formData.params.enableProfitStopAdjust" />
    <n-select
      v-if="formData.params.enableProfitStopAdjust"
      v-model:value="formData.params.profitStopAdjustTo"
      :options="[
        { label: '中点价', value: 'midpoint' },
        { label: '保本价', value: 'breakeven' },
      ]"
      style="width:120px;margin-left:8px"
    />
  </div>
</n-form-item>

<n-form-item>
  <template #label>
    <LabelWithTip label="MA5 上升后上调止损">
      MA5 首次由平/跌转升后，是否以及如何上调止损价
    </LabelWithTip>
  </template>
  <div class="adjust-row">
    <n-switch v-model:value="formData.params.enableMa5StopAdjust" />
    <n-select
      v-if="formData.params.enableMa5StopAdjust"
      v-model:value="formData.params.ma5StopAdjustTo"
      :options="[
        { label: '中点价', value: 'midpoint' },
        { label: '保本价', value: 'breakeven' },
      ]"
      style="width:120px;margin-left:8px"
    />
  </div>
</n-form-item>

<n-form-item>
  <template #label>
    <LabelWithTip label="阶梯追踪止损">
      开启后按规则链动态上移止损：首次价格高于入场价即保本，随后以每根K线最低点追踪，封顶于信号K线最高价
    </LabelWithTip>
  </template>
  <n-switch v-model:value="formData.params.enableLadderStopLoss" />
</n-form-item>

```

需补充 `.adjust-row` 样式：
```css
.adjust-row { display: flex; align-items: center; }
```

### 2. `apps/web/src/composables/backtest/useStrategyForm.ts`

#### a) `StrategyParams` 接口扩展
```ts
export interface StrategyParams {
  // ... 现有字段 ...
  enableProfitStopAdjust: boolean
  profitStopAdjustTo: 'midpoint' | 'breakeven'
  enableMa5StopAdjust: boolean
  ma5StopAdjustTo: 'midpoint' | 'breakeven'
  enableLadderStopLoss: boolean
}
```

#### b) `defaultParams()` 扩展
```ts
const defaultParams = (): StrategyParams => ({
  // ... 现有字段 ...
  enableProfitStopAdjust: true,
  profitStopAdjustTo: 'midpoint',
  enableMa5StopAdjust: true,
  ma5StopAdjustTo: 'midpoint',
  enableLadderStopLoss: false,
})
```

### 3. `apps/server/src/backtest/engine/models.ts`

#### a) `BacktestConfig` 扩展
```ts
export interface BacktestConfig {
  // ... 现有字段 ...
  enableProfitStopAdjust: boolean;
  profitStopAdjustTo: 'midpoint' | 'breakeven';
  enableMa5StopAdjust: boolean;
  ma5StopAdjustTo: 'midpoint' | 'breakeven';
  enableLadderStopLoss: boolean;
}
```

#### b) `DEFAULT_CONFIG` 扩展
```ts
export const DEFAULT_CONFIG: BacktestConfig = {
  // ... 现有字段 ...
  enableProfitStopAdjust: true,
  profitStopAdjustTo: 'midpoint',
  enableMa5StopAdjust: true,
  ma5StopAdjustTo: 'midpoint',
  enableLadderStopLoss: false,
};
```

#### c) `validateConfig()` 扩展（可选，加枚举校验）
```ts
if (!['midpoint', 'breakeven'].includes(config.profitStopAdjustTo))
  errs.push('profitStopAdjustTo 必须是 midpoint 或 breakeven');
if (!['midpoint', 'breakeven'].includes(config.ma5StopAdjustTo))
  errs.push('ma5StopAdjustTo 必须是 midpoint 或 breakeven');
```

#### d) `Position` 接口与 `createPosition` 扩展

需在 `Position` 中记录阶梯追踪止损的状态及信号 K 线最高价：

```ts
export interface Position {
  // ... 现有字段 ...
  ladderBreakevenHit: boolean;
  ladderStopFrozen: boolean;
  signalBarHigh: number;
}
```

```ts
export function createPosition(...) {
  return {
    // ... 现有字段 ...
    ladderBreakevenHit: false,
    ladderStopFrozen: false,
    signalBarHigh: 0,
    ...p,
  };
}
```

### 4. `apps/server/src/backtest/engine/position-handler.ts`

#### a) 提取止损上调计算函数
```ts
function calcAdjustedStop(
  entryPrice: number,
  maxClose: number,
  currentStop: number,
  target: 'midpoint' | 'breakeven',
): number {
  let newStop: number;
  if (target === 'midpoint') {
    newStop = (entryPrice + maxClose) / 2;
  } else {
    newStop = entryPrice;
  }
  return Math.max(currentStop, newStop);
}
```

#### b) 阶段止盈后止损调节（processCandle 与 processEntryCandle 各有一处）
将现有的：
```ts
let newStop = (pos.entryPrice + pos.maxClose) / 2;
newStop = Math.max(pos.stopPrice, newStop);
```
改为：
```ts
if (config.enableProfitStopAdjust) {
  const newStop = calcAdjustedStop(
    pos.entryPrice, pos.maxClose, pos.stopPrice, config.profitStopAdjustTo,
  );
  pos.stopPrice = newStop;
  pos.stopReason = config.profitStopAdjustTo === 'breakeven'
    ? '阶段止盈后保本'
    : '阶段止盈后止损';
  if (close < newStop) {
    // ... 出场逻辑不变 ...
  }
}
```

#### c) MA5 上升后止损调节（processCandle 与 processEntryCandle 各有一处）
将现有的：
```ts
let newStop = (pos.entryPrice + pos.maxClose) / 2;
newStop = Math.max(pos.stopPrice, newStop);
```
改为条件执行：
```ts
if (config.enableMa5StopAdjust) {
  const newStop = calcAdjustedStop(
    pos.entryPrice, pos.maxClose, pos.stopPrice, config.ma5StopAdjustTo,
  );
  if (close < newStop) {
    // ... 出场逻辑 ...
  } else {
    if (newStop > pos.stopPrice) {
      pos.stopReason = config.ma5StopAdjustTo === 'breakeven'
        ? 'MA5上升后保本'
        : 'MA5首次上升止损';
    }
    pos.stopPrice = newStop;
    pos.ma5StopAdjusted = true;
  }
}
```

> 若 `enableMa5StopAdjust = false`，则 `ma5StopAdjusted` 永远不被置为 true，后续不会再进入该分支（自然跳过）。

#### d) 阶梯追踪止损（`processCandle` 与 `processEntryCandle` 各有一处）

在收盘处理阶段，于「MA5 上升后止损调节」之后、「分批止盈」之前插入：

```ts
// ⑤' 阶梯追踪止损
if (config.enableLadderStopLoss && !pos.ladderStopFrozen) {
  // 规则①②：首次价格高于入场价时保本
  if (!pos.ladderBreakevenHit) {
    if (low > pos.entryPrice) {
      // 规则②：整根 K 线都在成本之上（更敏感），止损直接上移至该 K 线最低价
      const newStop = Math.max(pos.stopPrice, low);
      if (newStop > pos.stopPrice) {
        pos.stopPrice = newStop;
        pos.stopReason = '阶梯止损-保本';
      }
      pos.ladderBreakevenHit = true;
    } else if (close > pos.entryPrice) {
      // 规则①：收盘确认回本（有下影线跌破过成本）
      const newStop = Math.max(pos.stopPrice, pos.entryPrice);
      if (newStop > pos.stopPrice) {
        pos.stopPrice = newStop;
        pos.stopReason = '阶梯止损-保本';
      }
      pos.ladderBreakevenHit = true;
    }
  }

  // 规则③：保本后，以每根 K 线最低点上移止损
  if (pos.ladderBreakevenHit && low > pos.stopPrice) {
    pos.stopPrice = low;
    pos.stopReason = '阶梯止损-追踪';
  }

  // 规则④：封顶检查——止损线首次高于信号 K 线最高价后冻结
  if (pos.stopPrice > pos.signalBarHigh) {
    pos.ladderStopFrozen = true;
    pos.stopReason = '阶梯止损-封顶';
  }
}
```

> **注意**：`low` 为当前 K 线最低价，`close` 为当前 K 线收盘价。由于前面的硬止损检查已确保 `low > pos.stopPrice_initial`（未触发硬止损），但止损可能已被前序逻辑（如阶段止盈后上调）抬高，因此 `low > pos.stopPrice` 在规则③ 中并非恒成立，需正常判断。

### 5. `apps/server/src/backtest/engine/steps/engine.pending-execution.ts`

开仓时需记录信号 K 线的最高价，供规则④ 封顶使用：

```ts
// 在 stopP 计算之后、createPosition 之前
const sigIdx = idxMap.get(sigTs);
const signalBar = sigIdx !== undefined ? df[sigIdx] : null;
const signalBarHigh = signalBar ? signalBar.high : openPrice;

const pos = createPosition({
  // ... 现有字段 ...
  signalBarHigh,
});
```

> 对于 `signal_midpoint` 模式，`sigIdx` 与 `signalBar` 已在该文件中存在，可直接复用；对于 `atr` / `fixed` 模式，需额外查一次 `idxMap.get(sigTs)`。

## 兼容性说明

- `enableProfitStopAdjust` 与 `enableMa5StopAdjust` 默认 `true`，保持现有回测行为不变。
- `profitStopAdjustTo` 与 `ma5StopAdjustTo` 默认 `'midpoint'`，与现有公式一致。
- `enableLadderStopLoss` 默认 `false`，不引入新行为。
- 老策略数据未包含新字段时，回退到 `DEFAULT_CONFIG` 的默认值。

## 验收要点

1. 前端「止损策略」区域出现新的「止损上调规则」子区块。
2. 关闭「阶段止盈后上调止损」开关后，阶段止盈不再上调止损价。
3. 将「阶段止盈后上调止损」设为「保本价」后，阶段止盈后止损价 = 入场价。
4. 关闭「MA5 上升后上调止损」开关后，MA5 上升不再上调止损价。
5. 开启「阶梯追踪止损」后：
   - 首次收盘价高于入场价时，止损价自动上移至入场价；
   - 保本后，后续每根 K 线最低价高于止损线时，止损价上移至该最低价；
   - 止损价超过信号 K 线最高价后，不再继续上调。
6. 类型检查无新增报错（`pnpm exec vue-tsc --noEmit` + `pnpm exec tsc --noEmit`）。
