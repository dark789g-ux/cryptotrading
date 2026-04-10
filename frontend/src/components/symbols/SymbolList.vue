<template>
  <div class="symbol-list">
    <table>
      <thead>
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            class="sortable"
            :class="{ 'sort-asc': sort.col === col.key && sort.asc, 'sort-desc': sort.col === col.key && !sort.asc }"
            @click="onSort(col.key)"
          >{{ col.label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in visible"
          :key="s.symbol"
          :class="{ selected: s.symbol === selected }"
          @click="$emit('select', s.symbol)"
        >
          <td>{{ s.symbol }}</td>
          <td>{{ fmt(s.stop_loss_pct, '%') }}</td>
          <td>{{ fmt(s.risk_reward_ratio) }}</td>
        </tr>
        <tr v-if="!visible.length">
          <td colspan="3" class="empty">无匹配标的</td>
        </tr>
        <tr v-if="symbols.length > MAX_VISIBLE">
          <td colspan="3" class="hint">仅显示前 {{ MAX_VISIBLE }} 个，请缩小搜索范围</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  symbols: { type: Array, default: () => [] },
  selected: { type: String, default: null },
})
defineEmits(['select'])

const MAX_VISIBLE = 500
const columns = [
  { key: 'symbol', label: '交易对' },
  { key: 'stop_loss_pct', label: 'stop_loss_pct' },
  { key: 'risk_reward_ratio', label: 'risk_reward_ratio' },
]
const sort = ref({ col: 'symbol', asc: true })

function onSort(col) {
  if (sort.value.col === col) sort.value.asc = !sort.value.asc
  else { sort.value.col = col; sort.value.asc = true }
}

const visible = computed(() => {
  const { col, asc } = sort.value
  const arr = [...props.symbols].sort((a, b) => {
    let va = a[col], vb = b[col]
    if (col === 'symbol') {
      va = (va || '').toLowerCase(); vb = (vb || '').toLowerCase()
      return asc ? (va < vb ? -1 : va > vb ? 1 : 0) : (vb < va ? -1 : vb > va ? 1 : 0)
    }
    va = va != null && !isNaN(va) ? +va : -Infinity
    vb = vb != null && !isNaN(vb) ? +vb : -Infinity
    return asc ? va - vb : vb - va
  })
  return arr.slice(0, MAX_VISIBLE)
})

function fmt(v, suffix = '') {
  if (v == null || isNaN(v)) return '-'
  return (+v).toFixed(2) + suffix
}
</script>

<style scoped>
.symbol-list { flex: 1; overflow-y: auto; }
table { width: 100%; border-collapse: collapse; font-size: .82rem; }
thead { position: sticky; top: 0; z-index: 1; }
th {
  background: #f4f6f8; padding: 8px 10px;
  text-align: left; font-weight: 600; color: #555;
  cursor: pointer; user-select: none;
}
th:hover { background: #e8ecf0; }
th.sortable::after { content: ' ↕'; opacity: .45; font-size: .75em; }
th.sort-asc::after  { content: ' ↑'; opacity: 1; }
th.sort-desc::after { content: ' ↓'; opacity: 1; }
td { padding: 6px 10px; border-bottom: 1px solid var(--color-border-light); }
tr { cursor: pointer; }
tr:hover td { background: #f4f6f8; }
tr.selected td { background: #eaf4fd; }
tr.selected { border-left: 3px solid var(--color-primary); }
.empty, .hint { color: var(--color-text-secondary); font-size: .8rem; }
</style>
