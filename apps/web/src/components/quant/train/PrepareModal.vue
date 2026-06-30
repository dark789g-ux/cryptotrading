<template>
  <AppModal
    :show="show"
    title="触发备料任务"
    description="备料 = 生成 labels + features，扩展可训练区间；提交后跳转作业队列查看进度"
    width="min(640px, 94vw)"
    @update:show="emit('update:show', $event)"
  >
    <n-form ref="formRef" :model="form" label-placement="left" label-width="140" size="small">

      <!-- 命名标签 -->
      <n-form-item label="命名标签" required>
        <n-select
          v-model:value="form.labelKey"
          :options="labelOptions"
          :loading="loadingLabels"
          clearable
          placeholder="选择标签定义…"
        />
      </n-form-item>
      <div v-if="selectedLabelSummary" class="field-summary">
        {{ selectedLabelSummary }}
      </div>

      <!-- factor_version -->
      <n-form-item label="factor_version" required>
        <n-select
          v-model:value="form.factor_version"
          :options="factorVersionOptions"
          :loading="loadingVersions"
          filterable
          tag
          clearable
          placeholder="选择或输入 factor_version（如 v1）"
        />
      </n-form-item>

      <!-- 目标区间（备料扩范围，不 disable） -->
      <n-form-item label="目标区间" required>
        <n-date-picker
          v-model:value="form.date_range"
          type="daterange"
          clearable
          :default-value="defaultRange"
        />
      </n-form-item>

      <!-- 备料参数 -->
      <n-divider title-placement="left">备料参数（留空走后端默认）</n-divider>

      <n-form-item label="新股最少上市天数">
        <n-input-number
          v-model:value="form.new_listing_min_days"
          :min="0"
          :max="250"
          clearable
          placeholder="60"
        />
      </n-form-item>

      <n-form-item label="中性化维度">
        <n-select
          v-model:value="form.neutralize_cols"
          :options="neutralizeOptions"
          clearable
          placeholder="默认（行业+市值）"
        />
      </n-form-item>

      <n-form-item label="稳健标准化 robust_z">
        <n-switch v-model:value="form.robust_z" :default-value="undefined" />
      </n-form-item>

      <n-form-item label="因子截尾 σ">
        <n-input-number
          v-model:value="form.factor_clip_sigma"
          :min="1.5"
          :max="5.0"
          :step="0.5"
          clearable
          placeholder="3.0"
        />
      </n-form-item>

      <n-form-item
        label="标签截尾下界"
        :feedback="winsorizeFeedback"
        :validation-status="winsorizeStatus"
      >
        <n-input-number
          v-model:value="form.label_winsorize_lo"
          :min="-1.0"
          :max="0"
          :step="0.05"
          clearable
          placeholder="-0.5"
        />
      </n-form-item>

      <n-form-item label="标签截尾上界" :validation-status="winsorizeStatus">
        <n-input-number
          v-model:value="form.label_winsorize_hi"
          :min="0"
          :max="1.0"
          :step="0.05"
          clearable
          placeholder="0.5"
        />
      </n-form-item>

      <n-form-item label="强制重算">
        <n-switch v-model:value="form.force_recompute" />
        <span class="switch-hint">重算已有数据（跳过增量判断）</span>
      </n-form-item>

      <n-form-item label="优先级">
        <n-input-number v-model:value="form.priority" :min="0" :max="999" />
      </n-form-item>

    </n-form>

    <n-alert v-if="errorText" type="error" :title="errorText" style="margin-top: 8px;" />

    <template #actions>
      <n-button @click="onCancel">取消</n-button>
      <n-button
        type="primary"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="onSubmit"
      >
        保存草稿
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert, NButton, NDivider, NDatePicker, NForm, NFormItem,
  NInputNumber, NSelect, NSwitch, useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import { quantApi, type LabelDefinition } from '@/api/modules/quant'
import { mapNeutralizeCols } from './train-modal/buildParams'

// ──────────────────────────────────────
// props / emit
// ──────────────────────────────────────
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  /** 提交成功后透传 jobId，父组件可决定是否刷新 */
  submitted: [jobId: string]
}>()

