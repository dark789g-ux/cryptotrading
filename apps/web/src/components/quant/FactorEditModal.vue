<template>
  <AppModal
    :show="show"
    :title="modalTitle"
    description="formula / data_source 由代码维护，仅供阅读；其余字段编辑后下一次端到端训练生效"
    width="min(560px, 94vw)"
    @update:show="emit('update:show', $event)"
  >
    <n-alert v-if="errorText" type="error" :title="errorText" style="margin-bottom: 12px;" />

    <n-form
      v-if="form"
      ref="formRef"
      :model="form"
      label-placement="left"
      label-width="110"
      size="small"
    >
      <n-form-item label="描述" required>
        <n-input
          v-model:value="form.description"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="1-500 字符"
          maxlength="500"
          show-count
          data-testid="factor-edit-description"
        />
      </n-form-item>

      <n-form-item label="公式 formula">
        <n-input
          :value="formulaDisplay"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          readonly
          class="readonly-field"
          data-testid="factor-edit-formula"
        />
      </n-form-item>
      <div class="readonly-hint">仅供阅读，由代码维护</div>

      <n-form-item label="数据源">
        <n-input
          :value="dataSourceDisplay"
          readonly
          class="readonly-field"
          data-testid="factor-edit-data-source"
        />
      </n-form-item>
      <div class="readonly-hint">仅供阅读，由代码维护</div>

      <n-form-item label="类别">
        <n-radio-group v-model:value="form.category">
          <n-radio value="price">price</n-radio>
          <n-radio value="industry">industry</n-radio>
          <n-radio value="fundamental">fundamental</n-radio>
          <n-radio value="mixed">mixed</n-radio>
        </n-radio-group>
      </n-form-item>

      <n-form-item label="PIT 窗口" required>
        <n-input-number
          v-model:value="form.pit_window_days"
          :min="1"
          :max="400"
          placeholder="1-400 天"
          style="width: 160px;"
          data-testid="factor-edit-pit-window"
        />
        <span class="unit-label">天</span>
      </n-form-item>

      <n-form-item label="PIT 锚点">
        <n-radio-group v-model:value="form.pit_anchor">
          <n-radio value="trade_date">trade_date</n-radio>
          <n-radio value="ann_date">ann_date</n-radio>
        </n-radio-group>
      </n-form-item>

      <n-form-item label="显示顺序">
        <n-input-number
          v-model:value="form.display_order"
          :min="0"
          :max="9999"
          style="width: 160px;"
        />
      </n-form-item>
    </n-form>

    <n-alert
      v-if="showEffectWarning"
      type="warning"
      style="margin-top: 4px;"
      :show-icon="true"
      data-testid="factor-edit-warning"
    >
      该变更下一次端到端训练生效
    </n-alert>

    <template #actions>
      <n-button :disabled="submitting" @click="onCancel">取消</n-button>
      <n-button
        type="primary"
        :loading="submitting"
        :disabled="!canSubmit"
        data-testid="factor-edit-submit"
        @click="onSubmit"
      >
        保存
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NRadio,
  NRadioGroup,
  useMessage,
} from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import {
  quantApi,
  type FactorDefinition,
  type UpdateFactorPatch,
} from '@/api/modules/quant'

const props = defineProps<{
  show: boolean
  /** 当前编辑的因子；关闭弹窗时父组件应传 null（v-if 已挂载保护） */
  factor: FactorDefinition | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  /** 保存成功后透出最新行，父组件原地刷新 */
  saved: [item: FactorDefinition]
}>()

const message = useMessage()

interface FormShape {
  description: string
  category: FactorDefinition['category']
  pit_window_days: number
  pit_anchor: FactorDefinition['pit_anchor']
  display_order: number
}

const form = ref<FormShape | null>(null)
const submitting = ref(false)
const errorText = ref('')

const modalTitle = computed(() => {
  if (!props.factor) return '编辑因子'
  return `编辑因子：${props.factor.factor_id} (${props.factor.factor_version})`
})

const formulaDisplay = computed(() => props.factor?.formula ?? '—')
const dataSourceDisplay = computed(() => {
  const ds = props.factor?.data_source
  if (!ds || ds.length === 0) return '—'
  return ds.join(', ')
})

/** 改 pit_window_days / category / pit_anchor 任一时显示警告 */
const showEffectWarning = computed(() => {
  if (!form.value || !props.factor) return false
  return (
    form.value.pit_window_days !== props.factor.pit_window_days
    || form.value.category !== props.factor.category
    || form.value.pit_anchor !== props.factor.pit_anchor
  )
})

const descLenValid = computed(() => {
  const d = form.value?.description ?? ''
  const len = d.trim().length
  return len >= 1 && len <= 500
})

const windowValid = computed(() => {
  const w = form.value?.pit_window_days
  return typeof w === 'number' && Number.isFinite(w) && w >= 1 && w <= 400
})

const canSubmit = computed(() => {
  return !!form.value && descLenValid.value && windowValid.value && !submitting.value
})

// 同步外部 factor → 内部 form（每次 show 切 true 或 factor 引用变更）
watch(
  () => [props.show, props.factor] as const,
  ([show, factor]) => {
    if (show && factor) {
      form.value = {
        description: factor.description ?? '',
        category: factor.category,
        pit_window_days: factor.pit_window_days,
        pit_anchor: factor.pit_anchor,
        display_order: factor.display_order,
      }
      errorText.value = ''
    } else if (!show) {
      // 关闭时清掉错误，但保留 form 引用以避免动画期间空指针
      errorText.value = ''
    }
  },
  { immediate: true },
)

function buildPatch(): UpdateFactorPatch {
  if (!form.value || !props.factor) return {}
  const patch: UpdateFactorPatch = {}
  if (form.value.description !== props.factor.description) {
    patch.description = form.value.description
  }
  if (form.value.category !== props.factor.category) patch.category = form.value.category
  if (form.value.pit_window_days !== props.factor.pit_window_days) {
    patch.pit_window_days = form.value.pit_window_days
  }
  if (form.value.pit_anchor !== props.factor.pit_anchor) patch.pit_anchor = form.value.pit_anchor
  if (form.value.display_order !== props.factor.display_order) {
    patch.display_order = form.value.display_order
  }
  return patch
}

async function onSubmit() {
  if (!canSubmit.value || !props.factor || !form.value) return
  const patch = buildPatch()
  // 若用户未改任何字段，也允许提交（按后端 partial update 语义：空 patch 仍 200）
  submitting.value = true
  errorText.value = ''
  try {
    const res = await quantApi.updateFactor(
      props.factor.factor_id,
      props.factor.factor_version,
      patch,
    )
    message.success(`已保存因子 ${res.item.factor_id}`)
    emit('saved', res.item)
    emit('update:show', false)
  } catch (e) {
    errorText.value = `保存失败：${(e as Error).message}`
  } finally {
    submitting.value = false
  }
}

function onCancel() {
  if (submitting.value) return
  emit('update:show', false)
}

defineExpose({ form, canSubmit, buildPatch })
</script>

<style scoped>
.readonly-field :deep(.n-input__input-el),
.readonly-field :deep(.n-input__textarea-el) {
  color: var(--color-text-muted);
  background-color: color-mix(in srgb, var(--color-border) 18%, transparent);
  cursor: not-allowed;
}

.readonly-hint {
  margin: -8px 0 8px 110px;
  font-size: 12px;
  color: var(--color-text-muted);
  font-style: italic;
}

.unit-label {
  margin-left: 8px;
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
