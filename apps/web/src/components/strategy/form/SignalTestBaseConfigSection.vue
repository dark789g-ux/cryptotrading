<template>
  <div>
    <template v-if="model.exitMode === 'phase_lock'">
      <n-form-item>
        <template #label>
          <label-with-tip label="初始止损回看根数" :max-width="320">
            初始止损取「含 T+1 的最近 N 个非停牌交易日」最低点。留空走默认 10；正整数，范围 [1,250]。
          </label-with-tip>
        </template>
        <n-input-number
          :value="model.lookback"
          :min="1"
          :max="250"
          :precision="0"
          placeholder="10"
          style="width: 200px"
          @update:value="(v: number | null) => patch({ lookback: v })"
        />
      </n-form-item>
    </template>
    <template v-else>
      <div class="base-config__placeholder">当前出场模式无窗口参数（仅两阶段锁定止损用初始止损回看窗口）。</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { NFormItem, NInputNumber } from 'naive-ui'
import LabelWithTip from '../../backtest/strategy/LabelWithTip.vue'
import type { SignalTestFormModel } from '../../../composables/strategy/useSignalTestForm'

defineProps<{
  model: SignalTestFormModel
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<SignalTestFormModel>): void
}>()

function patch(p: Partial<SignalTestFormModel>) {
  emit('update', p)
}
</script>

<style scoped>
.base-config__placeholder {
  padding: 16px 12px;
  font-size: 13px;
  color: var(--color-text-muted, #aaa);
}
</style>
