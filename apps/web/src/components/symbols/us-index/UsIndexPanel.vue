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
      :data="displayBars"
      :range="range"
      :available-subplots="availableSubplots"
      prefs-key="us-index"
      :height="'640px'"
      show-toolbar
      :symbol-code="selectedIndex"
      :symbol-name="selectedIndexName"
      @update:range="onRangeUpdate"
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

import { computed, onActivated, onMounted, ref, watch } from 'vue'
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
import { sliceDateStringBarsByRange } from '@/composables/kline/klineDateRange'
import { useKlineRangePicker } from '@/composables/kline/useKlineRangePicker'

interface IndexOption extends SelectOption {
  label: string
  value: string
}

// v1 single index; P2 adds .IXIC/.DJI/.INX by appending options.
const indexOptions: IndexOption[] = [{ label: '纳斯达克100', value: '.NDX' }]

// us index K line: basic technical subplots + AMV (活跃市值, 复用 0AMV/0AMV_MACD 渲染键).
const availableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', '0AMV', '0AMV_MACD']

const message = useMessage()

// 未选区间时默认只渲染最近 N 根 K 线：全量（NDX ~3000+ 根）一次性喂给 ECharts
// 会让 setOption 构建 18×N 量级的 series 数组而卡顿；这里裁到近端窗口。
const DEFAULT_BAR_COUNT = 200

const selectedIndex = ref('.NDX')
const selectedIndexName = computed(() =>
  indexOptions.find(o => o.value === selectedIndex.value)?.label ?? ''
)
// 全量合并数据（K 线 + AMV，trade_date ASC）；displayBars 在其上派生显示窗口。
const allBars = ref<KlineChartBar[]>([])
const klineRef = ref<{ resize: () => void } | null>(null)

// 工具栏日期选择器（A 类客户端裁切）：range=[startMs, endMs] 本地午夜 ms，null = 未选。
// ms→日历日转换与裁切逻辑收口在共享 util（见 klineDateRange.ts，本地 getter / datetime.md 例外）。
const { range, onRangeUpdate, reset: resetRange } = useKlineRangePicker()

// 实际喂给图表的数据：
// - 未选区间 → 仅最近 DEFAULT_BAR_COUNT 根（本面板特有性能默认，不外溢到其它调用方）。
// - 选了区间 → 按本地日历日闭区间过滤（open_time 为 'YYYY-MM-DD' 字面串，共享 util 裁切）。
const displayBars = computed<KlineChartBar[]>(() => {
  const bars = allBars.value
  if (!range.value) return bars.slice(-DEFAULT_BAR_COUNT)
  return sliceDateStringBarsByRange(bars, range.value)
})

const syncing = ref(false)
const showSyncProgress = ref(false)
const syncJobId = ref<string | null>(null)

async function reload() {
  try {
    const { start, end } = await usIndexDailyApi.getDateRange(selectedIndex.value)
    if (!start || !end) {
      allBars.value = []
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
    allBars.value = mergeKlineWithAmv(kline, amvRows)
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

// 切换指数：清空区间回到默认近端窗口（不同指数日期覆盖不同），再重载。
watch(selectedIndex, () => {
  resetRange()
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
