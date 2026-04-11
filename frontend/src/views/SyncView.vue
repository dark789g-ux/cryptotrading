<template>
  <div class="sync-view">
    <!-- 页面标题 -->
    <div class="page-header">
      <h1 class="page-title">数据同步</h1>
    </div>

    <div class="sync-grid">
      <!-- 同步配置 -->
      <n-card class="config-card" title="同步配置" :bordered="false">
        <n-form label-placement="top">
          <n-form-item label="时间周期">
            <n-checkbox-group v-model:value="syncConfig.intervals">
              <n-space>
                <n-checkbox value="1h" label="1小时" />
                <n-checkbox value="4h" label="4小时" />
                <n-checkbox value="1d" label="日线" />
              </n-space>
            </n-checkbox-group>
          </n-form-item>

          <n-form-item label="标的筛选">
            <n-radio-group v-model:value="symbolMode" class="symbol-mode">
              <n-radio-button value="all">全部标的</n-radio-button>
              <n-radio-button value="custom">自定义</n-radio-button>
            </n-radio-group>
          </n-form-item>

          <n-form-item v-if="symbolMode === 'custom'" label="选择标的">
            <n-select
              v-model:value="syncConfig.symbols"
              multiple
              filterable
              placeholder="搜索并选择标的"
              :options="symbolOptions"
              :loading="loadingSymbols"
              max-tag-count="responsive"
              style="width: 100%"
            />
          </n-form-item>

          <n-space justify="end">
            <n-button @click="saveConfig" :loading="saving">保存配置</n-button>
            <n-button
              type="primary"
              :loading="isSyncing"
              :disabled="isSyncing"
              @click="startSync"
            >
              <template #icon>
                <n-icon><sync-outline /></n-icon>
              </template>
              {{ isSyncing ? '同步中...' : '开始同步' }}
            </n-button>
          </n-space>
        </n-form>
      </n-card>

      <!-- 同步状态 -->
      <n-card class="status-card" title="同步状态" :bordered="false">
        <div class="status-content">
          <div class="status-icon" :class="syncStatus">
            <n-icon size="48">
              <checkmark-circle v-if="syncStatus === 'done'" />
              <close-circle v-else-if="syncStatus === 'error'" />
              <sync-outline v-else-if="isSyncing" class="spinning" />
              <time-outline v-else />
            </n-icon>
          </div>
          
          <div class="status-info">
            <h3>{{ statusText }}</h3>
            <p v-if="syncMessage" class="status-message">{{ syncMessage }}</p>
          </div>

          <n-progress
            v-if="isSyncing || syncStatus === 'done'"
            type="line"
            :percentage="syncProgress"
            :indicator-placement="'inside'"
            :status="syncStatus === 'error' ? 'error' : syncStatus === 'done' ? 'success' : 'default'"
            class="sync-progress"
          />
        </div>
      </n-card>

      <!-- 数据概览 -->
      <n-card class="overview-card" title="数据概览" :bordered="false">
        <div class="overview-grid">
          <div class="overview-item">
            <div class="overview-value">{{ overview.intervals.join(', ') || '-' }}</div>
            <div class="overview-label">已选周期</div>
          </div>
          <div class="overview-item">
            <div class="overview-value">{{ overview.symbolCount }}</div>
            <div class="overview-label">标的数量</div>
          </div>
          <div class="overview-item">
            <div class="overview-value">{{ overview.lastSync || '-' }}</div>
            <div class="overview-label">上次同步</div>
          </div>
        </div>
      </n-card>

      <!-- 同步日志 -->
      <n-card class="log-card" title="同步日志" :bordered="false">
        <div ref="logRef" class="log-container">
          <div v-if="logs.length === 0" class="log-empty">
            暂无日志
          </div>
          <div
            v-for="(log, i) in logs"
            :key="i"
            class="log-item"
            :class="log.type"
          >
            <span class="log-time">{{ log.time }}</span>
            <span class="log-text">{{ log.message }}</span>
          </div>
        </div>
      </n-card>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useMessage } from 'naive-ui'
import {
  NCard, NForm, NFormItem, NCheckboxGroup, NCheckbox, NSpace,
  NRadioGroup, NRadioButton, NSelect, NButton, NIcon, NProgress
} from 'naive-ui'
import { SyncOutline, CheckmarkCircle, CloseCircle, TimeOutline } from '@vicons/ionicons5'

const message = useMessage()

// 状态
const syncConfig = ref({
  symbols: [],
  intervals: ['1h']
})
const symbolMode = ref('all')
const symbolOptions = ref([])
const loadingSymbols = ref(false)
const saving = ref(false)

const isSyncing = ref(false)
const syncStatus = ref('idle') // idle, running, done, error
const syncProgress = ref(0)
const syncMessage = ref('')
const syncPhase = ref('')

const logs = ref([])
const logRef = ref(null)

const overview = ref({
  intervals: ['1h'],
  symbolCount: 0,
  lastSync: null
})

// 状态文本
const statusText = computed(() => {
  const map = {
    idle: '等待同步',
    running: '同步进行中',
    done: '同步完成',
    error: '同步失败'
  }
  return map[syncStatus.value] || '未知'
})

// 加载配置
const loadConfig = async () => {
  try {
    const res = await fetch('/api/sync/preferences')
    const prefs = await res.json()
    syncConfig.value = {
      symbols: prefs.symbols || [],
      intervals: prefs.intervals || ['1h']
    }
    symbolMode.value = (prefs.symbols && prefs.symbols.length > 0) ? 'custom' : 'all'
    overview.value.intervals = syncConfig.value.intervals
  } catch (err) {
    console.error('加载配置失败:', err)
  }
}

