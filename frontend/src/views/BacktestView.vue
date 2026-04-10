<template>
  <div class="backtest-view">
    <StrategyList
      :strategies="strategies"
      :selected-id="selectedStrategy?.id"
      :running-id="runningId"
      :run-pct="runPct"
      @new="showModal = true"
      @select="onSelectStrategy"
      @run="onRun"
      @result="onResult"
      @delete="onDelete"
    />

    <!-- 回测进度条（当回测运行中） -->
    <div v-if="runningId" class="run-progress-bar">
      <div class="run-progress-fill" :style="{ width: runPct + '%' }"></div>
    </div>

    <!-- 新建策略弹窗 -->
    <StrategyModal
      v-if="showModal"
      :strategy-types="strategyTypes"
      @close="showModal = false"
      @created="onCreated"
    />

    <!-- 结果抽屉 -->
    <ResultDrawer
      :open="drawerOpen"
      :strategy="drawerStrategy"
      @close="drawerOpen = false"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import StrategyList from '../components/backtest/StrategyList.vue'
import StrategyModal from '../components/backtest/StrategyModal.vue'
import ResultDrawer from '../components/backtest/ResultDrawer.vue'
import { api } from '../composables/useApi.js'

const strategies = ref([])
const strategyTypes = ref([])
const showModal = ref(false)
const selectedStrategy = ref(null)
const drawerOpen = ref(false)
const drawerStrategy = ref(null)
const runningId = ref(null)
const runPct = ref(0)

async function loadStrategies() {
  strategies.value = await api.listStrategies()
}

async function onCreated(body) {
  showModal.value = false
  await api.createStrategy(body)
  await loadStrategies()
}

function onSelectStrategy(s) {
  selectedStrategy.value = s
}

async function onDelete(s) {
  if (!confirm(`确认删除策略「${s.name}」？`)) return
  await api.deleteStrategy(s.id)
  await loadStrategies()
}

function onResult(s) {
  drawerStrategy.value = s
  drawerOpen.value = true
}

function onRun(s) {
  if (runningId.value) return
  runningId.value = s.id
  runPct.value = 0

  // POST 触发回测，从响应流中读取 SSE 进度
  fetch(`/api/backtest/${s.id}/run`, { method: 'POST' })
    .then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n'); buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          try {
            const data = JSON.parse(line.slice(5).trim())
            if (data.type === 'progress') runPct.value = data.percent ?? 0
            else if (data.type === 'done') { runningId.value = null; loadStrategies(); return }
            else if (data.type === 'error') { runningId.value = null; alert('回测失败：' + data.message); return }
          } catch { /* ignore */ }
        }
      }
      runningId.value = null
    })
    .catch(e => { runningId.value = null; alert('启动回测失败：' + e.message) })
}

onMounted(async () => {
  const [types] = await Promise.all([api.getStrategyTypes(), loadStrategies()])
  strategyTypes.value = types
})
</script>

<style scoped>
.backtest-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  position: relative;
}
.run-progress-bar {
  height: 3px;
  background: var(--color-border);
  flex-shrink: 0;
}
.run-progress-fill {
  height: 100%;
  background: var(--color-primary);
  transition: width .3s ease;
}
</style>
