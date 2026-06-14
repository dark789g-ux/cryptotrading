<template>
  <AppModal
    :show="show"
    title="触发训练任务"
    description="选择 run_type 并填写参数；提交后跳转作业队列查看进度"
    width="min(640px, 94vw)"
    @update:show="emit('update:show', $event)"
  >
    <n-form ref="formRef" :model="form" label-placement="left" label-width="120" size="small">
      <n-form-item label="作业类型" path="run_type">
        <n-select
          v-model:value="form.run_type"
          :options="runTypeOptions"
          @update:value="onRunTypeChange"
        />
      </n-form-item>

      <!-- 三类训练共享：已备 feature_set + date_range -->
      <n-form-item label="已备 feature_set" required>
        <FeatureSetSelect
          :feature-set-id="form.shared.feature_set_id || null"
          @update:feature-set-id="onFeatureSetIdChange"
          @update:feature-set="onFeatureSetChange"
        />
      </n-form-item>

      <n-form-item label="训练日期范围" required>
        <n-date-picker
          v-model:value="form.shared.date_range"
          type="daterange"
          clearable
          :disabled="!selectedFeatureSet"
          :is-date-disabled="isDateDisabledFn"
          placeholder="选择日期范围"
          style="width: 100%"
        />
      </n-form-item>

      <!-- run_type='train' 独有参数 -->
      <template v-if="form.run_type === 'train'">
        <n-form-item label="模型">
          <n-select v-model:value="form.train.model" :options="trainModelOptions" />
        </n-form-item>
        <LgbHyperFields
          v-if="isLgbModel(form.train.model)"
          :model-value="trainLgbModel"
          :disable-early-stopping="true"
          @update:model-value="onTrainLgbUpdate"
        />
        <n-form-item label="Walk-Forward">
          <n-switch v-model:value="form.train.walk_forward" />
        </n-form-item>
        <n-form-item label="随机种子（可选）">
          <n-input-number v-model:value="form.train.seed" :min="0" clearable />
        </n-form-item>
      </template>

      <!-- run_type='optuna' 独有参数 -->
      <template v-else-if="form.run_type === 'optuna'">
        <n-form-item label="trial 数">
          <n-input-number v-model:value="form.optuna.n_trials" :min="1" :max="500" />
        </n-form-item>
        <n-form-item label="搜索空间">
          <n-input v-model:value="form.optuna.space" placeholder="如：lgb-4knobs" />
        </n-form-item>
      </template>

      <!-- run_type='seed_avg' 独有参数 -->
      <template v-else-if="form.run_type === 'seed_avg'">
        <n-form-item label="基础 model_version" required>
          <n-input
            v-model:value="form.seed_avg.model_version_base"
            placeholder="如：lgb-lambdarank-v1-20260620"
          />
        </n-form-item>
        <n-form-item label="种子列表">
          <n-input
            v-model:value="form.seed_avg.seedsText"
            placeholder="逗号分隔，例：42,43,44,45,46"
          />
        </n-form-item>
      </template>

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
        data-testid="train-submit-btn"
        @click="onSubmit"
      >
        保存草稿
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert, NButton, NDatePicker, NForm, NFormItem, NInput, NInputNumber,
  NSelect, NSwitch, useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import LgbHyperFields from '@/components/quant/train-modal/LgbHyperFields.vue'
import type { LgbHyperModel } from '@/components/quant/train-modal/LgbHyperFields.vue'
import FeatureSetSelect from '@/components/quant/train-modal/FeatureSetSelect.vue'
import {
  buildJobPayload,
  isLgbModel,
  isDateDisabled,
  parseSeedsText,
} from '@/components/quant/train-modal/buildParams'
import type { TrainModelKind } from '@/components/quant/train-modal/buildParams'
import { quantApi, type JobRunType, type FeatureSet } from '@/api/modules/quant'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  /** 提交成功后透传 jobId，父组件可决定是否跳转 */
  submitted: [jobId: string]
}>()

const router = useRouter()
const msg = useMessage()

interface RunTypeOption extends SelectOption {
  label: string
  value: JobRunType
}
interface TrainModelOption extends SelectOption {
  label: string
  value: TrainModelKind
}

const runTypeOptions: RunTypeOption[] = [
  { label: '训练（train）', value: 'train' },
  { label: 'Optuna 调参（optuna）', value: 'optuna' },
  { label: 'Seed Averaging（seed_avg）', value: 'seed_avg' },
]

