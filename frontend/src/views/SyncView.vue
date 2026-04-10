<template>
  <div class="sync-view">
    <div class="sync-header">
      <h2>数据同步</h2>
      <button class="btn btn-primary" :disabled="sse.status.value === 'running'" @click="onSync">
        <RefreshCw :size="16" :class="{ spin: sse.status.value === 'running' }" />
        {{ sse.status.value === 'running' ? '同步中…' : '开始同步' }}
      </button>
    </div>

    <!-- 进度区 -->
    <div v-if="sse.status.value !== 'idle'" class="sync-progress card">
      <div class="progress-phase">
        {{ sse.phase.value || sse.message.value }}
        <span v-if="sse.total.value > 0" class="progress-count">
          {{ sse.current.value }}/{{ sse.total.value }}
        </span>
      </div>
      <div class="progress-bar" style="margin-top:8px">
        <div class="progress-fill"
          :class="{ done: sse.status.value==='done', error: sse.status.value==='error' }"
          :style="{ width: sse.percent.value + '%' }">
        </div>
      </div>
      <div class="progress-msg" :class="sse.status.value">
        {{ statusLabel }}
      </div>
    </div>

    <div class="sync-body">
      <!-- 时间框架选择 -->
      <div class="card prefs-card">
        <div class="prefs-title">时间框架</div>
        <div class="interval-options">
          <label v-for="iv in availableIntervals" :key="iv.id" class="checkbox-label">
            <input type="checkbox" :value="iv.id" v-model="selectedIntervals" @change="savePrefs" />
            {{ iv.name }}
          </label>
        </div>
      </div>

      <!-- 标的选择 -->
      <div class="card symbols-card">
        <div class="symbols-toolbar">
          <div class="prefs-title">交易对选择</div>
          <div class="toolbar-actions">
            <input class="form-input search-input" v-model="search" placeholder="搜索…" />
            <button class="btn btn-ghost btn-sm" @click="selectAll">全选</button>
            <button class="btn btn-ghost btn-sm" @click="clearAll">清空</button>
            <span class="count-hint">已选 {{ selectedSymbols.length }}/{{ filteredSymbols.length }}</span>
          </div>
        </div>
        <div class="symbol-grid">
          <label
            v-for="sym in filteredSymbols"
            :key="sym"
            class="sym-checkbox"
            :class="{ checked: selectedSymbols.includes(sym) }"
          >
            <input type="checkbox" :value="sym" v-model="selectedSymbols" @change="savePrefs" />
            {{ sym }}
          </label>
        </div>
        <div v-if="loadingSymbols" class="sym-loading">加载标的列表…</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import { useSSE } from '../composables/useSSE.js'
import { api } from '../composables/useApi.js'

const sse = useSSE()
const availableIntervals = [
  { id: '1h', name: '1 小时' },
  { id: '4h', name: '4 小时' },
  { id: '1d', name: '日线' },
]

const selectedIntervals = ref(['1h'])
const allSymbols = ref([])
const selectedSymbols = ref([])
const search = ref('')
const loadingSymbols = ref(false)

const filteredSymbols = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return allSymbols.value
  return allSymbols.value.filter(s => s.toLowerCase().includes(q))
})

const statusLabel = computed(() => {
  const s = sse.status.value
  if (s === 'running') return sse.message.value || '同步中…'
  if (s === 'done') return '同步完成'
  if (s === 'error') return '同步失败：' + sse.message.value
  return ''
})

async function savePrefs() {
  await api.saveSyncPreferences({
    symbols: selectedSymbols.value,
    intervals: selectedIntervals.value,
  })
}

function selectAll() {
  selectedSymbols.value = [...filteredSymbols.value]
  savePrefs()
}
function clearAll() {
  selectedSymbols.value = []
  savePrefs()
}

function onSync() {
  sse.start('/api/sync/run')
}

onMounted(async () => {
  // 加载用户偏好
  try {
    const prefs = await api.getSyncPreferences()
    selectedIntervals.value = prefs.intervals || ['1h']
    selectedSymbols.value = prefs.symbols || []
  } catch { /* ignore */ }

  // 加载标的列表（从 1d 目录扫描）
  loadingSymbols.value = true
  try {
    const syms = await api.getSymbols('1d', '')
    allSymbols.value = syms.map(s => s.symbol).sort()
  } catch { /* ignore */ } finally {
    loadingSymbols.value = false
  }
})
</script>

<style scoped>
.sync-view { height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
.sync-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px; border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.sync-header h2 { font-size: 1.2rem; }
.sync-progress {
  margin: 16px 24px 0;
}
.progress-phase {
  display: flex; align-items: center; justify-content: space-between;
  font-size: .9rem; color: var(--color-text);
}
.progress-count { font-size: .8rem; color: var(--color-text-secondary); }
.progress-msg { font-size: .82rem; margin-top: 6px; }
.progress-msg.done { color: var(--color-success); }
.progress-msg.error { color: var(--color-danger); }
.progress-msg.running { color: var(--color-text-secondary); }
.sync-body { display: flex; flex-direction: column; gap: 16px; padding: 16px 24px; flex: 1; }
.prefs-title { font-size: .9rem; font-weight: 600; margin-bottom: 10px; }
.interval-options { display: flex; gap: 20px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: .9rem; }
.checkbox-label input { width: 15px; height: 15px; }
.symbols-card { flex: 1; display: flex; flex-direction: column; }
.symbols-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.toolbar-actions { display: flex; align-items: center; gap: 8px; }
.search-input { width: 160px; padding: 5px 8px; font-size: .82rem; }
.count-hint { font-size: .8rem; color: var(--color-text-secondary); }
.symbol-grid {
  display: flex; flex-wrap: wrap; gap: 6px;
  max-height: 400px; overflow-y: auto;
}
.sym-checkbox {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--color-border);
  border-radius: 20px; cursor: pointer; font-size: .8rem;
  transition: all var(--transition);
}
.sym-checkbox input { display: none; }
.sym-checkbox.checked { background: var(--color-primary); color: #fff; border-color: var(--color-primary); }
.sym-checkbox:not(.checked):hover { border-color: var(--color-primary); color: var(--color-primary); }
.sym-loading { padding: 16px; text-align: center; color: var(--color-text-secondary); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
