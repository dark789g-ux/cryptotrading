<template>
  <n-modal
    :show="show"
    preset="card"
    :class="['app-modal', { 'is-maximized': isMaximized }]"
    :style="modalStyle"
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

    <template v-if="maximizable" #header-extra>
      <n-button
        text
        :focusable="false"
        class="app-modal-maximize"
        :title="isMaximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <template #icon>
          <n-icon :component="isMaximized ? ContractOutline : ExpandOutline" />
        </template>
      </n-button>
    </template>

    <slot :maximized="isMaximized" />

    <template v-if="$slots.actions" #footer>
      <div class="app-modal-actions">
        <slot name="actions" />
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import { NButton, NIcon, NModal } from 'naive-ui'
import { ContractOutline, ExpandOutline } from '@vicons/ionicons5'

const props = withDefaults(
  defineProps<{
    show: boolean
    title: string
    headerIcon?: Component
    description?: string
    width?: string
    maskClosable?: boolean
    closable?: boolean
    maximizable?: boolean
  }>(),
  {
    width: 'min(520px, 92vw)',
    maskClosable: true,
    closable: true,
    maximizable: false,
  },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

const maximized = ref(false)
const isMaximized = computed(() => props.maximizable && maximized.value)

watch(
  () => props.show,
  (v) => { if (!v) maximized.value = false },
)

function toggleMaximize() {
  maximized.value = !maximized.value
}

const modalStyle = computed(() =>
  isMaximized.value ? { width: '96vw', height: '92vh' } : { width: props.width },
)
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

.app-modal-maximize {
  font-size: 18px;
  color: var(--color-text-secondary);
  margin-right: 6px;
}

.app-modal.is-maximized :deep(.n-card) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-modal.is-maximized :deep(.n-card__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
