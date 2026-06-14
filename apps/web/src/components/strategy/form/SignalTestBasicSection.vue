<template>
  <div>
    <n-form-item
      label="方案名称"
      path="name"
      :rule="{ required: true, message: '请输入方案名称' }"
    >
      <n-input
        :value="model.name"
        placeholder="输入方案名称"
        maxlength="100"
        show-count
        @update:value="(v: string) => patch({ name: v })"
      />
    </n-form-item>

    <n-divider>统计区间</n-divider>
    <n-form-item label="起止日期" path="dateRange" :rule="dateRangeRule">
      <n-date-picker
        :value="model.dateRange"
        type="daterange"
        clearable
        style="width: 100%"
        :is-date-disabled="() => false"
        @update:value="(v: [number, number] | null) => patch({ dateRange: v })"
      />
    </n-form-item>

    <n-divider>标的池</n-divider>
    <n-form-item label="标的范围">
      <n-radio-group
        :value="model.universeType"
        @update:value="(v: 'all' | 'list') => patch({ universeType: v })"
      >
        <n-radio value="all">全市场 A 股</n-radio>
        <n-radio value="list">指定标的列表</n-radio>
      </n-radio-group>
    </n-form-item>
    <n-form-item
      v-if="model.universeType === 'list'"
      label="标的列表"
      path="tsCodes"
      :rule="tsCodesRule"
    >
      <n-input
        :value="model.tsCodesText"
        type="textarea"
        :rows="4"
        placeholder="每行或逗号分隔输入 ts_code，如 000001.SZ"
        @update:value="(v: string) => patch({ tsCodesText: v })"
      />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { NFormItem, NInput, NDivider, NDatePicker, NRadioGroup, NRadio } from 'naive-ui'
import type { FormItemRule } from 'naive-ui'
import type { SignalTestFormModel } from '../../../composables/strategy/useSignalTestForm'

const props = defineProps<{
  model: SignalTestFormModel
  /** ts_code 解析器（来自 composable），用于校验「list 模式至少一个代码」。 */
  parseTsCodes: () => string[]
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<SignalTestFormModel>): void
}>()

function patch(p: Partial<SignalTestFormModel>) {
  emit('update', p)
}

const dateRangeRule: FormItemRule = {
  required: true,
  validator: () => {
    if (!props.model.dateRange) return new Error('请选择统计区间')
    return true
  },
}

const tsCodesRule: FormItemRule = {
  required: true,
  validator: () => {
    if (props.model.universeType === 'list' && props.parseTsCodes().length === 0)
      return new Error('请输入至少一个标的代码')
    return true
  },
}
</script>
