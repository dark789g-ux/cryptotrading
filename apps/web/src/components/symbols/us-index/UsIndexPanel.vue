<template>
  <div class="us-index-panel">
    <div class="panel-header">
      <div class="header-left">
        <span class="field-label">指数</span>
        <n-select
          v-model:value="selectedIndex"
          :options="indexOptions"
          class="index-select"
        />
      </div>
      <n-button :loading="syncing" @click="handleSync">
        <template #icon><n-icon><cloud-download-outline /></n-icon></template>
        同步指数数据
      </n-button>
    </div>

    <kline-chart
      ref="klineRef"
      :data="bars"
      :available-subplots="availableSubplots"
      prefs-key="us-index"
      :height="'640px'"
      show-toolbar
    />

    <us-sync-progress-modal
      v-model:show="showSyncProgress"
      :job-id="syncJobId"
      subject="美股指数数据"
      @done="handleSyncDone"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'UsIndexPanel' })

import { onActivated, onMounted, ref, watch } from 'vue'
import { NButton, NIcon, NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { CloudDownloadOutline } from '@vicons/ionicons5'
import KlineChart from '../../kline/KlineChart.vue'
import UsSyncProgressModal from '../us-stocks/UsSyncProgressModal.vue'
import { usIndexDailyApi } from '@/api/modules/market/usIndexDaily'
import { usIndexAmvApi } from '@/api/modules/market/usIndexAmv'
import type { AmvSeriesRow } from '@/api/modules/market/active-mv'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import type { JobStatus } from '@/api/modules/quant'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { mergeKlineWithAmv } from '@/composables/kline/mergeAmv'

interface IndexOption extends SelectOption {
  label: string
  value: string
}

// v1 single index; P2 adds .IXIC/.DJI/.INX by appending options.
const indexOptions: IndexOption[] = [{ label: '纳斯达克100', value: '.NDX' }]

// us index K line: basic technical subplots + AMV (活跃市值, 复用 0AMV/0AMV_MACD 渲染键).
const availableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', '0AMV', '0AMV_MACD']

const message = useMessage()

const selectedIndex = ref('.NDX')
const bars = ref<KlineChartBar[]>([])
const klineRef = ref<{ resize: () => void } | null>(null)

const syncing = ref(false)
const showSyncProgress = ref(false)
const syncJobId = ref<string | null>(null)

async function reload() {
  try {
    const { start, end } = await usIndexDailyApi.getDateRange(selectedIndex.value)
    if (!start || !end) {
      bars.value = []
      message.warning('未灌数据，请先同步')
      return
    }
    const [kline, amvRows] = await Promise.all([
      usIndexDailyApi.query({
        index_code: selectedIndex.value,
        start_date: start,
        end_date: end,
      }),
      // AMV 与 K 线同窗（同一 start/end）；AMV 失败降级为空序列，不拖垮主图。
      usIndexAmvApi
        .query({ index_code: selectedIndex.value, start_date: start, end_date: end })
        .catch(() => [] as AmvSeriesRow[]),
    ])
    bars.value = mergeKlineWithAmv(kline, amvRows)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function handleSync() {
  syncing.value = true
  try {
    const { jobId } = await usIndexDailyApi.triggerSync()
    syncJobId.value = jobId
    showSyncProgress.value = true
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    syncing.value = false
  }
}

function handleSyncDone(state: JobStatus) {
  if (state === 'success') {
    void reload()
  }
}

// 首屏加载：本面板懒挂载在容器(keep-alive)已激活之后，activated 事件已过 →
// onActivated 不会在首次挂载触发，故首屏必须用 onMounted。
onMounted(() => {
  void reload()
})

// 从其它顶层 Tab 切回 Symbols 时刷新（onMounted 不重跑）。
// 当前嵌套下 onActivated 不在首次挂载触发，与 onMounted 不重复加载。
onActivated(() => {
  void reload()
})

// reload on index switch.
watch(selectedIndex, () => {
  void reload()
})

defineExpose({ resize: () => klineRef.value?.resize() })
</script>

<style scoped>
.us-index-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-label {
  color: var(--color-text-secondary);
  font-size: 14px;
}

.index-select {
  width: 180px;
}

@media (max-width: 960px) {
  .panel-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
