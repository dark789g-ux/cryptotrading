<template>
  <AppModal
    :show="show"
    :title="modalTitle"
    description="名称/描述/状态 可直接改；语义字段（base_type/classify_mode/参数）不可变，改了请新建版本"
    width="min(580px, 94vw)"
    @update:show="emit('update:show', $event)"
  >
    <n-alert v-if="errorText" type="error" :title="errorText" style="margin-bottom: 12px;" />

    <n-form
      v-if="form"
      ref="formRef"
      :model="form"
      label-placement="left"
      label-width="120"
      size="small"
    >
      <!-- 基本信息 -->
      <n-form-item label="标签 ID" required>
        <n-input
          v-model:value="form.label_id"
          :disabled="isEditMode"
          placeholder="my_label（仅小写字母/数字/下划线）"
          data-testid="label-edit-id"
        />
      </n-form-item>

      <n-form-item label="版本" required>
        <n-input
          v-model:value="form.label_version"
          :disabled="isEditMode"
          placeholder="v1"
          style="width: 120px;"
          data-testid="label-edit-version"
        />
      </n-form-item>

      <n-form-item label="名称" required>
        <n-input
          v-model:value="form.name"
          placeholder="例：次日涨跌·横盘±0.5%"
          maxlength="100"
          show-count
          data-testid="label-edit-name"
        />
      </n-form-item>

      <n-form-item label="描述">
        <n-input
          v-model:value="form.description"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="可选"
          maxlength="500"
          show-count
          data-testid="label-edit-description"
        />
      </n-form-item>

      <!-- 基础层 -->
      <n-divider title-placement="left">基础层</n-divider>

      <BaseTypeFields
        :model-value="baseTypeModel"
        @update:model-value="onBaseTypeUpdate"
      />

      <!-- 分类层 -->
      <n-divider title-placement="left">分类层（可选）</n-divider>

      <ClassifyFields
        :model-value="classifyModel"
        @update:model-value="onClassifyUpdate"
      />

      <!-- 状态（仅编辑模式展示） -->
      <template v-if="isEditMode">
        <n-divider />
        <n-form-item label="启用">
          <n-switch v-model:value="form.enabled" data-testid="label-edit-enabled" />
        </n-form-item>
        <n-form-item label="显示顺序">
          <n-input-number
            v-model:value="form.display_order"
            :min="0"
            :max="9999"
            style="width: 160px;"
          />
        </n-form-item>
      </template>
    </n-form>

    <template #actions>
      <n-button :disabled="submitting" @click="onCancel">取消</n-button>
      <n-button
        type="primary"
        :loading="submitting"
        :disabled="!canSubmit"
        data-testid="label-edit-submit"
        @click="onSubmit"
      >
        {{ isEditMode ? '保存' : '新建' }}
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert, NButton, NDivider, NForm, NFormItem,
  NInput, NInputNumber, NSwitch, useMessage,
} from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import BaseTypeFields from './label-modal/BaseTypeFields.vue'
import type { BaseTypeModel } from './label-modal/BaseTypeFields.vue'
import ClassifyFields from './label-modal/ClassifyFields.vue'
import type { ClassifyModel } from './label-modal/ClassifyFields.vue'
import { quantApi, type LabelDefinition } from '@/api/modules/quant'

interface LabelFormShape {
  label_id: string
  label_version: string
  name: string
  description: string
  base_type: string
  base_params: Record<string, unknown>
  classify_mode: string | null
  classify_params: Record<string, unknown> | null
  enabled: boolean
  display_order: number
}

const props = defineProps<{
  show: boolean
  /** 编辑模式传已有行；null = 新建模式 */
  label: LabelDefinition | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: [item: LabelDefinition]
}>()

const message = useMessage()

const form = ref<LabelFormShape | null>(null)
const submitting = ref(false)
const errorText = ref('')

const isEditMode = computed(() => props.label !== null)

