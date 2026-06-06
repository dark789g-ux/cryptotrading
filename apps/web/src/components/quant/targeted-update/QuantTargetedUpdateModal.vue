<template>
  <AppModal
    :show="show"
    title="因子 / 标签定向更新"
    description="只重算选定因子/标签的基础数据，不触发特征矩阵或训练"
    width="min(580px, 94vw)"
    @update:show="emit('update:show', $event)"
  >
    <n-form label-placement="left" label-width="120" size="small">
      <!-- raw 数据依赖提示 -->
      <n-alert type="info" style="margin-bottom: 14px;">
        提交前请确认目标日期范围的 raw 数据（行情 / adj_factor / daily_basic）已同步。
        重算为 <strong>upsert</strong>：只更新/插入、不删旧行（退市股历史残留旧值不会抹除）。
      </n-alert>

      <!-- 日期范围 -->
      <n-form-item label="日期范围" required>
        <n-date-picker
          v-model:value="dateRange"
          type="daterange"
          clearable
          :default-value="defaultRange"
          data-testid="targeted-date-range"
          @update:value="onDateRangeUpdate"
        />
      </n-form-item>

      <n-divider style="margin: 8px 0;" />

      <!-- 因子选择 -->
      <n-collapse v-model:expanded-names="expandedSections">
        <n-collapse-item title="因子（factors）" name="factors">
          <TargetedFactorSelect
            :factor-ids="factorIds"
            :version="factorVersion"
            @update:factor-ids="factorIds = $event"
            @update:version="factorVersion = $event"
          />
        </n-collapse-item>

        <n-collapse-item title="命名标签（labels）" name="labels">
          <TargetedLabelSelect
            v-model="labelKey"
          />
        </n-collapse-item>
      </n-collapse>

      <!-- 校验错误 -->
      <n-alert
        v-if="validationError"
        type="error"
        :title="validationError"
        style="margin-top: 10px;"
      />
      <n-alert v-if="errorText" type="error" :title="errorText" style="margin-top: 8px;" />
    </n-form>

    <template #actions>
      <n-button @click="onCancel">取消</n-button>
      <n-button
        type="primary"
        :loading="submitting"
        :disabled="!canSubmit"
        data-testid="targeted-submit-btn"
        @click="onSubmit"
      >
        提交
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert, NButton, NCollapse, NCollapseItem, NDatePicker, NDivider,
  NForm, NFormItem, useMessage,
} from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import TargetedFactorSelect from './TargetedFactorSelect.vue'
import TargetedLabelSelect from './TargetedLabelSelect.vue'
import { formatDateRange } from '@/components/quant/train-modal/buildParams'
import { quantApi } from '@/api/modules/quant'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  /** 提交成功后透传 jobId（可能是多个，传最后一个让父组件跳转） */
  submitted: [jobId: string]
}>()

const router = useRouter()
const msg = useMessage()

// ---- 表单状态 ----
const dateRange = ref<[number, number] | null>(null)
const factorIds = ref<string[]>([])
const factorVersion = ref<string>('v1')
const labelKey = ref<string | null>(null)
const expandedSections = ref<string[]>(['factors'])

const submitting = ref(false)
const errorText = ref('')

// ---- 默认近 30 天（本地午夜口径，CLAUDE.md 硬约束：禁 getUTC*） ----
const defaultRange = computed<[number, number]>(() => {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return [end - 30 * 86_400_000, end]
})

function onDateRangeUpdate(v: [number, number] | null) {
  dateRange.value = v
}

// ---- 校验 ----

/** 日期范围是否有效（非空且 start <= end，n-date-picker 自身保证 start <= end） */
const dateRangeValid = computed<boolean>(() => {
  const r = dateRange.value
  return Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number'
})

/** 至少选了因子或标签中的一个 */
const hasSelection = computed<boolean>(
  () => factorIds.value.length > 0 || labelKey.value !== null,
)

const validationError = computed<string | null>(() => {
  if (!hasSelection.value) return '请至少选择一个因子或一个标签'
  if (!dateRangeValid.value) return '请选择日期范围'
  return null
})

const canSubmit = computed<boolean>(
  () => !submitting.value && validationError.value === null,
)

// ---- 提交 ----

async function onSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  errorText.value = ''

  const dr = formatDateRange(dateRange.value as [number, number])
  let lastJobId: string | null = null

  try {
    // factors job：仅在 factor_ids 非空时发送（空数组后端当作全量，绝不发）
    if (factorIds.value.length > 0) {
      const factorJob = await quantApi.createJob({
        run_type: 'factors',
        params: {
          version: factorVersion.value,
          date_range: dr,
          factor_ids: factorIds.value,
        },
      })
      lastJobId = factorJob.id
    }

    // labels job：仅在选了标签时发送，不自己拼 scheme
    if (labelKey.value !== null) {
      const idx = labelKey.value.indexOf(':')
      const label_id = idx >= 0 ? labelKey.value.slice(0, idx) : labelKey.value
      const label_version = idx >= 0 ? labelKey.value.slice(idx + 1) : 'v1'
      const labelJob = await quantApi.createJob({
        run_type: 'labels',
        label_ref: { label_id, label_version },
        params: {
          date_range: dr,
        },
      })
      lastJobId = labelJob.id
    }

    if (lastJobId) {
      msg.success(`已提交定向更新，job_id=${lastJobId.slice(0, 8)}…`)
      emit('submitted', lastJobId)
      emit('update:show', false)
      router.push({ name: 'quant-jobs', query: { highlight: lastJobId } })
    }
  } catch (e) {
    errorText.value = `提交失败：${(e as Error).message}`
  } finally {
    submitting.value = false
  }
}

function onCancel() {
  emit('update:show', false)
}

// 关闭时清错误（保留表单值便于复用）
watch(
  () => props.show,
  (v) => {
    if (!v) errorText.value = ''
  },
)

// 暴露给单测
defineExpose({
  dateRange,
  factorIds,
  factorVersion,
  labelKey,
  canSubmit,
  validationError,
  onSubmit,
})
</script>
