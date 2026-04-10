<template>
  <div class="symbols-view">
    <!-- 左侧：过滤栏 + 标的列表 -->
    <aside class="symbols-sidebar">
      <FilterBar
        v-model:interval="interval"
        v-model:strategy="strategy"
        v-model:search="search"
        :intervals="intervals"
        :filterStrategies="filterStrategies"
        @reset="onReset"
        @update:interval="onIntervalChange"
        @update:strategy="loadSymbols"
      />
      <div v-if="loading" class="list-loading">加载中…</div>
      <SymbolList
        v-else
        :symbols="filtered"
        :selected="selectedSymbol"
        @select="onSelect"
      />
    </aside>

    <!-- 右侧：K 线图 -->
    <SymbolChart :symbol="selectedSymbol" :interval="interval" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import FilterBar from '../components/symbols/FilterBar.vue'
import SymbolList from '../components/symbols/SymbolList.vue'
import SymbolChart from '../components/symbols/SymbolChart.vue'
import { api } from '../composables/useApi.js'

const intervals = ref([])
const filterStrategies = ref([])
const allSymbols = ref([])
const loading = ref(false)
const interval = ref('1d')
const strategy = ref('')
const search = ref('')
const selectedSymbol = ref(null)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return allSymbols.value
  return allSymbols.value.filter(s => s.symbol.toLowerCase().includes(q))
})

async function loadSymbols() {
  loading.value = true
  try {
    allSymbols.value = await api.getSymbols(interval.value, strategy.value)
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

async function onIntervalChange() {
  const prev = selectedSymbol.value
  await loadSymbols()
  // 切换周期后如果原标的仍在列表中，保持选中
  if (prev && !allSymbols.value.find(s => s.symbol === prev)) {
    selectedSymbol.value = null
  }
}

function onSelect(symbol) {
  selectedSymbol.value = symbol
}

function onReset() {
  interval.value = '1d'
  strategy.value = ''
  search.value = ''
  loadSymbols()
}

onMounted(async () => {
  const [ivs, fss] = await Promise.all([api.getIntervals(), api.getFilterStrategies()])
  intervals.value = ivs
  filterStrategies.value = fss
  await loadSymbols()
})
</script>

<style scoped>
.symbols-view {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: #fff;
}
.symbols-sidebar {
  width: 280px; flex-shrink: 0;
  display: flex; flex-direction: column;
  border-right: 1px solid var(--color-border);
}
.list-loading {
  padding: 24px; text-align: center;
  color: var(--color-text-secondary);
}
</style>