const trainModelOptions: TrainModelOption[] = [
  { label: 'LightGBM LambdaRank', value: 'lgb-lambdarank' },
  { label: 'LightGBM 三分类', value: 'lgb-multiclass' },
  { label: '线性回归', value: 'linear' },
  { label: 'GBDT', value: 'gbdt' },
  { label: 'LSTM', value: 'lstm' },
]

const EMPTY_LGB: LgbHyperModel = {
  num_leaves: null,
  min_data_in_leaf: null,
  feature_fraction: null,
  learning_rate: null,
  num_boost_round: null,
  early_stopping_rounds: null,
  bagging_fraction: null,
  lambda_l1: null,
  lambda_l2: null,
}

const form = reactive({
  run_type: 'train' as JobRunType,
  priority: 100,
  /** 三类训练共享：feature_set_id + date_range */
  shared: {
    feature_set_id: '',
    date_range: null as [number, number] | null,
  },
  train: {
    model: 'lgb-lambdarank' as TrainModelKind,
    walk_forward: true,
    seed: null as number | null,
    lgb: undefined as LgbHyperModel | undefined,
  },
  optuna: {
    n_trials: 50,
    space: 'lgb-4knobs',
  },
  seed_avg: {
    model_version_base: '',
    seedsText: '42,43,44,45,46',
  },
})

/** 当前选中的 FeatureSet 对象（含 coverage），用于 is-date-disabled */
const selectedFeatureSet = ref<FeatureSet | null>(null)
const submitting = ref(false)
const errorText = ref('')

function onRunTypeChange(v: JobRunType) {
  form.run_type = v
  errorText.value = ''
}

function onFeatureSetIdChange(id: string | null) {
  form.shared.feature_set_id = id ?? ''
  // 切换 fs 时重置已选 date_range（spec 要求）
  form.shared.date_range = null
}

function onFeatureSetChange(fs: FeatureSet | null) {
  selectedFeatureSet.value = fs
  // 确保切换时同步重置（id change 事件先于 featureSet 事件，双保险）
  form.shared.date_range = null
}

/**
 * is-date-disabled 回调（传给 n-date-picker）。
 * spec 要求：选中 fs 后，不落在任一 coverage 段内的日期全禁用（区间外 + 空洞）。
 * fs 未选时整体禁用由 :disabled="!selectedFeatureSet" 控制，此回调可返 false 兜底。
 */
function isDateDisabledFn(ts: number): boolean {
  if (!selectedFeatureSet.value) return true
  return isDateDisabled(ts, selectedFeatureSet.value.coverage)
}

const canSubmit = computed(() => {
  const hasFs = form.shared.feature_set_id.trim().length > 0
  const hasDr = Array.isArray(form.shared.date_range)
    && typeof form.shared.date_range[0] === 'number'
    && typeof form.shared.date_range[1] === 'number'

  if (!hasFs || !hasDr) return false

  switch (form.run_type) {
    case 'train':
      return true
    case 'optuna':
      return form.optuna.n_trials > 0
    case 'seed_avg':
      return form.seed_avg.model_version_base.trim().length > 0
        && parseSeedsText(form.seed_avg.seedsText).length > 0
    default:
      return false
  }
})

/** 普通 train 的 lgb 超参（reactive form.train.lgb 与子组件 v-model 桥接） */
const trainLgbModel = computed<LgbHyperModel>(() => form.train.lgb ?? EMPTY_LGB)
function onTrainLgbUpdate(value: LgbHyperModel) {
  form.train.lgb = value
}

function buildParams() {
  return buildJobPayload(form)
}

async function onSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  errorText.value = ''
  try {
    const payload = buildParams()
    const job = await quantApi.createJob({
      run_type: payload.run_type,
      params: payload.params,
      priority: form.priority,
      as_draft: true,
    })
    msg.success(`草稿已保存，job_id=${job.id.slice(0, 8)}…`)
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
  (v) => {
    if (!v) errorText.value = ''
  },
)

// 暴露给单测：直接拿到内部 reactive form / selectedFeatureSet / canSubmit / buildParams / onSubmit
defineExpose({ form, selectedFeatureSet, canSubmit, buildParams, onSubmit, isDateDisabledFn })
</script>
