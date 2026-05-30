<template>
  <div class="lgb-hyper-fields">
    <n-divider title-placement="left">LightGBM 超参（留空走后端默认）</n-divider>

    <n-form-item label="num_leaves">
      <n-input-number
        :value="modelValue.num_leaves"
        :min="15"
        :max="127"
        :step="1"
        clearable
        placeholder="31"
        @update:value="(v: number | null) => update('num_leaves', v)"
      />
    </n-form-item>

    <n-form-item label="min_data_in_leaf">
      <n-input-number
        :value="modelValue.min_data_in_leaf"
        :min="50"
        :max="500"
        :step="10"
        clearable
        placeholder="200"
        @update:value="(v: number | null) => update('min_data_in_leaf', v)"
      />
    </n-form-item>

    <n-form-item label="feature_fraction">
      <n-input-number
        :value="modelValue.feature_fraction"
        :min="0.5"
        :max="1.0"
        :step="0.05"
        clearable
        placeholder="0.85"
        @update:value="(v: number | null) => update('feature_fraction', v)"
      />
    </n-form-item>

    <n-form-item label="learning_rate">
      <n-input-number
        :value="modelValue.learning_rate"
        :min="0.01"
        :max="0.2"
        :step="0.005"
        clearable
        placeholder="0.05"
        @update:value="(v: number | null) => update('learning_rate', v)"
      />
    </n-form-item>

    <n-form-item label="num_boost_round">
      <n-input-number
        :value="modelValue.num_boost_round"
        :min="50"
        :max="2000"
        :step="50"
        clearable
        placeholder="500"
        @update:value="(v: number | null) => update('num_boost_round', v)"
      />
    </n-form-item>

    <n-form-item label="early_stopping_rounds">
      <n-tooltip :disabled="!disableEarlyStopping" trigger="hover">
        <template #trigger>
          <n-input-number
            :value="modelValue.early_stopping_rounds"
            :min="10"
            :max="200"
            :step="10"
            clearable
            placeholder="50"
            :disabled="disableEarlyStopping"
            @update:value="(v: number | null) => update('early_stopping_rounds', v)"
          />
        </template>
        仅 walk_forward 模式生效
      </n-tooltip>
    </n-form-item>

    <n-form-item label="bagging_fraction">
      <n-input-number
        :value="modelValue.bagging_fraction"
        :min="0.5"
        :max="1.0"
        :step="0.05"
        clearable
        placeholder="0.85"
        @update:value="(v: number | null) => update('bagging_fraction', v)"
      />
    </n-form-item>

    <n-form-item label="lambda_l1">
      <n-input-number
        :value="modelValue.lambda_l1"
        :min="0"
        :step="0.1"
        clearable
        placeholder="0"
        @update:value="(v: number | null) => update('lambda_l1', v)"
      />
    </n-form-item>

    <n-form-item label="lambda_l2">
      <n-input-number
        :value="modelValue.lambda_l2"
        :min="0"
        :step="0.1"
        clearable
        placeholder="0"
        @update:value="(v: number | null) => update('lambda_l2', v)"
      />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { NDivider, NFormItem, NInputNumber, NTooltip } from 'naive-ui'

/**
 * 仅 model ∈ {lgb-lambdarank, lgb-multiclass} 时有意义；
 * 留空（null）= 不传 → 后端补 LightGBM 默认超参（单一真理源在 Python）。
 */
export interface LgbHyperModel {
  num_leaves: number | null
  min_data_in_leaf: number | null
  feature_fraction: number | null
  learning_rate: number | null
  num_boost_round: number | null
  early_stopping_rounds: number | null
  bagging_fraction: number | null
  lambda_l1: number | null
  lambda_l2: number | null
}

const props = withDefaults(
  defineProps<{
    modelValue: LgbHyperModel
    /**
     * 普通 train 的 single_fold 路径硬编码 early_stopping_rounds=None，
     * 该字段静默失效，故 disabled + tooltip 提示（仅 walk_forward 生效）。
     */
    disableEarlyStopping?: boolean
  }>(),
  { disableEarlyStopping: false },
)
const emit = defineEmits<{
  'update:modelValue': [value: LgbHyperModel]
}>()

function update<K extends keyof LgbHyperModel>(key: K, value: LgbHyperModel[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<style scoped>
.lgb-hyper-fields {
  display: contents;
}
</style>
