<template>
  <div class="filter-bar">
    <div class="filter-row">
      <label class="filter-label">周期</label>
      <select class="form-select" :value="interval" @change="$emit('update:interval', $event.target.value)">
        <option v-for="iv in intervals" :key="iv.id" :value="iv.id">{{ iv.name }}</option>
      </select>
    </div>
    <div class="filter-row">
      <label class="filter-label">策略</label>
      <select class="form-select" :value="strategy" @change="$emit('update:strategy', $event.target.value)">
        <option v-for="s in filterStrategies" :key="s.id" :value="s.id">{{ s.name }}</option>
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
    <button class="btn btn-ghost btn-sm reset-btn" @click="$emit('reset')">重置</button>
  </div>
</template>

<script setup>
defineProps({
  intervals: Array,
  filterStrategies: Array,
  interval: String,
  strategy: String,
  search: String,
})
defineEmits(['update:interval', 'update:strategy', 'update:search', 'reset'])
</script>

<style scoped>
.filter-bar {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  display: flex; flex-direction: column; gap: 8px;
}
.filter-row {
  display: flex; align-items: center; gap: 8px;
}
.filter-label {
  font-size: .75rem; color: var(--color-text-secondary);
  min-width: 36px; flex-shrink: 0;
}
.filter-row .form-select,
.filter-row .form-input {
  flex: 1; padding: 5px 8px; font-size: .82rem;
}
.reset-btn { align-self: flex-end; }
</style>
