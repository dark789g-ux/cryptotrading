<template>
  <div class="sizing">
    <div class="sizing__row">
      <span class="sizing__label">仓位模式 sizing</span>
      <n-select
        :value="model.mode"
        :options="modeOptions"
        size="small"
        :disabled="disabled"
        style="width: 220px"
        @update:value="(v: SizingMode) => patch({ mode: v })"
      />
    </div>

    <!-- signal_weighted：floorMult / capMult -->
    <div v-if="model.mode === 'signal_weighted'" class="sizing__cond">
      <div class="sizing__field">
        <span class="sizing__sub">最差信号乘子 floorMult（&gt;0）</span>
        <n-input-number
          :value="model.floorMult"
          :min="0.0001"
          :step="0.1"
          size="small"
          :disabled="disabled"
          style="width: 140px"
          @update:value="(v: number | null) => patch({ floorMult: v ?? 0.0001 })"
        />
      </div>
      <div class="sizing__field">
        <span class="sizing__sub">最优信号乘子 capMult（≥floor）</span>
        <n-input-number
          :value="model.capMult"
          :min="model.floorMult"
          :step="0.1"
          size="small"
          :disabled="disabled"
          style="width: 140px"
          @update:value="(v: number | null) => patch({ capMult: v ?? model.floorMult })"
        />
      </div>
    </div>

    <!-- source_kelly：kellyFraction / kellyMaxMult -->
    <div v-else-if="model.mode === 'source_kelly'" class="sizing__cond">
      <div class="sizing__field">
        <span class="sizing__sub">凯利系数 kellyFraction（0,1]</span>
        <n-input-number
          :value="model.kellyFraction"
          :min="0.0001"
          :max="1"
          :step="0.05"
          size="small"
          :disabled="disabled"
          style="width: 140px"
          @update:value="(v: number | null) => patch({ kellyFraction: clamp01(v) })"
        />
      </div>
      <div class="sizing__field">
        <span class="sizing__sub">乘子上限 kellyMaxMult（&gt;0）</span>
        <n-input-number
          :value="model.kellyMaxMult"
          :min="0.0001"
          :step="0.1"
          size="small"
          :disabled="disabled"
          style="width: 140px"
          @update:value="(v: number | null) => patch({ kellyMaxMult: v ?? 0.0001 })"
        />
      </div>
    </div>

    <div v-else class="sizing__hint">固定模式：每笔下注 = positionRatio × NAV_ref，不读其余字段。</div>
  </div>
</template>

<script setup lang="ts">
import { NInputNumber, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import type { SizingConfig } from '../../api/modules/strategy/portfolioSim'
import { SIZING_MODE_OPTIONS } from './portfolioSimPresets'

type SizingMode = SizingConfig['mode']

const props = defineProps<{
  model: SizingConfig
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<SizingConfig>): void
}>()

const modeOptions: SelectOption[] = SIZING_MODE_OPTIONS.map((o) => ({
  label: o.label,
  value: o.value,
}))

function patch(p: Partial<SizingConfig>) {
  emit('update', p)
}

/** kellyFraction ∈ (0,1]，null/越界回落到合法值。 */
function clamp01(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return props.model.kellyFraction
  if (v <= 0) return 0.0001
  if (v > 1) return 1
  return v
}
</script>

<style scoped>
.sizing {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--color-border, #e0e0e6);
  border-radius: 6px;
}

.sizing__row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sizing__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, #888);
}

.sizing__cond {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.sizing__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sizing__sub {
  font-size: 11px;
  color: var(--color-text-muted, #aaa);
}

.sizing__hint {
  font-size: 11px;
  color: var(--color-text-muted, #aaa);
}
</style>
