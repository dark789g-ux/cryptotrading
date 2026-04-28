<template>
  <div class="param-slider">
    <div class="slider-header">
      <span class="slider-label">{{ label }}</span>
      <span class="slider-value">{{ modelValue }}<span class="slider-unit">{{ unit }}</span></span>
    </div>
    <n-slider v-model:value="localValue" :min="min" :max="max" :step="step" :tooltip="false" />
    <n-input-number v-model:value="localValue" :min="min" :max="max" :step="step" size="small" style="width:100%;margin-top:6px" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NSlider, NInputNumber } from 'naive-ui'

const props = defineProps<{
  label: string
  unit: string
  modelValue: number
  min: number
  max: number
  step: number
}>()

const emit = defineEmits<{
  'update:modelValue': [val: number]
}>()

const localValue = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})
</script>

<style scoped>
.param-slider {
  display: flex;
  flex-direction: column;
}
.slider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.slider-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.slider-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-primary);
}
.slider-unit {
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-muted);
  margin-left: 2px;
}
</style>