// 加载标的列表
const loadSymbols = async () => {
  loadingSymbols.value = true
  try {
    const res = await fetch('/api/symbols/names?interval=1d')
    const symbols = await res.json()
    symbolOptions.value = symbols.map(s => ({ label: s, value: s }))
    overview.value.symbolCount = symbolMode.value === 'all' ? symbols.length : syncConfig.value.symbols.length
  } catch (err) {
    console.error('加载标的失败:', err)
  } finally {
    loadingSymbols.value = false
  }
}

// 保存配置
const saveConfig = async () => {
  saving.value = true
  try {
    const payload = {
      intervals: syncConfig.value.intervals,
      symbols: symbolMode.value === 'custom' ? syncConfig.value.symbols : []
    }
    
    const res = await fetch('/api/sync/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    
    if (res.ok) {
      message.success('配置已保存')
      overview.value.intervals = payload.intervals
      overview.value.symbolCount = payload.symbols.length || symbolOptions.value.length
    } else {
      throw new Error('保存失败')
    }
  } catch (err) {
    message.error(err.message)
  } finally {
    saving.value = false
  }
}

// 添加日志
const addLog = (type, message) => {
  logs.value.push({
    type,
    message,
    time: new Date().toLocaleTimeString()
  })
  nextTick(() => {
    if (logRef.value) {
      logRef.value.scrollTop = logRef.value.scrollHeight
    }
  })
}

// 开始同步
const startSync = async () => {
  if (isSyncing.value) return
  
  // 先保存配置
  await saveConfig()
  
  isSyncing.value = true
  syncStatus.value = 'running'
  syncProgress.value = 0
  syncMessage.value = '准备同步...'
  logs.value = []
  
  addLog('info', '开始数据同步...')
  
  const es = new EventSource('/api/sync/run', { method: 'POST' })
  
  es.onmessage = (event) => {
    const data = JSON.parse(event.data)
    
    switch (data.type) {
      case 'start':
        addLog('info', '同步开始')
        break
      case 'progress':
        syncProgress.value = Math.round(data.percent)
        syncPhase.value = data.phase
        syncMessage.value = data.message
        if (data.phase && data.current > 0) {
          addLog('info', `${data.phase}: ${data.current}/${data.total}`)
        }
        break
      case 'done':
        syncStatus.value = 'done'
        syncProgress.value = 100
        syncMessage.value = '同步完成'
        isSyncing.value = false
        overview.value.lastSync = new Date().toLocaleString()
        addLog('success', '数据同步完成')
        message.success('同步完成')
        es.close()
        break
      case 'error':
        syncStatus.value = 'error'
        syncMessage.value = data.message
        isSyncing.value = false
        addLog('error', data.message)
        message.error(data.message)
        es.close()
        break
    }
  }
  
  es.onerror = () => {
    if (isSyncing.value) {
      syncStatus.value = 'error'
      syncMessage.value = '连接中断'
      isSyncing.value = false
      addLog('error', '连接中断')
    }
    es.close()
  }
}

// 监听模式变化
watch(symbolMode, (val) => {
  if (val === 'all') {
    syncConfig.value.symbols = []
    overview.value.symbolCount = symbolOptions.value.length
  } else {
    overview.value.symbolCount = syncConfig.value.symbols.length
  }
})

watch(() => syncConfig.value.symbols, (val) => {
  if (symbolMode.value === 'custom') {
    overview.value.symbolCount = val.length
  }
})

onMounted(() => {
  loadConfig()
  loadSymbols()
})
</script>

<style scoped>
.sync-view {
  max-width: 1000px;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.sync-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.config-card {
  grid-column: 1 / 2;
  grid-row: 1 / 3;
}

.status-card {
  grid-column: 2 / 3;
}

.overview-card {
  grid-column: 2 / 3;
}

.log-card {
  grid-column: 1 / 3;
}

.status-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px;
}

.status-icon {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.status-icon.idle {
  background: rgba(148, 163, 184, 0.2);
  color: #94a3b8;
}

.status-icon.running {
  background: rgba(59, 130, 246, 0.2);
  color: #3b82f6;
}

.status-icon.done {
  background: rgba(16, 185, 129, 0.2);
  color: #10b981;
}

.status-icon.error {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.status-info {
  text-align: center;
  margin-bottom: 20px;
}

.status-info h3 {
  margin: 0 0 8px;
  font-size: 18px;
  color: var(--text-primary);
}

.status-message {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
}

.sync-progress {
  width: 100%;
}

.symbol-mode {
  width: 100%;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.overview-item {
  text-align: center;
  padding: 16px;
  background: var(--glass-bg);
  border-radius: 12px;
  border: 1px solid var(--glass-border);
}

.overview-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.overview-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.log-container {
  height: 200px;
  overflow-y: auto;
  background: var(--glass-bg);
  border-radius: 12px;
  padding: 12px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
}

.log-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 40px;
}

.log-item {
  padding: 4px 0;
  border-bottom: 1px solid var(--glass-border);
}

.log-item:last-child {
  border-bottom: none;
}

.log-time {
  color: var(--text-muted);
  margin-right: 12px;
}

.log-item.success .log-text {
  color: var(--color-success);
}

.log-item.error .log-text {
  color: var(--color-error);
}
</style>
