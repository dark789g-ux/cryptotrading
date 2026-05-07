<template>
  <div class="flow-date-control">
    <div class="mode-toggle">
      <button
        class="mode-btn"
        :class="{ active: mode === 'single' }"
        @click="setMode('single')"
      >单日</button>
      <button
        class="mode-btn"
        :class="{ active: mode === 'range' }"
        @click="setMode('range')"
      >区间</button>
    </div>

    <n-date-picker
      v-if="mode === 'single'"
      :value="singleDateTs"
      type="date"
      format="yyyyMMdd"
      :is-date-disabled="isFutureDate"
      @update:value="onSingleChange"
    />
    <n-date-picker
      v-else
      :value="rangeDateTs"
      type="daterange"
      format="yyyyMMdd"
      :is-date-disabled="isFutureDate"
      @update:value="onRangeChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NDatePicker } from 'naive-ui'

type DateMode = 'single' | 'range'

const emit = defineEmits<{
  change: [params: { trade_date?: string; start_date?: string; end_date?: string }]
}>()

const mode = ref<DateMode>('single')

function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

const todayTs = Date.now()
const singleDateTs = ref<number | null>(todayTs)
const rangeDateTs = ref<[number, number] | null>(null)

const singleYYYYMMDD = computed(() => singleDateTs.value ? toYYYYMMDD(singleDateTs.value) : '')

function isFutureDate(ts: number) {
  return ts > Date.now()
}

function setMode(m: DateMode) {
  mode.value = m
  emitCurrent()
}

function onSingleChange(ts: number | null) {
  singleDateTs.value = ts
  if (ts) emit('change', { trade_date: toYYYYMMDD(ts) })
}

function onRangeChange(ts: [number, number] | null) {
  rangeDateTs.value = ts
  if (ts) emit('change', { start_date: toYYYYMMDD(ts[0]), end_date: toYYYYMMDD(ts[1]) })
}

function emitCurrent() {
  if (mode.value === 'single' && singleDateTs.value) {
    emit('change', { trade_date: toYYYYMMDD(singleDateTs.value) })
  } else if (mode.value === 'range' && rangeDateTs.value) {
    emit('change', { start_date: toYYYYMMDD(rangeDateTs.value[0]), end_date: toYYYYMMDD(rangeDateTs.value[1]) })
  }
}

emitCurrent()
</script>

<style scoped>
.flow-date-control {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mode-toggle {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}
.mode-btn {
  padding: 5px 14px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.mode-btn.active {
  background: var(--color-primary);
  color: #fff;
}
</style>
