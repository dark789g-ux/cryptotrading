<template>
  <div class="kdj-params-editor">
    <div class="kdj-params-editor__field">
      <span class="kdj-params-editor__label">N</span>
      <n-input-number
        v-model:value="draft.n"
        :min="ranges.n[0]"
        :max="ranges.n[1]"
        :precision="0"
        size="small"
        class="kdj-params-editor__input"
      />
    </div>

    <div class="kdj-params-editor__field">
      <span class="kdj-params-editor__label">M1</span>
      <n-input-number
        v-model:value="draft.m1"
        :min="ranges.m1[0]"
        :max="ranges.m1[1]"
        :precision="0"
        size="small"
        class="kdj-params-editor__input"
      />
    </div>

    <div class="kdj-params-editor__field">
      <span class="kdj-params-editor__label">M2</span>
      <n-input-number
        v-model:value="draft.m2"
        :min="ranges.m2[0]"
        :max="ranges.m2[1]"
        :precision="0"
        size="small"
        class="kdj-params-editor__input"
      />
    </div>

    <div class="kdj-params-editor__actions">
      <n-button size="small" @click="onCancel">取消</n-button>
      <n-button size="small" type="primary" @click="onConfirm">确定</n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'
import { NButton, NInputNumber } from 'naive-ui'
import type { KdjSubplotParams } from '@/composables/kline/subplotConfig'

const props = defineProps<{
  params?: KdjSubplotParams
  defaultParams: KdjSubplotParams
  ranges: {
    n: readonly [number, number]
    m1: readonly [number, number]
    m2: readonly [number, number]
  }
}>()

const emit = defineEmits<{
  (e: 'confirm', value: KdjSubplotParams): void
  (e: 'cancel'): void
}>()

const draft = reactive<KdjSubplotParams>({ ...(props.params ?? props.defaultParams) })

watch(
  () => props.params,
  (next) => {
    Object.assign(draft, next ?? props.defaultParams)
  },
  { deep: true },
)

function isValidInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value)
}

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
  return value >= min && value <= max
}

function onConfirm(): void {
  if (
    isValidInteger(draft.n) &&
    isValidInteger(draft.m1) &&
    isValidInteger(draft.m2) &&
    inRange(draft.n, props.ranges.n) &&
    inRange(draft.m1, props.ranges.m1) &&
    inRange(draft.m2, props.ranges.m2)
  ) {
    emit('confirm', { n: draft.n, m1: draft.m1, m2: draft.m2 })
  }
}

function onCancel(): void {
  emit('cancel')
}
</script>

<style scoped>
.kdj-params-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 160px;
}

.kdj-params-editor__field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kdj-params-editor__label {
  width: 28px;
  font-size: 12px;
  color: #d0d4dc;
  text-align: right;
}

.kdj-params-editor__input {
  flex: 1 1 auto;
}

.kdj-params-editor__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
