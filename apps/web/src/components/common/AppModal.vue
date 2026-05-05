<template>
  <n-modal
    :show="show"
    preset="card"
    class="app-modal"
    :style="{ width }"
    :bordered="false"
    :mask-closable="maskClosable"
    :closable="closable"
    @update:show="emit('update:show', $event)"
  >
    <template #header>
      <div class="app-modal-header">
        <div v-if="headerIcon" class="app-modal-header-icon">
          <n-icon><component :is="headerIcon" /></n-icon>
        </div>
        <div>
          <h3>{{ title }}</h3>
          <p v-if="description">{{ description }}</p>
        </div>
      </div>
    </template>

    <slot />

    <template #footer>
      <div class="app-modal-actions">
        <slot name="actions" />
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import { NIcon, NModal } from 'naive-ui'

withDefaults(
  defineProps<{
    show: boolean
    title: string
    headerIcon?: Component
    description?: string
    width?: string
    maskClosable?: boolean
    closable?: boolean
  }>(),
  {
    width: 'min(520px, 92vw)',
    maskClosable: true,
    closable: true,
  },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()
</script>

<style scoped>
.app-modal-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-modal-header-icon {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--color-primary) 40%, var(--color-border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 14%, var(--color-surface-elevated));
  color: var(--color-primary);
  font-size: 20px;
  flex-shrink: 0;
}

.app-modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--color-text);
}

.app-modal-header p {
  margin: 5px 0 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.app-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
