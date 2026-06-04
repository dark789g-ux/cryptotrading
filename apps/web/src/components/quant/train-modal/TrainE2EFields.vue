<template>
  <div class="train-e2e-fields">
    <n-form-item label="factor_version" required>
      <n-select
        :value="modelValue.factor_version || null"
        :options="factorVersionOptions"
        :loading="loadingVersions"
        filterable
        tag
        clearable
        placeholder="选择或输入 factor_version（如 v1）"
        @update:value="(v: string | null) => update('factor_version', v ?? '')"
      />
    </n-form-item>

    <n-form-item label="命名标签" required>
      <n-select
        :value="selectedLabelKey"
        :options="labelOptions"
        :loading="loadingLabels"
        clearable
        placeholder="选择标签定义…"
        data-testid="e2e-label-select"
        @update:value="onLabelSelect"
      />
    </n-form-item>

    <div v-if="selectedLabelSummary" class="label-summary">
      {{ selectedLabelSummary }}
    </div>

    <n-form-item label="新股最少上市天数">
      <n-input-number
        :value="modelValue.new_listing_min_days"
        :min="0"
        :max="250"
        clearable
        placeholder="60"
        @update:value="(v: number | null) => update('new_listing_min_days', v)"
      />
    </n-form-item>

    <n-form-item label="日期范围" required>
      <n-date-picker
        :value="modelValue.date_range"
        type="daterange"
        clearable
        :default-value="defaultRange"
        @update:value="(v: [number, number] | null) => update('date_range', v)"
      />
    </n-form-item>

    <n-divider />

    <n-form-item label="模型" required>
      <n-select
        :value="modelValue.model"
        :options="modelOptions"
        @update:value="(v: ModelKind) => update('model', v)"
      />
    </n-form-item>

    <n-collapse>
      <n-collapse-item v-if="showHyperPanel" title="模型超参" name="hyper">
        <LgbHyperFields
          v-if="isLgb"
          :model-value="lgbModel"
          @update:model-value="onLgbUpdate"
        />
        <LstmHyperFields
          v-else-if="modelValue.model === 'lstm'"
          :model-value="lstmModel"
          @update:model-value="onLstmUpdate"
        />
      </n-collapse-item>

      <n-collapse-item title="特征 / 标签参数" name="feature">
        <FeatureLabelFields
          :model-value="featureLabelModel"
          @update:model-value="onFeatureLabelUpdate"
        />
      </n-collapse-item>
    </n-collapse>

    <n-form-item label="Walk-Forward">
      <n-switch
        :value="modelValue.walk_forward"
        @update:value="(v: boolean) => update('walk_forward', v)"
      />
    </n-form-item>

    <n-form-item label="随机种子（可选）">
      <n-input-number
        :value="modelValue.seed"
        :min="0"
        clearable
        placeholder="42"
        @update:value="(v: number | null) => update('seed', v)"
      />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import {
  NCollapse, NCollapseItem, NDatePicker, NDivider, NFormItem,
  NInputNumber, NSelect, NSwitch, useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import LstmHyperFields from './LstmHyperFields.vue'
import type { LstmHyperModel } from './LstmHyperFields.vue'
import LgbHyperFields from './LgbHyperFields.vue'
import type { LgbHyperModel } from './LgbHyperFields.vue'
import FeatureLabelFields from './FeatureLabelFields.vue'
import type { FeatureLabelModel } from './FeatureLabelFields.vue'
import { quantApi, type LabelDefinition } from '@/api/modules/quant'

export type ModelKind = 'lgb-lambdarank' | 'lgb-multiclass' | 'linear' | 'gbdt' | 'lstm'

export interface E2EFormModel {
  factor_version: string
  /** 命名标签 key（label_id:label_version），对应 labelRef */
  labelKey: string | null
  /** null = 走后端默认 60（交易日） */
  new_listing_min_days: number | null
  /** 本地午夜 ms（n-date-picker daterange 原生格式，CLAUDE.md 硬约束） */
  date_range: [number, number] | null
  model: ModelKind
  walk_forward: boolean
  seed: number | null
  /** 仅 model==='lstm' 时有意义；其它模型忽略 */
  lstm?: LstmHyperModel
  /** 仅 model ∈ {lgb-lambdarank, lgb-multiclass} 时有意义 */
  lgb?: LgbHyperModel
  /** E2E 专属：特征/标签生成参数 */
  featureLabel?: FeatureLabelModel
}

interface LabelSelectOption extends SelectOption {
  label: string
  value: string
  /** 持有原始 LabelDefinition 供摘要展示 */
  def: LabelDefinition
}

interface ModelOption extends SelectOption {
  label: string
  value: ModelKind
}

const props = defineProps<{ modelValue: E2EFormModel }>()
const emit = defineEmits<{
  'update:modelValue': [value: E2EFormModel]
}>()

const message = useMessage()

const modelOptions: ModelOption[] = [
  { label: 'LightGBM LambdaRank', value: 'lgb-lambdarank' },
  { label: 'LightGBM 三分类（次日方向）', value: 'lgb-multiclass' },
  { label: '线性回归', value: 'linear' },
  { label: 'GBDT', value: 'gbdt' },
  { label: 'LSTM（次日方向三分类）', value: 'lstm' },
]

const EMPTY_LSTM: LstmHyperModel = {
  lookback: null,
  hidden_size: null,
  num_layers: null,
  dropout: null,
  learning_rate: null,
  epochs: null,
  batch_size: null,
}

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

const EMPTY_FEATURE_LABEL: FeatureLabelModel = {
  neutralize_cols: null,
  robust_z: null,
  factor_clip_sigma: null,
  label_winsorize_lo: null,
  label_winsorize_hi: null,
}

const isLgb = computed(
  () => props.modelValue.model === 'lgb-lambdarank' || props.modelValue.model === 'lgb-multiclass',
)
/** linear / gbdt 无可调模型超参，不显示「模型超参」面板 */
const showHyperPanel = computed(() => isLgb.value || props.modelValue.model === 'lstm')

const lstmModel = computed<LstmHyperModel>(() => props.modelValue.lstm ?? EMPTY_LSTM)
const lgbModel = computed<LgbHyperModel>(() => props.modelValue.lgb ?? EMPTY_LGB)
const featureLabelModel = computed<FeatureLabelModel>(
  () => props.modelValue.featureLabel ?? EMPTY_FEATURE_LABEL,
)

function onLstmUpdate(value: LstmHyperModel) {
  update('lstm', value)
}
function onLgbUpdate(value: LgbHyperModel) {
  update('lgb', value)
}
function onFeatureLabelUpdate(value: FeatureLabelModel) {
  update('featureLabel', value)
}

// ---- factor_version 动态下拉 ----
const loadingVersions = ref(false)
const factorVersionOptions = ref<SelectOption[]>([])

async function loadFactorVersions() {
  loadingVersions.value = true
  try {
    const res = await quantApi.listFactorVersions()
    factorVersionOptions.value = (res.versions ?? []).map((v) => ({ label: v, value: v }))
  } catch {
    // 非阻塞：失败保留手输能力（filterable + tag），不卡死创建流程
    message.warning('获取 factor_version 列表失败，可手动输入')
  } finally {
    loadingVersions.value = false
  }
}

// ---- 命名标签下拉 ----
const loadingLabels = ref(false)
const labelDefs = ref<LabelDefinition[]>([])

async function loadLabels() {
  loadingLabels.value = true
  try {
    const res = await quantApi.listLabels({ enabled: true })
    labelDefs.value = res.items ?? []
  } catch {
    message.warning('获取标签列表失败，请检查后端连接')
  } finally {
    loadingLabels.value = false
  }
}

/** label_id:label_version 组成选项 key，避免两标签 id 相同只是版本不同时冲突 */
function labelKey(d: LabelDefinition): string {
  return `${d.label_id}:${d.label_version}`
}

/** 单条标签的摘要文本（用于下拉项副标题） */
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
    value: labelKey(d),
    def: d,
  })),
)

