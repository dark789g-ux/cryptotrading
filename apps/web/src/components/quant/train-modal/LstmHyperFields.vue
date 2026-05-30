<template>
  <div class="lstm-hyper-fields">
    <n-divider title-placement="left">LSTM 超参（留空走后端默认）</n-divider>

    <n-form-item label="lookback">
      <n-input-number
        :value="modelValue.lookback"
        :min="1"
        :max="250"
        clearable
        placeholder="32"
        @update:value="(v: number | null) => update('lookback', v)"
      />
    </n-form-item>

    <n-form-item label="hidden_size">
      <n-input-number
        :value="modelValue.hidden_size"
        :min="1"
        clearable
        placeholder="128"
        @update:value="(v: number | null) => update('hidden_size', v)"
      />
    </n-form-item>

    <n-form-item label="num_layers">
      <n-input-number
        :value="modelValue.num_layers"
        :min="1"
        :max="8"
        clearable
        placeholder="2"
        @update:value="(v: number | null) => update('num_layers', v)"
      />
    </n-form-item>

    <n-form-item label="dropout">
      <n-input-number
        :value="modelValue.dropout"
        :min="0"
        :max="1"
        :step="0.05"
        clearable
        placeholder="0.2"
        @update:value="(v: number | null) => update('dropout', v)"
      />
    </n-form-item>

    <n-form-item label="learning_rate">
      <n-input-number
        :value="modelValue.learning_rate"
        :min="0"
        :step="0.0001"
        clearable
        placeholder="0.001"
        @update:value="(v: number | null) => update('learning_rate', v)"
      />
    </n-form-item>

    <n-form-item label="epochs">
      <n-input-number
        :value="modelValue.epochs"
        :min="1"
        :max="1000"
        clearable
        placeholder="50"
        @update:value="(v: number | null) => update('epochs', v)"
      />
    </n-form-item>

    <n-form-item label="batch_size">
      <n-input-number
        :value="modelValue.batch_size"
        :min="1"
        clearable
        placeholder="512"
        @update:value="(v: number | null) => update('batch_size', v)"
      />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { NDivider, NFormItem, NInputNumber } from 'naive-ui'

/** 仅 model==='lstm' 时有意义；留空（null）= 不传 → 后端补 DEFAULT_LSTM_HYPERPARAMS */
export interface LstmHyperModel {
  lookback: number | null
  hidden_size: number | null
  num_layers: number | null
  dropout: number | null
  learning_rate: number | null
  epochs: number | null
  batch_size: number | null
}

const props = defineProps<{ modelValue: LstmHyperModel }>()
const emit = defineEmits<{
  'update:modelValue': [value: LstmHyperModel]
}>()

function update<K extends keyof LstmHyperModel>(key: K, value: LstmHyperModel[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<style scoped>
.lstm-hyper-fields {
  display: contents;
}
</style>
