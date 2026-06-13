<template>
  <n-tooltip v-if="description" :placement="placement" :style="{ maxWidth: maxWidth + 'px' }">
    <template #trigger>
      <span class="field-help-icon">?</span>
    </template>
    {{ description }}
  </n-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NTooltip } from 'naive-ui'
import { getFieldDescription } from './fieldDescriptions'

const props = withDefaults(defineProps<{
  /** 字段 conceptId（见 fieldDescriptions.ts）；无说明则不渲染 "?" */
  field?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  maxWidth?: number
}>(), {
  placement: 'top',
  maxWidth: 300,
})

const description = computed(() => getFieldDescription(props.field))
</script>

<style scoped>
.field-help-icon {
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
