<template>
  <div class="section-card">
    <div class="section-title">止损策略</div>
    <n-form-item label="止损类型">
      <n-select v-model:value="params.stopLossMode" :options="stopLossModeOptions" />
    </n-form-item>

    <n-form-item v-if="params.stopLossMode === 'fixed'">
      <template #label>
        <LabelWithTip label="固定止损%">
          止损价 = 入场价 × (1 - 该%)，与阶段低点无关
        </LabelWithTip>
      </template>
      <n-input-number v-model:value="params.fixedStopLossPct" :min="0.1" :max="50" :step="0.5" style="width:100%" />
    </n-form-item>

    <n-form-item v-if="params.stopLossMode === 'atr' || params.stopLossMode === 'signal_midpoint'">
      <template #label>
        <LabelWithTip label="止损因子" placement="top" :max-width="280">
          止损价 = 基准价 × 止损因子。<br/>
          = 1 时贴近基准价；&lt; 1 时更宽松；&gt; 1 时更紧
        </LabelWithTip>
      </template>
      <n-slider v-model:value="params.stopLossFactor" :min="0.5" :max="2" :step="0.0001" />
      <div class="param-edit">
        <input class="param-input" v-model="stopLossDisplay" @change="commitStopLoss" @keydown.enter="blurInput" />
      </div>
    </n-form-item>

    <div class="sub-section-title">止损上调规则</div>

    <n-form-item>
      <template #label>
        <LabelWithTip label="阶段止盈后上调止损">
          触发阶段止盈后，是否以及如何上调剩余仓位的止损价
        </LabelWithTip>
      </template>
      <div class="adjust-row">
        <n-switch v-model:value="params.enableProfitStopAdjust" />
        <n-select
          v-if="params.enableProfitStopAdjust"
          v-model:value="params.profitStopAdjustTo"
          :options="[{ label: '中点价', value: 'midpoint' }, { label: '保本价', value: 'breakeven' }]"
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
        <n-switch v-model:value="params.enableMa5StopAdjust" />
        <n-select
          v-if="params.enableMa5StopAdjust"
          v-model:value="params.ma5StopAdjustTo"
          :options="[{ label: '中点价', value: 'midpoint' }, { label: '保本价', value: 'breakeven' }]"
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
      <n-switch v-model:value="params.enableLadderStopLoss" />
    </n-form-item>

    <ExitManagementSection v-model:params="params" />
  </div>

  <div class="section-card">
    <div class="section-title">出场策略</div>
    <n-form-item label="MA5 破线出场">
      <span class="exit-strategy-desc">
        始终启用：持仓期间收盘价曾站上 MA5 后，若出现收盘价 &lt; MA5 且 MA5 ≤ 前根 MA5，则全仓出场
      </span>
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { NFormItem, NSelect, NInputNumber, NSlider, NSwitch } from 'naive-ui'
import LabelWithTip from './LabelWithTip.vue'
import ExitManagementSection from './ExitManagementSection.vue'
import { useEditableNumber } from '../../../composables/useEditableNumber'

const params = defineModel<any>('params', { required: true })

const stopLossModeOptions = [
  { label: '阶段低点 × 因子（默认）', value: 'atr' },
  { label: '固定百分比', value: 'fixed' },
  { label: '信号K线中点价', value: 'signal_midpoint' },
]

const { display: stopLossDisplay, commit: commitStopLoss } = useEditableNumber(
  () => params.value.stopLossFactor,
  (v) => { params.value.stopLossFactor = v },
  { min: 0.5, max: 2, decimals: 4 }
)

const blurInput = (e: KeyboardEvent) => {
  (e.target as HTMLInputElement).blur()
}
</script>

<style scoped>
.section-card {
  background: var(--ember-surface, var(--color-surface));
  border: 1px solid var(--ember-border, var(--color-border));
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 16px;
}
.section-title {
  font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--ember-text, var(--color-text));
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ember-border, var(--color-border));
}
.sub-section-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--ember-text-secondary, var(--color-text-muted));
  margin: 8px 0 12px;
  padding-left: 8px;
  border-left: 2px solid var(--ember-primary, var(--color-primary));
}
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
  box-shadow: 0 0 0 2px rgba(240, 185, 11, 0.12);
  color: var(--ember-text, var(--color-text));
}
.exit-strategy-desc {
  font-size: 13px;
  color: var(--ember-neutral, var(--color-text-muted));
  line-height: 1.6;
}
.adjust-row {
  display: flex;
  align-items: center;
}
</style>