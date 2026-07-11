<template>
  <n-modal
    class="ember-strategy-modal"
    :show="show"
    @update:show="$emit('update:show', $event)"
    :title="isEdit ? '编辑策略' : '新建策略'"
    preset="dialog"
    style="width: 780px"
    :show-icon="false"
    :mask-closable="false"
  >
    <StrategyFormPanel
      v-if="show"
      :active="show"
      :is-edit="isEdit"
      :strategy="strategy"
      :show-actions="false"
      ref="panelRef"
      @success="onSuccess"
    />
    <template #action>
      <n-button @click="$emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="panelRef?.submitting" @click="panelRef?.submit()">
        保存
      </n-button>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NButton } from 'naive-ui'
import StrategyFormPanel from './StrategyFormPanel.vue'

defineProps<{ show: boolean; isEdit: boolean; strategy?: unknown }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'success'): void }>()

const panelRef = ref<{ submit: () => Promise<void>; submitting: boolean } | null>(null)

function onSuccess() {
  emit('success')
  emit('update:show', false)
}
</script>

<style scoped>
.ember-strategy-modal :deep(.n-dialog) {
  box-shadow: 0 24px 48px color-mix(in srgb, var(--color-ink) 12%, transparent);
  border-radius: 12px;
}
.ember-strategy-modal :deep(.n-dialog__title) {
  font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ember-text, var(--color-text));
  font-size: 20px;
}
.ember-strategy-modal :deep(.n-dialog__content) { padding-top: 4px; }
.ember-strategy-modal :deep(.n-dialog__action) { padding-top: 12px; }
</style>
