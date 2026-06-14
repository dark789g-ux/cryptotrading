<template>
  <div>
    <div class="cap__hint">
      资金与仓位仅在启用迷你回测层时生效（在「风控与回测」tab 开启）。
    </div>

    <n-form-item label="初始资金（NAV_ref）">
      <n-input-number
        :value="model.btInitialCapital"
        :min="1"
        :step="100000"
        :precision="0"
        :disabled="disabled"
        style="width: 220px"
        @update:value="(v: number | null) => patch({ btInitialCapital: v ?? 1 })"
      />
    </n-form-item>

    <n-form-item>
      <template #label>
        <label-with-tip label="单票权重 positionRatio" :max-width="300">
          单笔下注占 NAV_ref 的比例，范围 (0,1]。固定模式下每笔 = positionRatio × NAV_ref。
        </label-with-tip>
      </template>
      <n-input-number
        :value="model.btPositionRatio"
        :min="0.0001"
        :max="1"
        :step="0.01"
        :precision="4"
        :disabled="disabled"
        style="width: 220px"
        @update:value="(v: number | null) => patch({ btPositionRatio: clampRatio(v) })"
      />
    </n-form-item>

    <n-form-item>
      <template #label>
        <label-with-tip label="最大同时在仓数 maxPositions" :max-width="300">
          最多同时持有标的数；留空 = 不限。
        </label-with-tip>
      </template>
      <n-input-number
        :value="model.btMaxPositions"
        :min="1"
        :precision="0"
        clearable
        placeholder="留空不限"
        :disabled="disabled"
        style="width: 220px"
        @update:value="(v: number | null) => patch({ btMaxPositions: v })"
      />
    </n-form-item>

    <n-form-item>
      <template #label>
        <label-with-tip label="总敞口上限 exposureCap" :max-width="300">
          总持仓市值占 NAV_ref 的上限，范围 (0,1]；留空 = 不限。
        </label-with-tip>
      </template>
      <n-input-number
        :value="model.btExposureCap"
        :min="0.0001"
        :max="1"
        :step="0.05"
        :precision="4"
        clearable
        placeholder="留空不限"
        :disabled="disabled"
        style="width: 220px"
        @update:value="(v: number | null) => patch({ btExposureCap: v })"
      />
    </n-form-item>

    <n-divider>动态仓位</n-divider>
    <SizingFields
      :model="model.btSizing"
      :disabled="disabled"
      @update="(p) => patch({ btSizing: { ...model.btSizing, ...p } })"
    />
  </div>
</template>

<script setup lang="ts">
import { NFormItem, NInputNumber, NDivider } from 'naive-ui'
import SizingFields from '../../portfolio-sim/SizingFields.vue'
import LabelWithTip from '../../backtest/strategy/LabelWithTip.vue'
import type { SignalTestFormModel } from '../../../composables/strategy/useSignalTestForm'

const props = defineProps<{
  model: SignalTestFormModel
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<SignalTestFormModel>): void
}>()

function patch(p: Partial<SignalTestFormModel>) {
  emit('update', p)
}

/** positionRatio ∈ (0,1]，越界回落到当前值。 */
function clampRatio(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return props.model.btPositionRatio
  if (v <= 0) return 0.0001
  if (v > 1) return 1
  return v
}
</script>

<style scoped>
.cap__hint {
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}
</style>