const router = useRouter()
const msg = useMessage()

// ──────────────────────────────────────
// 表单 reactive model
// ──────────────────────────────────────
type NeutralizeCols = 'none' | 'industry' | 'industry_mv'

const form = reactive({
  labelKey: null as string | null,
  factor_version: null as string | null,
  /** 本地午夜 ms（n-date-picker daterange 原生格式，CLAUDE.md 硬约束：用 getFullYear/Month/Date） */
  date_range: null as [number, number] | null,
  new_listing_min_days: null as number | null,
  neutralize_cols: null as NeutralizeCols | null,
  robust_z: null as boolean | null,
  factor_clip_sigma: null as number | null,
  label_winsorize_lo: null as number | null,
  label_winsorize_hi: null as number | null,
  force_recompute: false,
  priority: 100,
})

// ──────────────────────────────────────
// 默认区间（近 6 个月，本地午夜口径）
// ──────────────────────────────────────
const defaultRange = computed<[number, number]>(() => {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  // 约 180 天
  return [end - 180 * 86_400_000, end]
})

// ──────────────────────────────────────
// 选项数据
// ──────────────────────────────────────
interface LabelSelectOption extends SelectOption {
  label: string
  value: string
  def: LabelDefinition
}

interface NeutralizeOption extends SelectOption {
  label: string
  value: NeutralizeCols
}

const neutralizeOptions: NeutralizeOption[] = [
  { label: '无中性化', value: 'none' },
  { label: '行业', value: 'industry' },
  { label: '行业+市值', value: 'industry_mv' },
]

// ──────────────────────────────────────
// 命名标签
// ──────────────────────────────────────
const loadingLabels = ref(false)
const labelDefs = ref<LabelDefinition[]>([])

async function loadLabels() {
  loadingLabels.value = true
  try {
    const res = await quantApi.listLabels({ enabled: true })
    labelDefs.value = res.items ?? []
  } catch {
    msg.warning('获取标签列表失败，请检查后端连接')
  } finally {
    loadingLabels.value = false
  }
}

function labelKeyOf(d: LabelDefinition): string {
  return `${d.label_id}:${d.label_version}`
}

function buildSummary(d: LabelDefinition): string {
  const basePart = d.base_type === 'fwd_ret'
    ? `fwd_ret h${d.base_params?.horizon ?? '?'}`
    : d.base_type === 'strategy_aware'
      ? `strategy_aware mhd${d.base_params?.max_hold_days ?? '?'}`
      : d.base_type

  let clsPart = '连续'
  if (d.classify_mode === 'band') {
    const eps = d.classify_params?.eps
    clsPart = typeof eps === 'number' ? `band ${(eps * 100).toFixed(2)}%` : 'band'
  } else if (d.classify_mode === 'tercile') {
    clsPart = 'tercile'
  } else if (d.classify_mode === 'custom') {
    clsPart = `custom p${d.classify_params?.lo_pct ?? '?'}-p${d.classify_params?.hi_pct ?? '?'}`
  }

  return `${basePart} | ${clsPart}`
}

const labelOptions = computed<LabelSelectOption[]>(() =>
  labelDefs.value.map((d) => ({
    label: `${d.name} (${d.label_version}) — ${buildSummary(d)}`,
    value: labelKeyOf(d),
    def: d,
  })),
)

const selectedLabelSummary = computed<string | null>(() => {
  const key = form.labelKey
  if (!key) return null
  const def = labelDefs.value.find((d) => labelKeyOf(d) === key)
  if (!def) return null
  return `${def.name}（${buildSummary(def)}）`
})

// ──────────────────────────────────────
// factor_version
// ──────────────────────────────────────
const loadingVersions = ref(false)
const factorVersionOptions = ref<SelectOption[]>([])

async function loadFactorVersions() {
  loadingVersions.value = true
  try {
    const res = await quantApi.listFactorVersions()
    factorVersionOptions.value = (res.versions ?? []).map((v) => ({ label: v, value: v }))
  } catch {
    msg.warning('获取 factor_version 列表失败，可手动输入')
  } finally {
    loadingVersions.value = false
  }
}

