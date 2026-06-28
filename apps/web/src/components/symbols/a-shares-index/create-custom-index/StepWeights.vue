<template>
  <div class="step-weights">
    <n-radio-group :value="weightMethod" @update:value="onMethodChange">
      <n-space>
        <n-radio value="equal">等权</n-radio>
        <n-radio value="float_mv">流通市值加权</n-radio>
        <n-radio value="custom">自定义权重</n-radio>
      </n-space>
    </n-radio-group>

    <n-spin :show="previewLoading" style="margin-top: 16px">
      <n-data-table
        v-if="weightMethod === 'custom'"
        size="small"
        :columns="customColumns"
        :data="members"
        :max-height="240"
        :pagination="false"
        style="margin-top: 12px"
      />

      <div class="weight-preview">
        <div class="preview-title">权重预览</div>
        <div v-for="item in previewItems" :key="item.conCode" class="preview-row">
          <span class="preview-label">{{ item.name }}</span>
          <div class="preview-bar-wrap">
            <div class="preview-bar" :style="{ width: `${item.pct}%` }" />
          </div>
          <span class="preview-pct">{{ item.pct.toFixed(2) }}%</span>
        </div>
        <n-empty v-if="!previewItems.length" description="请先添加成分股" size="small" />
      </div>
    </n-spin>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'StepWeights' })

import { computed, h, watch } from 'vue'
import type { DataTableColumns } from 'naive-ui'
import { NDataTable, NEmpty, NInputNumber, NRadio, NRadioGroup, NSpace, NSpin } from 'naive-ui'
import type { CustomWeightMethod } from '@/api/modules/market/customIndex'
import type { WizardMember } from './useCreateCustomIndexWizard'

const props = defineProps<{
  members: WizardMember[]
  weightMethod: CustomWeightMethod
  customWeights: Record<string, number>
  previewMembers: Array<{ conCode: string; name: string; weight: number }>
  previewLoading: boolean
}>()

const emit = defineEmits<{
  'update:weightMethod': [value: CustomWeightMethod]
  'update:customWeights': [value: Record<string, number>]
  refresh: []
}>()

const customColumns = computed<DataTableColumns<WizardMember>>(() => [
  { title: '代码', key: 'conCode', width: 110 },
  { title: '名称', key: 'name', width: 120, ellipsis: { tooltip: true } },
  {
    title: '权重(%)',
    key: 'weight',
    width: 120,
    render: (row) =>
      h(NInputNumber, {
        value: props.customWeights[row.conCode] ?? null,
        min: 0,
        max: 100,
        precision: 2,
        size: 'small',
        style: { width: '100px' },
        onUpdateValue: (v: number | null) => {
          const next = { ...props.customWeights, [row.conCode]: v ?? 0 }
          emit('update:customWeights', next)
        },
      }),
  },
])

const previewItems = computed(() =>
  props.previewMembers.map((m) => ({
    conCode: m.conCode,
    name: m.name,
    pct: m.weight * 100,
  })),
)

const weightSum = computed(() =>
  props.members.reduce((acc, m) => acc + (props.customWeights[m.conCode] ?? 0), 0),
)

function onMethodChange(v: CustomWeightMethod) {
  emit('update:weightMethod', v)
  emit('refresh')
}

watch(
  () => [props.weightMethod, props.members.length, weightSum.value] as const,
  () => emit('refresh'),
)

watch(
  () => props.customWeights,
  () => {
    if (props.weightMethod === 'custom') emit('refresh')
  },
  { deep: true },
)
</script>

<style scoped>
.weight-preview {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-elevated, rgba(0, 0, 0, 0.02));
}
.preview-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}
.preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}
.preview-label {
  width: 80px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-bar-wrap {
  flex: 1;
  height: 8px;
  background: var(--color-border);
  border-radius: 4px;
  overflow: hidden;
}
.preview-bar {
  height: 100%;
  background: var(--color-primary);
  border-radius: 4px;
  min-width: 2px;
}
.preview-pct {
  width: 52px;
  text-align: right;
  flex-shrink: 0;
}
</style>
