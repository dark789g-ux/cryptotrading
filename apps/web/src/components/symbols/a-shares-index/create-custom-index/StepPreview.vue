<template>
  <div class="step-preview">
    <n-descriptions bordered :column="1" size="small" label-placement="left">
      <n-descriptions-item label="名称">{{ state.name || '—' }}</n-descriptions-item>
      <n-descriptions-item label="描述">{{ state.description || '—' }}</n-descriptions-item>
      <n-descriptions-item label="成分数">{{ state.members.length }} 只</n-descriptions-item>
      <n-descriptions-item label="权重方案">{{ weightMethodLabel }}</n-descriptions-item>
      <n-descriptions-item label="基期">{{ formatYmd(state.baseDate) }}</n-descriptions-item>
      <n-descriptions-item label="基点">{{ state.basePoint }}</n-descriptions-item>
      <n-descriptions-item label="指数类型">{{ indexTypeLabel }}</n-descriptions-item>
      <n-descriptions-item label="调仓生效日">{{ formatYmd(state.effectiveDate) }}</n-descriptions-item>
    </n-descriptions>

    <n-alert
      v-if="actualStartDate && state.baseDate && actualStartDate > state.baseDate"
      type="warning"
      :show-icon="true"
      style="margin-top: 12px"
    >
      预估实际序列起始日 {{ formatYmd(actualStartDate) }}，晚于基期 {{ formatYmd(state.baseDate) }}（部分成分缺少更早数据）。
    </n-alert>

    <n-collapse style="margin-top: 12px">
      <n-collapse-item title="成分与权重明细" name="members">
        <n-data-table
          size="small"
          :columns="memberColumns"
          :data="previewMembers"
          :max-height="200"
          :pagination="false"
        />
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'StepPreview' })

import { computed } from 'vue'
import type { DataTableColumns } from 'naive-ui'
import { NAlert, NCollapse, NCollapseItem, NDataTable, NDescriptions, NDescriptionsItem } from 'naive-ui'
import type { CustomIndexMemberRow, CustomIndexType, CustomWeightMethod } from '@/api/modules/market/customIndex'
import type { CreateCustomIndexWizardState } from './useCreateCustomIndexWizard'

const props = defineProps<{
  state: CreateCustomIndexWizardState
  previewMembers: CustomIndexMemberRow[]
  actualStartDate: string | null
}>()

const WEIGHT_LABEL: Record<CustomWeightMethod, string> = {
  equal: '等权',
  float_mv: '流通市值加权',
  custom: '自定义权重',
}

const TYPE_LABEL: Record<CustomIndexType, string> = {
  price: '价格指数',
  total_return: '全收益指数',
}

const weightMethodLabel = computed(() => WEIGHT_LABEL[props.state.weightMethod])
const indexTypeLabel = computed(() => TYPE_LABEL[props.state.indexType])

const memberColumns: DataTableColumns<CustomIndexMemberRow> = [
  { title: '代码', key: 'conCode', width: 120 },
  { title: '名称', key: 'name' },
  {
    title: '权重',
    key: 'weight',
    width: 90,
    render: (row) => `${(row.weight * 100).toFixed(2)}%`,
  },
]

function formatYmd(ymd: string | null): string {
  if (!ymd || ymd.length !== 8) return '—'
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}
</script>
