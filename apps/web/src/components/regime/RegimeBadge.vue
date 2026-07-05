<template>
  <span class="regime-badge" :class="badgeClass">{{ displayLabel }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  label: string
  colorIndex?: number
}

const props = withDefaults(defineProps<Props>(), {
  colorIndex: 0,
})

const displayLabel = computed(() => props.label || '未知')
const badgeClass = computed(() => {
  if (!props.label || props.label === 'unknown' || props.label === '未知') {
    return 'regime-badge--unknown'
  }
  return `regime-badge--${props.colorIndex % 6}`
})
</script>

<style scoped>
.regime-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.regime-badge--unknown {
  background: color-mix(in srgb, var(--color-text-muted) 18%, transparent);
  color: var(--color-text-muted);
  border: 1px solid color-mix(in srgb, var(--color-text-muted) 40%, transparent);
}

.regime-badge--0 {
  background: color-mix(in srgb, var(--color-success) 18%, transparent);
  color: var(--color-success);
  border: 1px solid color-mix(in srgb, var(--color-success) 40%, transparent);
}

.regime-badge--1 {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  color: var(--color-primary);
  border: 1px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}

.regime-badge--2 {
  background: color-mix(in srgb, var(--color-focus-blue) 18%, transparent);
  color: var(--color-focus-blue);
  border: 1px solid color-mix(in srgb, var(--color-focus-blue) 40%, transparent);
}

.regime-badge--3 {
  background: color-mix(in srgb, var(--color-error) 18%, transparent);
  color: var(--color-error);
  border: 1px solid color-mix(in srgb, var(--color-error) 40%, transparent);
}

.regime-badge--4 {
  background: color-mix(in srgb, var(--color-warning) 18%, transparent);
  color: var(--color-warning);
  border: 1px solid color-mix(in srgb, var(--color-warning) 40%, transparent);
}

.regime-badge--5 {
  background: color-mix(in srgb, var(--color-info) 18%, transparent);
  color: var(--color-info);
  border: 1px solid color-mix(in srgb, var(--color-info) 40%, transparent);
}
</style>
