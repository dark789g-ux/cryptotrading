<template>
  <AppModal
    :show="show"
    :title="modalTitle"
    width="min(720px, 94vw)"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <n-steps :current="step" style="margin-bottom: 20px">
      <n-step v-for="(title, i) in stepTitles" :key="i" :title="title" />
    </n-steps>

    <step-basic-info
      v-if="step === 1"
      v-model:name="state.name"
      v-model:description="state.description"
    />
    <step-members
      v-else-if="step === 2"
      :members="state.members"
      :min-members="MIN_MEMBERS"
      :max-members="MAX_MEMBERS"
      @add="addMember"
      @remove="removeMember"
      @import-members="setMembersFromImport"
    />
    <step-weights
      v-else-if="step === 3"
      v-model:weight-method="state.weightMethod"
      v-model:custom-weights="state.customWeights"
      :members="state.members"
      :preview-members="previewMembers"
      :preview-loading="previewLoading"
      @refresh="refreshWeightPreview"
    />
    <step-index-spec
      v-else-if="step === 4"
      v-model:base-date="state.baseDate"
      v-model:base-point="state.basePoint"
      v-model:index-type="state.indexType"
      v-model:effective-date="state.effectiveDate"
      :is-edit="isEditMode"
    />
    <step-preview
      v-else
      :state="state"
      :preview-members="previewMembers"
      :actual-start-date="actualStartDate"
    />

    <template #actions>
      <n-button :disabled="submitting" @click="handleCancel">取消</n-button>
      <n-button v-if="step > 1" :disabled="submitting" @click="goPrev">上一步</n-button>
      <n-button v-if="step < 5" type="primary" :disabled="submitting" @click="goNext">
        下一步
      </n-button>
      <n-button v-else type="primary" :loading="submitting" @click="handleSubmit">
        {{ isEditMode ? '保存并重算' : '创建并开始计算' }}
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'CreateCustomIndexModal' })

import { computed, ref, watch } from 'vue'
import { NButton, NStep, NSteps, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import StepBasicInfo from './create-custom-index/StepBasicInfo.vue'
import StepMembers from './create-custom-index/StepMembers.vue'
import StepWeights from './create-custom-index/StepWeights.vue'
import StepIndexSpec from './create-custom-index/StepIndexSpec.vue'
import StepPreview from './create-custom-index/StepPreview.vue'
import { useCreateCustomIndexWizard } from './create-custom-index/useCreateCustomIndexWizard'

const props = defineProps<{
  show: boolean
  mode?: 'create' | 'edit'
  editId?: string | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: [payload: { id: string; status: string; isEdit: boolean }]
}>()

const message = useMessage()
const submitting = ref(false)

const {
  step,
  state,
  stepTitles,
  previewMembers,
  previewLoading,
  actualStartDate,
  isEditMode,
  MIN_MEMBERS,
  MAX_MEMBERS,
  loadForEdit,
  reset,
  addMember,
  removeMember,
  setMembersFromImport,
  validateStep,
  refreshWeightPreview,
  submitCreate,
  submitUpdate,
} = useCreateCustomIndexWizard()

const modalTitle = computed(() => (isEditMode.value ? '编辑自定义指数' : '创建自定义指数'))

watch(
  () => props.show,
  async (v) => {
    if (!v) {
      reset()
      return
    }
    if (props.mode === 'edit' && props.editId) {
      try {
        await loadForEdit(props.editId)
      } catch (err: unknown) {
        message.error(err instanceof Error ? err.message : '加载指数详情失败')
        emit('update:show', false)
      }
    } else {
      reset()
    }
  },
)

function handleCancel() {
  emit('update:show', false)
}

function goPrev() {
  if (step.value > 1) step.value -= 1
}

async function goNext() {
  const err = validateStep(step.value + 1)
  if (err) {
    message.warning(err)
    return
  }
  if (step.value === 3 || step.value === 4) {
    await refreshWeightPreview()
  }
  step.value += 1
}

async function handleSubmit() {
  const err = validateStep(5)
  if (err) {
    message.warning(err)
    return
  }
  submitting.value = true
  try {
    const result = isEditMode.value ? await submitUpdate() : await submitCreate()
    message.success(isEditMode.value ? '已保存，正在重算' : '创建成功，正在计算')
    if (!isEditMode.value && (result.status === 'pending' || result.status === 'computing')) {
      message.info('指数计算中，完成后可查看 K 线')
    }
    emit('saved', { id: result.id, status: result.status, isEdit: isEditMode.value })
    emit('update:show', false)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '提交失败')
  } finally {
    submitting.value = false
  }
}
</script>
