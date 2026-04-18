<template>
  <n-divider>入场信号</n-divider>

  <!-- KDJ 周期 -->
  <n-form-item label="KDJ 周期">
    <div class="kdj-periods">
      <div class="period-item">
        <span class="period-label">N</span>
        <n-input-number v-model:value="p.kdjN" :min="1" :max="99" :show-button="false" style="width:64px" />
      </div>
      <div class="period-item">
        <span class="period-label">M1</span>
        <n-input-number v-model:value="p.kdjM1" :min="1" :max="99" :show-button="false" style="width:64px" />
      </div>
      <div class="period-item">
        <span class="period-label">M2</span>
        <n-input-number v-model:value="p.kdjM2" :min="1" :max="99" :show-button="false" style="width:64px" />
      </div>
    </div>
  </n-form-item>

  <n-form-item>
    <template #label>
      <span class="label-with-tip">J 超卖阈值
        <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
          J 值低于此阈值视为超卖，触发入场信号；建议设 10～20
        </n-tooltip>
      </span>
    </template>
    <n-input-number v-model:value="p.kdjJOversold" :min="-200" :max="200" style="width:100%" />
  </n-form-item>

  <!-- MA 条件 -->
  <n-form-item>
    <template #label>
      <span class="label-with-tip">MA 条件
        <n-tooltip style="max-width:260px"><template #trigger><span class="tip-icon">?</span></template>
          动态添加均线条件，所有条件 AND 连接。<br/>
          例：CLOSE &gt; MA60 AND MA30 &gt; MA60<br/>
          为空时回退到默认硬编码条件
        </n-tooltip>
      </span>
    </template>
    <n-dynamic-input
      v-model:value="p.maConditions"
      :on-create="createMaCondition"
      item-class="ma-cond-item"
    >
      <template #default="{ value }">
        <div class="ma-row">
          <n-select v-model:value="value.left" :options="maOperandOptions" style="width:96px" size="small" />
          <n-select v-model:value="value.op" :options="maOperatorOptions" style="width:72px" size="small" />
          <n-select v-model:value="value.right" :options="maOperandOptions" style="width:96px" size="small" />
        </div>
      </template>
    </n-dynamic-input>
  </n-form-item>


  <n-form-item>
    <template #label>
      <span class="label-with-tip">最大止损幅度(%)
        <n-tooltip style="max-width:260px"><template #trigger><span class="tip-icon">?</span></template>
          以阶段低点为止损点，入场后最大可接受的亏损幅度；超过该值的信号将被过滤。<br/>
          公式：(收盘价 - 阶段低点) ÷ 收盘价 × 100 ≤ N%
        </n-tooltip>
      </span>
    </template>
    <n-input-number v-model:value="p.entryMaxDistFromLowPct" :min="0.1" :max="50" :step="0.5" style="width:100%" />
  </n-form-item>

  <n-form-item>
    <template #label>
      <span class="label-with-tip">最小盈亏比
        <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
          入场前要求「(阶段高点 - 入场价) ÷ (入场价 - 止损价)」≥ 该值，否则放弃信号
        </n-tooltip>
      </span>
    </template>
    <n-input-number v-model:value="p.minRiskRewardRatio" :min="0.5" :max="20" :step="0.5" />
  </n-form-item>
</template>

<script setup lang="ts">
import {
  NDivider, NFormItem, NInputNumber, NSelect, NTooltip, NDynamicInput,
} from 'naive-ui'

export type MaOperand = 'close' | 'ma5' | 'ma30' | 'ma60' | 'ma120' | 'ma240'
export type MaOperator = '>' | '>=' | '<' | '<=' | '=' | '!='

export interface MaCondition {
  left: MaOperand
  op: MaOperator
  right: MaOperand
}

export interface EntrySignalParams {
  kdjN: number
  kdjM1: number
  kdjM2: number
  kdjJOversold: number
  maConditions: MaCondition[]
  entryMaxDistFromLowPct: number
  minRiskRewardRatio: number
}

const p = defineModel<EntrySignalParams>('params', { required: true })

const maOperandOptions = [
  { label: 'CLOSE', value: 'close' },
  { label: 'MA5',   value: 'ma5' },
  { label: 'MA30',  value: 'ma30' },
  { label: 'MA60',  value: 'ma60' },
  { label: 'MA120', value: 'ma120' },
  { label: 'MA240', value: 'ma240' },
]

const maOperatorOptions = [
  { label: '>',  value: '>' },
  { label: '>=', value: '>=' },
  { label: '<',  value: '<' },
  { label: '<=', value: '<=' },
  { label: '=',  value: '=' },
  { label: '!=', value: '!=' },
]

const createMaCondition = (): MaCondition => ({ left: 'close', op: '>', right: 'ma60' })
</script>

<style scoped>
.label-with-tip { display: inline-flex; align-items: center; gap: 4px; }
.tip-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--n-text-color-3, #888);
  font-size: 10px; color: var(--n-text-color-3, #888); cursor: help; flex-shrink: 0;
}
.kdj-periods { display: flex; gap: 12px; align-items: center; }
.period-item { display: flex; align-items: center; gap: 6px; }
.period-label { color: var(--n-text-color-3); font-size: 13px; white-space: nowrap; }
.ma-row { display: flex; align-items: center; gap: 8px; flex: 1; }
:deep(.ma-cond-item) { flex: 1; }
</style>
