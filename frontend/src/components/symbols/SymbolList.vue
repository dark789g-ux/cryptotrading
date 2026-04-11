<template>
  <div class="symbol-list">
    <div class="toolbar">
      <div class="col-settings">
        <span class="tb-label">显示列</span>
        <div class="col-chips">
          <label v-for="col in allColumns" :key="col" class="chip">
            <input
              type="checkbox"
              :checked="visibleFields.includes(col)"
              @change="toggleCol(col, $event.target.checked)"
            />
            {{ col }}
          </label>
        </div>
      </div>
      <div class="pager-settings">
        <span class="tb-label">每页</span>
        <select
          class="form-select page-size"
          :value="pageSize"
          @change="$emit('update:pageSize', Number($event.target.value))"
        >
          <option v-for="n in pageSizeOptions" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th
            v-for="col in tableColumns"
            :key="col.key"
            class="sortable"
            :class="{
              'sort-asc': sortField === col.key && sortAsc,
              'sort-desc': sortField === col.key && !sortAsc,
            }"
            @click="onSort(col.key)"
          >
            {{ col.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in items"
          :key="s.symbol"
          :class="{ selected: s.symbol === selected }"
          @click="$emit('select', s.symbol)"
        >
          <td v-for="col in tableColumns" :key="col.key">{{ formatCell(s[col.key], col.key) }}</td>
        </tr>
        <tr v-if="!items.length">
          <td :colspan="Math.max(1, tableColumns.length)" class="empty">无匹配标的</td>
        </tr>
      </tbody>
    </table>
    <div class="pagination" v-if="totalPages > 1 || total > 0">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="page <= 1"
        @click="$emit('update:page', page - 1)"
      >
        上一页
      </button>
      <span class="page-info">{{ page }} / {{ totalPages }}（共 {{ total }}）</span>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="page >= totalPages"
        @click="$emit('update:page', page + 1)"
      >
        下一页
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  selected: { type: String, default: null },
  sortField: { type: String, default: 'symbol' },
  sortAsc: { type: Boolean, default: true },
  visibleFields: { type: Array, default: () => [] },
  allColumns: { type: Array, default: () => [] },
})

const emit = defineEmits(['select', 'sort', 'update:page', 'update:pageSize', 'update:visibleFields'])

const pageSizeOptions = [20, 50, 100]

const tableColumns = computed(() => {
  const cols = [{ key: 'symbol', label: '交易对' }]
  for (const f of props.visibleFields) {
    cols.push({ key: f, label: f })
  }
  return cols
})

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))

function onSort(key) {
  emit('sort', key)
}

function toggleCol(col, checked) {
  let next
  if (checked) {
    next = [...props.visibleFields, col]
  } else {
    next = props.visibleFields.filter((c) => c !== col)
  }
  emit('update:visibleFields', next)
}

function formatCell(v, key) {
  if (key === 'symbol') return v ?? '-'
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return '-'
  if (typeof v === 'number') return v.toFixed(2)
  return String(v)
}
</script>

<style scoped>
.symbol-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.toolbar {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border-light);
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-start;
  flex-shrink: 0;
}
.tb-label {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  margin-right: 6px;
}
.col-settings {
  flex: 1;
  min-width: 0;
}
.col-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-top: 4px;
  max-height: 88px;
  overflow-y: auto;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  cursor: pointer;
  user-select: none;
}
.chip input {
  width: 13px;
  height: 13px;
}
.pager-settings {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.page-size {
  width: 72px;
  padding: 4px 6px;
  font-size: 0.8rem;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
thead {
  position: sticky;
  top: 0;
  z-index: 1;
}
th {
  background: #f4f6f8;
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
  color: #555;
  cursor: pointer;
  user-select: none;
}
th:hover {
  background: #e8ecf0;
}
th.sortable::after {
  content: '\00a0\2195';
  opacity: 0.45;
  font-size: 0.75em;
}
th.sort-asc::after {
  content: '\00a0\2191';
  opacity: 1;
}
th.sort-desc::after {
  content: '\00a0\2193';
  opacity: 1;
}
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border-light);
}
tr {
  cursor: pointer;
}
tr:hover td {
  background: #f4f6f8;
}
tr.selected td {
  background: #eaf4fd;
}
tr.selected {
  border-left: 3px solid var(--color-primary);
}
.empty {
  color: var(--color-text-secondary);
  font-size: 0.8rem;
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px;
  border-top: 1px solid var(--color-border-light);
  flex-shrink: 0;
}
.page-info {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
</style>
