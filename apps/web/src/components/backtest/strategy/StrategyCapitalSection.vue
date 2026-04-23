<template>
  <div class="section-card">
    <div class="section-title">资金与仓位</div>
    <n-form-item label="初始资金">
      <n-input-number v-model:value="params.initialCapital" :min="1000" :step="10000" style="width:100%" />
    </n-form-item>

    <n-form-item label="仓位比例">
      <n-slider v-model:value="params.positionRatio" :min="0.01" :max="1" :step="0.0001" />
      <div class="param-edit">
        <input class="param-input" v-model="positionPctDisplay" @change="commitPosition" @keydown.enter="blurInput" />
        <span class="param-suffix">%</span>
      </div>
    </n-form-item>

    <n-form-item label="最大持仓">
      <n-input-number v-model:value="params.maxPositions" :min="1" :max="20" />
    </n-form-item>

    <n-form-item>
      <template #label>
        <LabelWithTip label="仅全部盈利时开新仓">
          开启后：当前所有持仓的止损价须已上移至成本之上（止损价 &gt; 入场价），才允许开新仓；空仓不受限
        </LabelWithTip>
      </template>
      <n-switch v-model:value="params.requireAllPositionsProfitable" />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { NFormItem, NInputNumber, NSlider, NSwitch } from 'naive-ui'
import type { StrategyParams } from '../../../composables/backtest/useStrategyForm'
import { useEditableNumber } from '../../../composables/useEditableNumber'
import './strategy-section.css'
import LabelWithTip from './LabelWithTip.vue'

const params = defineModel<StrategyParams>('params', { required: true })

const { display: positionPctDisplay, commit: commitPosition } = useEditableNumber(
  () => params.value.positionRatio,
  (v) => { params.value.positionRatio = v },
  { min: 0.01, max: 1, decimals: 2, scale: 100 }
)

const blurInput = (e: KeyboardEvent) => {
  (e.target as HTMLInputElement).blur()
}
</script>

<style scoped>
.param-edit {
  display: inline-flex;
  align-items: center;
  margin-left: 12px;
  gap: 2px;
}
.param-input {
  width: 64px;
  text-align: right;
  background: transparent;
  color: var(--ember-text-secondary, var(--color-text-muted));
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 14px;
  padding: 2px 4px;
  outline: none;
  font-family: inherit;
  transition: border-color 150ms ease, box-shadow 150ms ease, color 150ms ease;
}
.param-input:hover {
  border-color: var(--ember-border, var(--color-border));
}
.param-input:focus {
  border-color: var(--ember-primary, var(--color-primary));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ember-primary, var(--color-primary)) 12%, transparent);
  color: var(--ember-text, var(--color-text));
}
.param-suffix {
  color: var(--ember-text-secondary, var(--color-text-muted));
  font-size: 14px;
}
</style>
