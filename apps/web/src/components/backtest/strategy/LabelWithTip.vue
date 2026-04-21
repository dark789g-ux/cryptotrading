<template>
  <span class="label-with-tip">
    {{ label }}
    <n-tooltip :placement="placement" :style="{ maxWidth: maxWidth + 'px' }">
      <template #trigger>
        <span class="tip-icon">?</span>
      </template>
      <slot />
    </n-tooltip>
  </span>
</template>

<script setup lang="ts">
import { NTooltip } from 'naive-ui'

withDefaults(defineProps<{
  label: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  maxWidth?: number
}>(), {
  placement: 'top',
  maxWidth: 280,
})
</script>

<style scoped>
.label-with-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.tip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--ember-neutral, var(--color-text-muted));
  font-size: 10px;
  color: var(--ember-neutral, var(--color-text-muted));
  cursor: help;
  flex-shrink: 0;
}
</style>
