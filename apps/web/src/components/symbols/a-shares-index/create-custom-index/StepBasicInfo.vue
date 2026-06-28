<template>
  <div class="step-basic-info">
    <n-alert type="info" :show-icon="true" style="margin-bottom: 16px">
      自定义指数 = 选定成分股 + 权重方案 + 基期口径 → 系统合成历史序列，行为与同花顺/申万指数一致。
    </n-alert>
    <n-form label-placement="top">
      <n-form-item label="名称" required>
        <n-input
          :value="name"
          maxlength="100"
          show-count
          placeholder="如：我的白酒指数"
          @update:value="emit('update:name', $event)"
        />
      </n-form-item>
      <n-form-item label="描述">
        <n-input
          :value="description"
          type="textarea"
          :rows="3"
          placeholder="可选，说明指数用途或策略"
          @update:value="emit('update:description', $event)"
        />
      </n-form-item>
    </n-form>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'StepBasicInfo' })

import { NAlert, NForm, NFormItem, NInput } from 'naive-ui'

defineProps<{
  name: string
  description: string
}>()

const emit = defineEmits<{
  'update:name': [value: string]
  'update:description': [value: string]
}>()
</script>
