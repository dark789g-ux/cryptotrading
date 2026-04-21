# 方案：添加止损类型「信号K线中点价」

## 需求来源
@StrategyModal.vue (133-135) 添加新的止损类型：信号K线的 (OPEN + CLOSE) / 2，并支持调节因子。

## 新增选项

| 字段 | 值 |
|------|-----|
| `value` | `'signal_midpoint'` |
| `label` | `'信号K线中点价'` |

## 止损价计算公式

```
stopLoss = (signalBar.open + signalBar.close) / 2 * stopLossFactor
```

- **signalBar**：触发买入信号的 K 线（通过 `idxMap.get(sigTs)` 定位）。
- **stopLossFactor**：复用现有「止损因子」参数（默认 1.0，范围 0.5 ~ 2）。
  - `= 1` 时止损价就是信号 K 线中点价本身。
  - `< 1` 时止损价在中点价下方（更宽松）。
  - `> 1` 时止损价在中点价上方（更紧）。

## 涉及文件与具体改动

### 1. `apps/web/src/components/backtest/StrategyModal.vue`

#### a) `stopLossModeOptions` 添加选项（第 279-282 行）
```ts
const stopLossModeOptions = [
  { label: '阶段低点 × 因子（默认）', value: 'atr' },
  { label: '固定百分比', value: 'fixed' },
  { label: '信号K线中点价', value: 'signal_midpoint' },
]
```

#### b) 「止损因子」表单项扩展显示条件（第 146 行）
将 `v-if="formData.params.stopLossMode === 'atr'"` 改为：
```vue
<n-form-item v-if="formData.params.stopLossMode === 'atr' || formData.params.stopLossMode === 'signal_midpoint'">
```

#### c) 「止损因子」Label 文案适配（第 148-151 行）
由于该因子现在同时服务于两种模式，标签文案需泛化或动态化：
- 方案 A（泛化）：`止损价 = 基准价 × 止损因子。= 1 时贴近基准价；< 1 时更宽松；> 1 时更紧`
- 方案 B（动态）：根据当前选中的 `stopLossMode` 显示对应说明。

**建议采用方案 A**，保持简洁。

---

### 2. `apps/web/src/composables/backtest/useStrategyForm.ts`

#### a) `StrategyParams` 类型扩展（第 24 行）
```ts
stopLossMode: 'atr' | 'fixed' | 'signal_midpoint'
```

#### b) 无需新增字段
复用现有 `stopLossFactor`，不新增配置项。

---

### 3. `apps/server/src/backtest/engine/models.ts`

#### a) `BacktestConfig` 类型扩展（第 138 行）
```ts
stopLossMode: 'atr' | 'fixed' | 'signal_midpoint';
```

#### b) 校验白名单扩展（第 259 行）
```ts
if (!['atr', 'fixed', 'signal_midpoint'].includes(config.stopLossMode))
  errs.push('stopLossMode 必须是 atr、fixed 或 signal_midpoint');
```

---

### 4. `apps/server/src/backtest/engine/steps/engine.pending-execution.ts`

#### a) 止损价计算逻辑扩展（第 53-55 行）
```ts
let stopP: number;
if (config.stopLossMode === 'fixed') {
  stopP = openPrice * (1 - config.fixedStopLossPct / 100);
} else if (config.stopLossMode === 'signal_midpoint') {
  const sigIdx = idxMap.get(sigTs);
  const signalBar = sigIdx !== undefined ? df[sigIdx] : null;
  const midPrice = signalBar ? (signalBar.open + signalBar.close) / 2 : openPrice;
  stopP = midPrice * config.stopLossFactor;
} else {
  stopP = recLow * config.stopLossFactor;
}
```

#### b) 修复 `initStopLossPct` 计算（第 57 行）
现有代码固定基于 `recLow`，在新类型下会显示错误的"初次止损幅度"。改为基于实际 `stopP`：
```ts
const initStopLossPct = openPrice > 0 ? ((openPrice - stopP) / openPrice) * 100 : 0;
```

#### c) `entryReason` 追加信息（第 59-63 行）
在 `signal_midpoint` 模式下，追加信号 K 线中点价信息，例如：
```ts
const entryReason =
  `盈亏比 ${rrRatio.toFixed(2)}\n` +
  (config.stopLossMode === 'signal_midpoint'
    ? `信号K线中点价 ${midPrice.toPrecision(6)} (因子 ${config.stopLossFactor})\n`
    : `阶段高点 ${recHighTime} ${recHigh.toPrecision(6)}\n阶段低点 ${recLowTime} ${recLow.toPrecision(6)}\n`) +
  `初次止损幅度 ${initStopLossPct.toFixed(2)}%`;
```

> 注：`midPrice` 需在 `signal_midpoint` 分支内提前声明并提升作用域，以便 `entryReason` 使用。

---

## 验收要点

1. 前端下拉框出现「信号K线中点价」选项。
2. 选中后「止损因子」滑块/input 正确显示，且可正常调节。
3. 后端校验通过，回测可正常执行。
4. 回测日志中 `entryReason` 正确显示信号 K 线中点价及实际止损幅度。
5. 类型检查无新增报错（`pnpm exec vue-tsc --noEmit` + `pnpm exec tsc --noEmit`）。
