<template>
  <AppModal
    :show="show"
    title="新建信号源"
    description="内联定义一个全新的信号方案，创建后立即触发运行，完成后即可作为组合源使用"
    width="min(1100px, 96vw)"
    maximizable
    :mask-closable="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <SignalTestForm ref="formRef" @submit="onFormSubmit" />

    <template #actions>
      <n-button :disabled="submitting" @click="emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="submitting" @click="handleCreate">创建并运行</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import AppModal from '../common/AppModal.vue'
import SignalTestForm from '../../views/strategy/SignalTestForm.vue'
import { signalStatsApi } from '../../api/modules/strategy/signalStats'
import type { CreateSignalTestDto } from '../../api/modules/strategy/signalStats'

defineProps<{ show: boolean }>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'created', payload: { runId: string; testId: string }): void
}>()

const message = useMessage()
const formRef = ref<InstanceType<typeof SignalTestForm> | null>(null)
const submitting = ref(false)

/** 「创建并运行」按钮：正向触发表单校验+提交，校验通过后表单会 @submit 回调到 onFormSubmit。 */
function handleCreate() {
  formRef.value?.submit()
}

/** 表单校验通过后的真正提交：创建方案 → 触发 run → 把 {runId, testId} 抛给父组件。 */
async function onFormSubmit(dto: CreateSignalTestDto) {
  submitting.value = true
  try {
    const test = await signalStatsApi.create(dto)
    const { runId } = await signalStatsApi.triggerRun(test.id)
    message.success('信号源已创建并开始运行')
    emit('created', { runId, testId: test.id })
    emit('update:show', false)
  } catch (e) {
    message.error(e instanceof Error ? e.message : '创建信号源失败')
    // 不关闭弹窗、不 emit created，复位 submitting 允许重试
  } finally {
    submitting.value = false
  }
}
</script>
