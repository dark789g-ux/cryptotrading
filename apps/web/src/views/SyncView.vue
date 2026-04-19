<template>
  <div class="sync-view">
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
              :loading="sse.status.value === 'running'"
              :disabled="sse.status.value === 'running'"
              @click="startSync"
            >
              <template #icon><n-icon><sync-outline /></n-icon></template>
              {{ sse.status.value === 'running' ? '同步中...' : '开始同步' }}
            </n-button>
          </n-space>
        </n-form>
      </n-card>

      <!-- 同步状态 -->
      <n-card class="status-card" title="同步状态" :bordered="false">
        <div class="status-content">
          <div class="status-icon" :class="sse.status.value">
            <n-icon size="48">
              <checkmark-circle v-if="sse.status.value === 'done'" />
              <close-circle v-else-if="sse.status.value === 'error'" />
              <sync-outline v-else-if="sse.status.value === 'running'" class="spinning" />
              <time-outline v-else />
            </n-icon>
          </div>
          <div class="status-info">
            <h3>{{ statusText }}</h3>
            <p v-if="sse.message.value" class="status-message">{{ sse.message.value }}</p>
          </div>
          <n-progress
            v-if="sse.status.value !== 'idle'"
            type="line"
            :percentage="sse.percent.value"
            indicator-placement="inside"
            :status="sse.status.value === 'error' ? 'error' : sse.status.value === 'done' ? 'success' : 'default'"
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
          <div v-if="!logs.length" class="log-empty">暂无日志</div>
          <div v-for="(log, i) in logs" :key="i" class="log-item" :class="log.type">
            <span class="log-time">{{ log.time }}</span>
            <span class="log-text">{{ log.message }}</span>
          </div>
        </div>
      </n-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useMessage } from 'naive-ui'
import { SyncOutline, CheckmarkCircle, CloseCircle, TimeOutline } from '@vicons/ionicons5'
import { syncApi, symbolApi } from '../composables/useApi'
import { useSSE } from '../composables/useSSE'

const message = useMessage()
const sse = useSSE()

const syncConfig = ref({ symbols: [] as string[], intervals: ['1h'] as string[] })
const symbolMode = ref<'all' | 'custom'>('all')
const symbolOptions = ref<{ label: string; value: string }[]>([])
const loadingSymbols = ref(false)
const saving = ref(false)
const logs = ref<{ type: string; message: string; time: string }[]>([])
const logRef = ref<HTMLElement | null>(null)
const overview = ref({ intervals: ['1h'], symbolCount: 0, lastSync: '' })

const statusText = computed(() => ({
  idle: '等待同步', running: '同步进行中', done: '同步完成', error: '同步失败',
}[sse.status.value] || '未知'))

const addLog = (type: string, msg: string) => {
  logs.value.push({ type, message: msg, time: new Date().toLocaleTimeString() })
  nextTick(() => { if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight })
}

const loadConfig = async () => {
  try {
    const prefs = await syncApi.getPreferences()
    syncConfig.value = { symbols: prefs.symbols || [], intervals: prefs.intervals || ['1h'] }
    symbolMode.value = prefs.symbols?.length ? 'custom' : 'all'
    overview.value.intervals = syncConfig.value.intervals
  } catch (err) { console.error('加载配置失败:', err) }
}

const loadSymbols = async () => {
  loadingSymbols.value = true
  try {
    const names = await symbolApi.getNames('1d')
    symbolOptions.value = names.map((s) => ({ label: s, value: s }))
    overview.value.symbolCount = symbolMode.value === 'all' ? names.length : syncConfig.value.symbols.length
  } finally { loadingSymbols.value = false }
}

const saveConfig = async () => {
  saving.value = true
  try {
    await syncApi.savePreferences({
      intervals: syncConfig.value.intervals,
      symbols: symbolMode.value === 'custom' ? syncConfig.value.symbols : [],
    })
    message.success('配置已保存')
    overview.value.intervals = syncConfig.value.intervals
  } catch (err: any) { message.error(err.message) }
  finally { saving.value = false }
}

const startSync = async () => {
  await saveConfig()
  logs.value = []
  addLog('info', '开始数据同步...')
  sse.start('/api/sync/run', {
    method: 'GET',
    onDone: () => {
      overview.value.lastSync = new Date().toLocaleString()
      addLog('success', '数据同步完成')
      message.success('同步完成')
    },
    onError: (msg) => {
      addLog('error', msg)
      message.error(msg)
    },
  })

  // watch sse phase/message to add to log
  const stopWatch = watch([sse.phase, sse.current], ([ph, cur]) => {
    if (ph && cur > 0 && sse.status.value === 'running') {
      addLog('info', `${ph}: ${sse.current.value}/${sse.total.value}`)
    }
  })
  watch(sse.status, (s) => { if (s !== 'running') stopWatch() })
}

watch(symbolMode, (val) => {
  overview.value.symbolCount = val === 'all' ? symbolOptions.value.length : syncConfig.value.symbols.length
})

onMounted(() => { loadConfig(); loadSymbols() })
</script>

<style scoped>
.sync-view { max-width: 1000px; margin: 0 auto; }
.page-header { margin-bottom: 24px; }
.page-title { font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; color: var(--ember-text); margin: 0; }
.sync-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.config-card { grid-column: 1 / 2; grid-row: 1 / 3; }
.status-card { grid-column: 2 / 3; }
.overview-card { grid-column: 2 / 3; }
.log-card { grid-column: 1 / 3; }
.status-content { display: flex; flex-direction: column; align-items: center; padding: 20px; }
.status-icon {
  width: 80px; height: 80px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; margin-bottom: 16px;
}
.status-icon.idle { background: rgba(168, 162, 158, 0.15); color: var(--ember-neutral); }
.status-icon.running { background: rgba(194, 65, 12, 0.12); color: var(--ember-primary); }
.status-icon.done { background: rgba(22, 163, 74, 0.12); color: var(--color-success); }
.status-icon.error { background: rgba(220, 38, 38, 0.12); color: var(--color-error); }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.status-info { text-align: center; margin-bottom: 20px; }
.status-info h3 { margin: 0 0 8px; font-size: 18px; font-weight: 600; color: var(--ember-text); }
.status-message { margin: 0; color: var(--ember-text-secondary); font-size: 14px; }
.sync-progress { width: 100%; }
.overview-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.overview-item { text-align: center; padding: 16px; background: var(--ember-surface); border-radius: 12px; border: 1px solid var(--ember-border); }
.overview-value { font-family: 'Playfair Display', Georgia, serif; font-size: 18px; font-weight: 700; color: var(--ember-text); margin-bottom: 4px; }
.overview-label { font-size: 12px; color: var(--ember-text-secondary); }
.log-container { height: 200px; overflow-y: auto; background: var(--ember-surface); border-radius: 12px; padding: 12px; font-family: 'Fira Code', Consolas, monospace; font-size: 13px; }
.log-empty { text-align: center; color: var(--ember-neutral); padding: 40px; }
.log-item { padding: 4px 0; border-bottom: 1px solid var(--ember-border); }
.log-item:last-child { border-bottom: none; }
.log-time { color: var(--ember-neutral); margin-right: 12px; }
.log-item.success .log-text { color: var(--color-success); }
.log-item.error .log-text { color: var(--color-error); }
</style>
