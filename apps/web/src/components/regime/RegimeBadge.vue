<template>
  <span class="regime-badge" :class="badgeClass">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RegimeResult } from '@/api/modules/strategy/regimeEngine'

const props = defineProps<{
  regime: RegimeResult
}>()

const REGIME_LABELS: Record<RegimeResult, string> = {
  Q1: 'Q1 强多头',
  Q2: 'Q2 多头回调',
  Q3: 'Q3 反弹筑底',
  Q4: 'Q4 空头',
  unknown: '未知',
}

const label = computed(() => REGIME_LABELS[props.regime])

const badgeClass = computed(() => `regime-badge--${props.regime.toLowerCase()}`)
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

/* Q1: 强多头 — 绿 */
.regime-badge--q1 {
  background: color-mix(in srgb, var(--color-success) 18%, transparent);
  color: var(--color-success);
  border: 1px solid color-mix(in srgb, var(--color-success) 40%, transparent);
}

/* Q2: 多头回调 — 黄/金 */
.regime-badge--q2 {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  color: var(--color-primary);
  border: 1px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}

/* Q3: 反弹筑底 — 蓝/信息 */
.regime-badge--q3 {
  background: color-mix(in srgb, var(--color-focus-blue) 18%, transparent);
  color: var(--color-focus-blue);
  border: 1px solid color-mix(in srgb, var(--color-focus-blue) 40%, transparent);
}

/* Q4: 空头 — 红 */
.regime-badge--q4 {
  background: color-mix(in srgb, var(--color-error) 18%, transparent);
  color: var(--color-error);
  border: 1px solid color-mix(in srgb, var(--color-error) 40%, transparent);
}

/* unknown: 灰 */
.regime-badge--unknown {
  background: color-mix(in srgb, var(--color-text-muted) 18%, transparent);
  color: var(--color-text-muted);
  border: 1px solid color-mix(in srgb, var(--color-text-muted) 40%, transparent);
}
</style>
