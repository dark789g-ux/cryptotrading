<template>
  <div class="settings-view workspace-page workspace-page--narrow">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">系统设置</h1>
    </div>

    <div class="settings-grid">
      <!-- 排除标的管理 -->
      <n-card class="settings-card" title="排除标的（稳定币等）" :bordered="false">
        <p class="card-desc">以下标的将在同步和回测时被排除，不参与策略扫描。</p>
        <n-select
          v-model:value="excludedSymbols"
          multiple
          filterable
          tag
          placeholder="输入或选择要排除的标的..."
          :options="symbolOptions"
          :loading="loadingSymbols"
          max-tag-count="responsive"
          style="margin-bottom: 16px"
        />
        <n-button type="primary" :loading="savingExcluded" @click="saveExcluded">保存</n-button>
        <div class="quick-presets">
          <span class="preset-label">快速添加稳定币：</span>
          <n-button size="small" @click="addStablecoins">添加常见稳定币</n-button>
        </div>
      </n-card>

      <!-- 同步默认配置 -->
      <n-card class="settings-card" title="数据同步默认配置" :bordered="false">
        <n-form label-placement="left" label-width="140px">
          <n-form-item label="默认同步周期">
            <n-checkbox-group v-model:value="syncIntervals">
              <n-space>
                <n-checkbox value="1h" label="1小时" />
                <n-checkbox value="4h" label="4小时" />
                <n-checkbox value="1d" label="日线" />
              </n-space>
            </n-checkbox-group>
          </n-form-item>
          <n-form-item label="">
            <n-button type="primary" :loading="savingSync" @click="saveSyncConfig">保存配置</n-button>
          </n-form-item>
        </n-form>
      </n-card>

      <!-- 关于 -->
      <n-card class="settings-card" title="关于" :bordered="false">
        <n-descriptions :column="1" bordered>
          <n-descriptions-item label="版本">1.0.0</n-descriptions-item>
          <n-descriptions-item label="后端">NestJS + TypeORM + PostgreSQL</n-descriptions-item>
          <n-descriptions-item label="前端">Vue 3 + TypeScript + Naive UI</n-descriptions-item>
          <n-descriptions-item label="回测引擎">MA+KDJ 趋势策略（TypeScript 精确翻译自 Python）</n-descriptions-item>
        </n-descriptions>
      </n-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { settingsApi, symbolApi, syncApi } from '../composables/useApi'

const message = useMessage()

const excludedSymbols = ref<string[]>([])
const savingExcluded = ref(false)
const loadingSymbols = ref(false)
const symbolOptions = ref<{ label: string; value: string }[]>([])

const syncIntervals = ref<string[]>(['1h'])
const savingSync = ref(false)

const STABLECOINS = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'DAIUSDT', 'FRAXUSDT', 'USDPUSDT', 'EURCUSDT', 'EURIUSDT', 'BFUSDUSDT', 'XUSDUSDT', 'USD1USDT']

const loadExcluded = async () => {
  try { excludedSymbols.value = await settingsApi.getExcluded() }
  catch (err: any) { message.error(err.message) }
}

const loadSymbols = async () => {
  loadingSymbols.value = true
  try {
    const names = await symbolApi.getNames('1h')
    symbolOptions.value = names.map((s) => ({ label: s, value: s }))
  } finally { loadingSymbols.value = false }
}

const loadSyncConfig = async () => {
  try {
    const prefs = await syncApi.getPreferences()
    syncIntervals.value = prefs.intervals ?? ['1h']
  } catch { /* ignore */ }
}

const saveExcluded = async () => {
  savingExcluded.value = true
  try {
    await settingsApi.setExcluded(excludedSymbols.value)
    message.success('已保存排除列表')
  } catch (err: any) {
    message.error(err.message)
  } finally {
    savingExcluded.value = false
  }
}

const saveSyncConfig = async () => {
  savingSync.value = true
  try {
    await syncApi.savePreferences({ intervals: syncIntervals.value, symbols: [] })
    message.success('已保存同步配置')
  } catch (err: any) {
    message.error(err.message)
  } finally {
    savingSync.value = false
  }
}

const addStablecoins = () => {
  const existing = new Set(excludedSymbols.value)
  for (const s of STABLECOINS) existing.add(s)
  excludedSymbols.value = [...existing]
}

onMounted(() => {
  loadExcluded()
  loadSymbols()
  loadSyncConfig()
})
</script>

<style scoped>
.settings-view { max-width: 900px; }
.settings-grid { display: flex; flex-direction: column; gap: 24px; }
.card-desc { margin: 0 0 16px; font-size: 14px; color: var(--ember-text-secondary); }
.quick-presets { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.preset-label { font-size: 14px; color: var(--ember-neutral); }
</style>
