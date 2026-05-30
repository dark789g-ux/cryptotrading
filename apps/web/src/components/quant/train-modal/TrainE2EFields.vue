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

    <n-form-item label="label_scheme" required>
      <n-select
        :value="modelValue.label_scheme"
        :options="labelSchemeOptions"
        @update:value="(v: LabelScheme) => update('label_scheme', v)"
      />
    </n-form-item>

    <n-form-item
      v-if="modelValue.label_scheme === 'dir3_band'"
      label="横盘阈值 ε"
    >
      <n-input-number
        :value="modelValue.dir3_band_eps ?? DIR3_BAND_EPS_DEFAULT"
        :min="0.001"
        :max="0.1"
        :step="0.001"
        :precision="3"
        @update:value="(v: number | null) => update('dir3_band_eps', v)"
      >
        <template #suffix>
          ≈ {{ ((modelValue.dir3_band_eps ?? DIR3_BAND_EPS_DEFAULT) * 100).toFixed(1) }}%
        </template>
      </n-input-number>
    </n-form-item>

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
          :label-scheme="modelValue.label_scheme"
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
import { computed, ref, watch, onActivated, onMounted } from 'vue'
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
import { quantApi } from '@/api/modules/quant'

export type LabelScheme = 'strategy-aware' | 'fwd_5d_ret' | 'dir3_band' | 'dir3_tercile'
export type ModelKind = 'lgb-lambdarank' | 'lgb-multiclass' | 'linear' | 'gbdt' | 'lstm'

export interface E2EFormModel {
  factor_version: string
  label_scheme: LabelScheme
  /**
   * dir3_band 横盘阈值 ε（仅 label_scheme==='dir3_band' 时有意义）。
   * null = 走后端默认 0.005（legacy）。0.1% 网格、范围 0<ε≤0.1。
   * 编解码（ε→canonical scheme 串）在后端 dir3_scheme.py 单一源完成，前端只发原始 ε。
   */
  dir3_band_eps?: number | null
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

interface LabelSchemeOption extends SelectOption {
  label: string
  value: LabelScheme
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

/** dir3_band 横盘阈值 ε 默认值（legacy 0.5%）。后端 canonical 回 'dir3_band' 串，守哈希不漂移。 */
const DIR3_BAND_EPS_DEFAULT = 0.005

const labelSchemeOptions: LabelSchemeOption[] = [
  { label: 'strategy-aware', value: 'strategy-aware' },
  { label: 'fwd_5d_ret', value: 'fwd_5d_ret' },
  { label: '次日方向·固定阈值带 (dir3_band)', value: 'dir3_band' },
  { label: '次日方向·截面三分位 (dir3_tercile)', value: 'dir3_tercile' },
]

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
  fwd_horizon_days: null,
  max_hold_days: null,
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

// keep-alive 规范：异步数据放 onActivated；onMounted 兜底首次（组件未被 keep-alive 缓存时）
let activatedOnce = false
onMounted(() => {
  if (!activatedOnce) void loadFactorVersions()
})
onActivated(() => {
  activatedOnce = true
  void loadFactorVersions()
})

/**
 * 默认联动（降低误配）：
 *  - 选 lstm 或 lgb-multiclass 且当前 label_scheme 非 dir3_* → 自动切 'dir3_band'
 *  - 切回非方向三分类模型且当前 dir3_* → 切回 'strategy-aware'
 * 用户仍可手动覆盖（非强制）。
 */
watch(
  () => props.modelValue.model,
  (model) => {
    const scheme = props.modelValue.label_scheme
    const isDir3 = scheme === 'dir3_band' || scheme === 'dir3_tercile'
    const wantsDir3 = model === 'lstm' || model === 'lgb-multiclass'
    if (wantsDir3 && !isDir3) {
      update('label_scheme', 'dir3_band')
    } else if (!wantsDir3 && isDir3) {
      update('label_scheme', 'strategy-aware')
    }
  },
)

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
</style>