const modalTitle = computed(() =>
  isEditMode.value
    ? `编辑标签：${props.label!.label_id} (${props.label!.label_version})`
    : '新建标签',
)

// 子组件 model 的 computed 视图（避免 template 里直接嵌套 if null）
const baseTypeModel = computed<BaseTypeModel>(() => ({
  base_type: form.value?.base_type ?? 'fwd_ret',
  base_params: form.value?.base_params ?? { horizon: 1 },
}))

const classifyModel = computed<ClassifyModel>(() => ({
  classify_mode: form.value?.classify_mode ?? null,
  classify_params: form.value?.classify_params ?? null,
}))

function onBaseTypeUpdate(v: BaseTypeModel) {
  if (!form.value) return
  form.value.base_type = v.base_type
  form.value.base_params = v.base_params
}

function onClassifyUpdate(v: ClassifyModel) {
  if (!form.value) return
  form.value.classify_mode = v.classify_mode
  form.value.classify_params = v.classify_params
}

// 校验
const idValid = computed(() => /^[a-z0-9_]{1,64}$/.test(form.value?.label_id ?? ''))
const versionValid = computed(() => /^v\d+$/.test(form.value?.label_version ?? ''))
const nameValid = computed(() => (form.value?.name?.trim().length ?? 0) >= 1)

const canSubmit = computed(() =>
  !!form.value
  && idValid.value
  && versionValid.value
  && nameValid.value
  && (form.value.base_type === 'fwd_ret' || form.value.base_type === 'strategy_aware')
  && !submitting.value,
)

// 初始化 form
watch(
  () => [props.show, props.label] as const,
  ([show, label]) => {
    if (show) {
      if (label) {
        // 编辑模式：回填
        form.value = {
          label_id: label.label_id,
          label_version: label.label_version,
          name: label.name,
          description: label.description ?? '',
          base_type: label.base_type,
          base_params: label.base_params ?? {},
          classify_mode: label.classify_mode ?? null,
          classify_params: label.classify_params ?? null,
          enabled: label.enabled,
          display_order: label.display_order,
        }
      } else {
        // 新建模式：空表单
        form.value = {
          label_id: '',
          label_version: 'v1',
          name: '',
          description: '',
          base_type: 'fwd_ret',
          base_params: { horizon: 1 },
          classify_mode: null,
          classify_params: null,
          enabled: true,
          display_order: 0,
        }
      }
      errorText.value = ''
    } else {
      errorText.value = ''
    }
  },
  { immediate: true },
)

async function onSubmit() {
  if (!canSubmit.value || !form.value) return
  submitting.value = true
  errorText.value = ''
  try {
    if (isEditMode.value && props.label) {
      // 编辑模式：PATCH 元数据
      const res = await quantApi.updateLabel(props.label.label_id, props.label.label_version, {
        name: form.value.name,
        description: form.value.description || undefined,
        enabled: form.value.enabled,
        display_order: form.value.display_order,
      })
      message.success(`已保存标签 ${res.item.label_id}`)
      emit('saved', res.item)
    } else {
      // 新建模式：POST
      const res = await quantApi.createLabel({
        label_id: form.value.label_id,
        label_version: form.value.label_version,
        name: form.value.name,
        description: form.value.description || undefined,
        base_type: form.value.base_type,
        base_params: form.value.base_params,
        classify_mode: form.value.classify_mode ?? null,
        classify_params: form.value.classify_params ?? null,
        display_order: form.value.display_order,
      })
      message.success(`已新建标签 ${res.item.label_id}`)
      emit('saved', res.item)
    }
    emit('update:show', false)
  } catch (e) {
    errorText.value = `操作失败：${(e as Error).message}`
  } finally {
    submitting.value = false
  }
}

function onCancel() {
  if (submitting.value) return
  emit('update:show', false)
}

defineExpose({ form, canSubmit })
</script>
