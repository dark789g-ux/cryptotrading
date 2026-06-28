<template>
  <div class="step-index-spec">
    <n-alert type="info" :show-icon="true" style="margin-bottom: 16px">
      价格指数反映点位变化；全收益指数计入分红再投资。编辑保存若变更成分/权重/类型，将产生新版本并触发重算。
    </n-alert>
    <n-form label-placement="top">
      <n-form-item label="基期日期" required>
        <n-date-picker
          :value="baseDateTs"
          type="date"
          clearable
          style="width: 100%"
          @update:value="onBaseDateChange"
        />
      </n-form-item>
      <n-form-item label="基点">
        <n-input-number
          :value="basePoint"
          :min="1"
          :precision="0"
          style="width: 100%"
          @update:value="emit('update:basePoint', $event ?? 1000)"
        />
      </n-form-item>
      <n-form-item label="指数类型">
        <n-radio-group :value="indexType" @update:value="emit('update:indexType', $event)">
          <n-space>
            <n-radio value="price">价格指数</n-radio>
            <n-radio value="total_return">全收益指数</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>
      <n-form-item :label="isEdit ? '调仓生效日' : '调仓生效日（默认同基期）'">
        <n-date-picker
          :value="effectiveDateTs"
          type="date"
          clearable
          style="width: 100%"
          @update:value="onEffectiveDateChange"
        />
      </n-form-item>
    </n-form>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'StepIndexSpec' })

import { computed } from 'vue'
import { NAlert, NDatePicker, NForm, NFormItem, NInputNumber, NRadio, NRadioGroup, NSpace } from 'naive-ui'
import type { CustomIndexType } from '@/api/modules/market/customIndex'

const props = defineProps<{
  baseDate: string | null
  basePoint: number
  indexType: CustomIndexType
  effectiveDate: string | null
  isEdit: boolean
}>()

const emit = defineEmits<{
  'update:baseDate': [value: string | null]
  'update:basePoint': [value: number]
  'update:indexType': [value: CustomIndexType]
  'update:effectiveDate': [value: string | null]
}>()

function ymdToTs(ymd: string | null): number | null {
  if (!ymd || ymd.length !== 8) return null
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(4, 6)) - 1
  const d = Number(ymd.slice(6, 8))
  return new Date(y, m, d).getTime()
}

function tsToYmd(ts: number | null): string | null {
  if (ts == null) return null
  const dt = new Date(ts)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

const baseDateTs = computed(() => ymdToTs(props.baseDate))
const effectiveDateTs = computed(() => ymdToTs(props.effectiveDate))

function onBaseDateChange(ts: number | null) {
  const ymd = tsToYmd(ts)
  emit('update:baseDate', ymd)
  if (!props.isEdit && !props.effectiveDate) {
    emit('update:effectiveDate', ymd)
  }
}

function onEffectiveDateChange(ts: number | null) {
  emit('update:effectiveDate', tsToYmd(ts))
}
</script>
