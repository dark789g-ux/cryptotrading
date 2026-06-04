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

      <!-- run_type='train'：mode 切换（D-8 默认端到端） -->
      <template v-if="form.run_type === 'train'">
        <n-form-item label="模式">
          <n-switch v-model:value="modeIsE2E" data-testid="mode-switch">
            <template #checked>端到端</template>
            <template #unchecked>使用现有 feature_set</template>
          </n-switch>
        </n-form-item>

        <!-- 端到端字段块（D-19 子组件） -->
        <TrainE2EFields v-if="modeIsE2E" v-model="form.e2e" />

        <!-- 老 existing feature_set 模式（保留） -->
        <template v-else>
          <n-form-item label="feature_set_id" required>
            <n-input v-model:value="form.train.feature_set_id" placeholder="如：fs-v1-20260517" />
          </n-form-item>
          <n-form-item label="模型">
            <n-select v-model:value="form.train.model" :options="trainModelOptions" />
          </n-form-item>
          <!-- lgb 系模型超参（普通 train：walk_forward 受 single_fold 限制，early_stopping disabled） -->
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
      </template>

      <!-- run_type='optuna'（D-9 不动） -->
      <template v-else-if="form.run_type === 'optuna'">
        <n-form-item label="feature_set_id" required>
          <n-input v-model:value="form.optuna.feature_set_id" />
        </n-form-item>
        <n-form-item label="trial 数">
          <n-input-number v-model:value="form.optuna.n_trials" :min="1" :max="500" />
        </n-form-item>
        <n-form-item label="搜索空间">
          <n-input v-model:value="form.optuna.space" placeholder="如：lgb-4knobs" />
        </n-form-item>
      </template>

      <!-- run_type='seed_avg'（D-9 不动） -->
      <template v-else-if="form.run_type === 'seed_avg'">
        <n-form-item label="基础 model_version" required>
          <n-input v-model:value="form.seed_avg.model_version_base"
            placeholder="如：lgb-lambdarank-v1-20260620" />
        </n-form-item>
        <n-form-item label="种子列表">
          <n-input v-model:value="form.seed_avg.seedsText"
            placeholder="逗号分隔，例：42,43,44,45,46" />
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
        提交
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert, NButton, NForm, NFormItem, NInput, NInputNumber, NSelect, NSwitch,
  useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import TrainE2EFields from '@/components/quant/train-modal/TrainE2EFields.vue'
import type { E2EFormModel } from '@/components/quant/train-modal/TrainE2EFields.vue'
import LgbHyperFields from '@/components/quant/train-modal/LgbHyperFields.vue'
import type { LgbHyperModel } from '@/components/quant/train-modal/LgbHyperFields.vue'
import { buildJobPayload, isLgbModel, isWinsorizePaired } from '@/components/quant/train-modal/buildParams'
import type { TrainModelKind } from '@/components/quant/train-modal/buildParams'
import { quantApi, type JobRunType } from '@/api/modules/quant'

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
  train: {
    feature_set_id: '',
    model: 'lgb-lambdarank' as TrainModelKind,
    walk_forward: true,
    seed: null as number | null,
    lgb: undefined as LgbHyperModel | undefined,
  },
  e2e: {
    factor_version: '',
    labelKey: null,
    new_listing_min_days: null,
    date_range: null,
    model: 'lgb-lambdarank',
    walk_forward: true,
    seed: null,
  } as E2EFormModel,
  optuna: {
    feature_set_id: '',
    n_trials: 50,
    space: 'lgb-4knobs',
  },
  seed_avg: {
    model_version_base: '',
    seedsText: '42,43,44,45,46',
  },
})

/** D-8：默认端到端 */
const modeIsE2E = ref(true)
const submitting = ref(false)
const errorText = ref('')

function onRunTypeChange(v: JobRunType) {
  form.run_type = v
  errorText.value = ''
}

const canSubmit = computed(() => {
  if (form.run_type === 'train' && modeIsE2E.value) {
    const e = form.e2e
    return e.factor_version.trim().length > 0
      && !!e.labelKey
      && Array.isArray(e.date_range)
      && typeof e.date_range[0] === 'number'
      && typeof e.date_range[1] === 'number'
      && !!e.model
      // label_winsorize 区间必须成对（只填一个 → 阻断提交，FeatureLabelFields 已内联报错）
      && isWinsorizePaired(e)
  }
  switch (form.run_type) {
    case 'train':
      return form.train.feature_set_id.trim().length > 0
    case 'optuna':
      return form.optuna.feature_set_id.trim().length > 0 && form.optuna.n_trials > 0
    case 'seed_avg':
      return form.seed_avg.model_version_base.trim().length > 0
        && parseLocalSeeds(form.seed_avg.seedsText).length > 0
    default:
      return false
  }
})

function parseLocalSeeds(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .map(x => Number(x))
    .filter(n => Number.isFinite(n) && Number.isInteger(n))
}

/** 普通 train 的 lgb 超参（reactive form.train.lgb 与子组件 v-model 桥接） */
const trainLgbModel = computed<LgbHyperModel>(() => form.train.lgb ?? EMPTY_LGB)
function onTrainLgbUpdate(value: LgbHyperModel) {
  form.train.lgb = value
}

function buildParams() {
  return buildJobPayload(form, modeIsE2E.value)
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
      label_ref: payload.labelRef,
    })
    if (form.run_type === 'train' && modeIsE2E.value) {
      // D-20：长任务排队提示
      msg.success('作业已入队。端到端训练预计 20-40 分钟，期间其他 pending 作业会排队。')
    } else {
      msg.success(`已提交，job_id=${job.id.slice(0, 8)}…`)
    }
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

// 暴露给单测：直接拿到内部 reactive form / mode / canSubmit / buildParams / onSubmit
defineExpose({ form, modeIsE2E, canSubmit, buildParams, onSubmit })
</script>
