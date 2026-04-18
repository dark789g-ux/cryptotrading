<template>
  <n-divider>出场管理</n-divider>

  <n-form-item>
    <template #label>
      <span class="label-with-tip">阶段止盈
        <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
          开启后，价格触及阶段高点时按指定比例减仓，止盈后自动上移止损至「(入场价+最高收盘价)/2」
        </n-tooltip>
      </span>
    </template>
    <n-switch v-model:value="p.enablePartialProfit" />
  </n-form-item>

  <n-form-item v-if="p.enablePartialProfit">
    <template #label>
      <span class="label-with-tip">阶段止盈比例
        <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
          触及阶段高点时卖出的仓位比例，剩余仓位继续持有
        </n-tooltip>
      </span>
    </template>
    <n-slider v-model:value="p.partialProfitRatio" :min="0.1" :max="0.9" :step="0.1" style="flex:1" />
    <span class="val-label">{{ (p.partialProfitRatio * 100).toFixed(0) }}%</span>
  </n-form-item>

</template>

<script setup lang="ts">
import {
  NDivider, NFormItem, NSwitch, NInputNumber, NSlider, NTooltip,
} from 'naive-ui'

export interface ExitParams {
  enablePartialProfit: boolean
  partialProfitRatio: number
}

const p = defineModel<ExitParams>('params', { required: true })
</script>

<style scoped>
.label-with-tip { display: inline-flex; align-items: center; gap: 4px; }
.tip-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--n-text-color-3, #888);
  font-size: 10px; color: var(--n-text-color-3, #888); cursor: help; flex-shrink: 0;
}
.val-label { margin-left: 10px; min-width: 36px; color: var(--n-text-color-3); font-size: 13px; }
.target-row { display: flex; align-items: center; gap: 6px; flex: 1; }
.target-label { color: var(--n-text-color-3); font-size: 13px; white-space: nowrap; }
:deep(.target-item) { flex: 1; }
</style>