const selectedLabelKey = computed(() => props.modelValue.labelKey ?? null)

/** 当前选中标签的摘要（显示在下拉框下方） */
const selectedLabelSummary = computed<string | null>(() => {
  const key = props.modelValue.labelKey
  if (!key) return null
  const def = labelDefs.value.find((d) => labelKey(d) === key)
  if (!def) return null
  return `${def.name}（${buildSummary(def)}）`
})

function onLabelSelect(key: string | null) {
  update('labelKey', key)
}

// keep-alive 规范：异步数据放 onActivated；onMounted 兜底首次
let activatedOnce = false
onMounted(() => {
  if (!activatedOnce) {
    void loadFactorVersions()
    void loadLabels()
  }
})
onActivated(() => {
  activatedOnce = true
  void loadFactorVersions()
  void loadLabels()
})

/** 默认近 30 天，本地午夜口径（CLAUDE.md 硬约束：禁 getUTC*） */
const defaultRange = computed<[number, number]>(() => {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return [end - 30 * 86_400_000, end]
})

function update<K extends keyof E2EFormModel>(key: K, value: E2EFormModel[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<style scoped>
.train-e2e-fields {
  display: contents;
}
.label-summary {
  margin: -8px 0 12px 0;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-border) 16%, transparent);
  border-radius: 6px;
  border-left: 2px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}
</style>
