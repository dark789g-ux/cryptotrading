<template>
  <div class="filter-bar">
    <div class="filter-row">
      <label class="filter-label">周期</label>
      <select
        class="form-select"
        :value="interval"
        @change="$emit('update:interval', $event.target.value)"
      >
        <option v-for="iv in intervals" :key="iv.id" :value="iv.id">{{ iv.name }}</option>
      </select>
    </div>
    <div class="filter-row">
      <label class="filter-label">搜索</label>
      <input
        class="form-input"
        type="text"
        :value="search"
        placeholder="输入交易对…"
        @input="$emit('update:search', $event.target.value)"
      />
    </div>
    <div class="advanced-block">
      <div class="advanced-title">高级检索（指标 AND，最多10 条）</div>
      <div v-for="(c, idx) in conditions" :key="idx" class="condition-row">
        <select
          class="form-select cond-field"
          :value="c.field"
          @change="patchCond(idx, { field: $event.target.value })"
        >
          <option v-if="!columnOptions.length" value="">无列名</option>
          <option v-for="col in columnOptions" :key="col" :value="col">{{ col }}</option>
        </select>
        <select
          class="form-select cond-op"
          :value="c.op"
          @change="patchCond(idx, { op: $event.target.value })"
        >
          <option v-for="o in opOptions" :key="o.v" :value="o.v">{{ o.label }}</option>
        </select>
        <input
          class="form-input cond-val"
          type="number"
          step="any"
          :value="c.value"
          @input="onValInput(idx, $event)"
        />
        <button type="button" class="btn btn-ghost btn-sm rm-btn" @click="removeCond(idx)">删</button>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-sm add-cond"
        :disabled="conditions.length >= 10 || !columnOptions.length"
        @click="addCond"
      >
        添加条件
      </button>
    </div>
    <div class="actions">
      <button type="button" class="btn btn-primary btn-sm" @click="$emit('search')">搜索</button>
      <button type="button" class="btn btn-ghost btn-sm" @click="$emit('reset')">重置</button>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  intervals: Array,
  interval: String,
  search: String,
  conditions: { type: Array, default: () => [] },
  columnOptions: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:interval', 'update:search', 'update:conditions', 'search', 'reset'])

const opOptions = [
  { v: 'lt', label: '<' },
  { v: 'lte', label: '≤' },
  { v: 'gt', label: '>' },
  { v: 'gte', label: '≥' },
  { v: 'eq', label: '=' },
  { v: 'neq', label: '≠' },
]

function patchCond(idx, part) {
  const next = props.conditions.map((row, i) => (i === idx ? { ...row, ...part } : row))
  emit('update:conditions', next)
}

function onValInput(idx, e) {
  const raw = e.target.value
  const num = raw === '' || raw === '-' ? 0 : Number(raw)
  patchCond(idx, { value: Number.isFinite(num) ? num : 0 })
}

function removeCond(idx) {
  emit(
    'update:conditions',
    props.conditions.filter((_, i) => i !== idx),
  )
}

function addCond() {
  const first = props.columnOptions[0] || ''
  emit('update:conditions', [
    ...props.conditions,
    { field: first, op: 'lt', value: 0 },
  ])
}
</script>

<style scoped>
.filter-bar {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  min-width: 36px;
  flex-shrink: 0;
}
.filter-row .form-select,
.filter-row .form-input {
  flex: 1;
  padding: 5px 8px;
  font-size: 0.82rem;
}
.advanced-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}
.advanced-title {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
}
.condition-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cond-field {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  font-size: 0.78rem;
}
.cond-op {
  width: 52px;
  flex-shrink: 0;
  padding: 4px 4px;
  font-size: 0.75rem;
}
.cond-val {
  width: 72px;
  flex-shrink: 0;
  padding: 4px 6px;
  font-size: 0.78rem;
}
.rm-btn {
  flex-shrink: 0;
  padding: 2px 6px;
}
.add-cond {
  align-self: flex-start;
}
.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 4px;
}
</style>
