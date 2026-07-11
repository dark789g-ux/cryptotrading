<template>
  <n-modal
    :show="show"
    preset="dialog"
    title="新建 Regime 回测"
    :show-icon="false"
    :mask-closable="false"
    style="width: min(900px, 96vw)"
    @update:show="$emit('update:show', $event)"
  >
    <RegimeBacktestCreateForm ref="formRef" :active="show" @success="handleSuccess" />

    <template #action>
      <n-button @click="$emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="submitting" @click="handleSubmit">
        新建并运行
      </n-button>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NModal, NButton } from 'naive-ui'
import type { RegimeBacktestRun } from '@/api/modules/strategy/regimeEngine'
import RegimeBacktestCreateForm from './RegimeBacktestCreateForm.vue'

defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  success: [run: RegimeBacktestRun]
}>()

const formRef = ref<InstanceType<typeof RegimeBacktestCreateForm> | null>(null)
const submitting = computed(() => formRef.value?.submitting ?? false)

async function handleSubmit() {
  const ok = await formRef.value?.submit()
  if (ok) emit('update:show', false)
}

function handleSuccess(run: RegimeBacktestRun) {
  emit('success', run)
  emit('update:show', false)
}
</script>