// keep-alive 规范：异步数据放 onActivated；onMounted 兜底首次
let activatedOnce = false
onMounted(() => {
  if (!activatedOnce) {
    void loadLabels()
    void loadFactorVersions()
  }
})
onActivated(() => {
  activatedOnce = true
  void loadLabels()
  void loadFactorVersions()
})

// ──────────────────────────────────────
// 校验
// ──────────────────────────────────────
const winsorizeStatus = computed<'error' | undefined>(() => {
  const loSet = form.label_winsorize_lo != null
  const hiSet = form.label_winsorize_hi != null
  return loSet !== hiSet ? 'error' : undefined
})
const winsorizeFeedback = computed(() =>
  winsorizeStatus.value === 'error' ? '上下界必须同时填写或同时留空' : undefined,
)

const canSubmit = computed(() => {
  return (
    !!form.labelKey
    && !!form.factor_version?.trim()
    && Array.isArray(form.date_range)
    && typeof form.date_range[0] === 'number'
    && typeof form.date_range[1] === 'number'
    && winsorizeStatus.value !== 'error'
  )
})

// ──────────────────────────────────────
// date_range 转换：本地午夜 ms → "YYYYMMDD:YYYYMMDD"
// CLAUDE.md 硬约束：n-date-picker 的值是本地午夜 ms，必须用 getFullYear/Month/Date
// ──────────────────────────────────────
function msToYMD(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function buildDateRangeStr(range: [number, number]): string {
  return `${msToYMD(range[0])}:${msToYMD(range[1])}`
}

// ──────────────────────────────────────
// label_ref 从 "label_id:label_version" 拆解
// ──────────────────────────────────────
function parseLabelRef(key: string): { label_id: string; label_version: string } {
  const colonIdx = key.indexOf(':')
  return {
    label_id: key.slice(0, colonIdx),
    label_version: key.slice(colonIdx + 1),
  }
}

// ──────────────────────────────────────
// 提交
// ──────────────────────────────────────
const submitting = ref(false)
const errorText = ref('')

async function onSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  errorText.value = ''
  try {
    const labelRef = parseLabelRef(form.labelKey!)
    const dateRangeStr = buildDateRangeStr(form.date_range as [number, number])

    const params: Record<string, unknown> = {
      factor_version: form.factor_version,
      date_range: dateRangeStr,
      force_recompute: form.force_recompute,
    }
    if (form.new_listing_min_days != null) params.new_listing_min_days = form.new_listing_min_days
    // neutralize_cols 前端三档枚举 → 后端语义数组（[] / ['industry_l1'] / ['industry_l1','mv']）
    if (form.neutralize_cols != null) {
      params.neutralize_cols = mapNeutralizeCols(form.neutralize_cols)
    }
    if (form.robust_z != null) params.robust_z = form.robust_z
    if (form.factor_clip_sigma != null) params.factor_clip_sigma = form.factor_clip_sigma
    if (form.label_winsorize_lo != null && form.label_winsorize_hi != null) {
      params.label_winsorize = [form.label_winsorize_lo, form.label_winsorize_hi]
    }

    const job = await quantApi.createJob({
      run_type: 'prepare',
      params,
      priority: form.priority,
      label_ref: labelRef,
      as_draft: true,
    })

    msg.success(`备料草稿已保存，job_id=${job.id.slice(0, 8)}…`)
    emit('submitted', job.id)
    emit('update:show', false)
    router.push({ name: 'quant-jobs', query: { highlight: job.id } })
  } catch (e) {
    errorText.value = `提交失败：${(e as Error).message}`
  } finally {
    submitting.value = false
  }
}

function onCancel() {
  emit('update:show', false)
}

// 关闭时重置错误（保留表单值，便于反复触发同类作业）
watch(
  () => props.show,
  (v) => { if (!v) errorText.value = '' },
)
</script>

<style scoped>
.field-summary {
  margin: -8px 0 12px 0;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-border) 16%, transparent);
  border-radius: 6px;
  border-left: 2px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}

.switch-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
</style>
