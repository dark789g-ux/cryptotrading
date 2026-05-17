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

      <!-- run_type='train' -->
      <template v-if="form.run_type === 'train'">
        <n-form-item label="feature_set_id" required>
          <n-input v-model:value="form.train.feature_set_id" placeholder="如：fs-v1-20260517" />
        </n-form-item>
        <n-form-item label="模型">
          <n-select v-model:value="form.train.model" :options="trainModelOptions" />
        </n-form-item>
        <n-form-item label="Walk-Forward">
          <n-switch v-model:value="form.train.walk_forward" />
        </n-form-item>
        <n-form-item label="随机种子（可选）">
          <n-input-number v-model:value="form.train.seed" :min="0" clearable />
        </n-form-item>
      </template>

      <!-- run_type='optuna' -->
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

      <!-- run_type='seed_avg' -->
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
      <n-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="onSubmit">
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
  value: 'lgb-lambdarank' | 'linear' | 'gbdt'
}

const runTypeOptions: RunTypeOption[] = [
  { label: '训练（train）', value: 'train' },
  { label: 'Optuna 调参（optuna）', value: 'optuna' },
  { label: 'Seed Averaging（seed_avg）', value: 'seed_avg' },
]

const trainModelOptions: TrainModelOption[] = [
  { label: 'LightGBM LambdaRank', value: 'lgb-lambdarank' },
  { label: '线性回归', value: 'linear' },
  { label: 'GBDT', value: 'gbdt' },
]

const form = reactive({
  run_type: 'train' as JobRunType,
  priority: 100,
  train: {
    feature_set_id: '',
    model: 'lgb-lambdarank' as 'lgb-lambdarank' | 'linear' | 'gbdt',
    walk_forward: true,
    seed: null as number | null,
  },
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

const submitting = ref(false)
const errorText = ref('')

function onRunTypeChange(v: JobRunType) {
  form.run_type = v
  errorText.value = ''
}

const canSubmit = computed(() => {
  switch (form.run_type) {
    case 'train':
      return form.train.feature_set_id.trim().length > 0
    case 'optuna':
      return form.optuna.feature_set_id.trim().length > 0 && form.optuna.n_trials > 0
    case 'seed_avg':
      return form.seed_avg.model_version_base.trim().length > 0
        && parseSeeds(form.seed_avg.seedsText).length > 0
    default:
      return false
  }
})

function parseSeeds(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .map(x => Number(x))
    .filter(n => Number.isFinite(n) && Number.isInteger(n))
}

function buildParams(): Record<string, unknown> {
  switch (form.run_type) {
    case 'train': {
      const p: Record<string, unknown> = {
        feature_set_id: form.train.feature_set_id.trim(),
        model: form.train.model,
        walk_forward: form.train.walk_forward,
      }
      if (form.train.seed !== null && form.train.seed !== undefined) {
        p.seed = form.train.seed
      }
      return p
    }
    case 'optuna':
      return {
        feature_set_id: form.optuna.feature_set_id.trim(),
        n_trials: form.optuna.n_trials,
        space: form.optuna.space.trim(),
      }
    case 'seed_avg':
      return {
        model_version_base: form.seed_avg.model_version_base.trim(),
        seeds: parseSeeds(form.seed_avg.seedsText),
      }
    default:
      return {}
  }
}

async function onSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  errorText.value = ''
  try {
    const job = await quantApi.createJob({
      run_type: form.run_type,
      params: buildParams(),
      priority: form.priority,
    })
    msg.success(`已提交，job_id=${job.id.slice(0, 8)}…`)
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
</script>
