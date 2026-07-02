<template>
  <AppModal
    :show="show"
    :title="title"
    width="min(1080px, 96vw)"
    maximizable
    @update:show="emit('update:show', $event)"
  >
    <template #default="{ maximized }">
      <n-tabs v-model:value="activeTab" type="line" animated>
        <n-tab-pane name="kline" tab="K 线">
          <div class="kline-pane-body">
            <KlineChart
              ref="klineRef"
              :data="bars"
              :height="maximized ? maxHeight : '520px'"
              show-toolbar
              granularity="date"
              :range="range"
              prefs-key="a-shares-etf-kline"
              :available-subplots="availableSubplots"
              :symbol-code="row?.tsCode"
              :symbol-name="row?.name"
              @update:range="onRangeUpdate"
            />
            <n-spin v-if="klineLoading" class="modal-pane-overlay modal-spin" />
            <div v-else-if="!bars.length" class="modal-pane-overlay empty-state">
              该 ETF 暂无 K 线数据，可能尚未同步
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="pcf" tab="PCF 成分股明细">
          <div class="pcf-pane-body">
            <div class="pcf-header">
              <span class="pcf-date-label">
                {{ pcfDateLabel }}
              </span>
              <span v-if="pcfRows.length" class="pcf-count">
                共 {{ pcfRows.length }} 只
              </span>
              <n-button
                size="small"
                type="primary"
                :disabled="!pcfRows.length"
                @click="handleJumpToMembers"
              >
                成分股
              </n-button>
            </div>

            <n-spin v-if="pcfLoading" class="pcf-spin" />
            <n-data-table
              v-else
              :columns="pcfColumns"
              :data="pcfRows"
              :max-height="maximized ? pcfMaxHeight : '400px'"
              size="small"
            />
          </div>
        </n-tab-pane>
      </n-tabs>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'EtfKlineModal' })

import { computed, nextTick, ref, watch } from 'vue'
import { NSpin, NTabPane, NTabs, NButton, NDataTable, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import KlineChart from '@/components/kline/KlineChart.vue'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { useKlineRangePicker } from '@/composables/kline/useKlineRangePicker'
import { etfApi } from '@/api/modules/market/etf'
import type { EtfLatestRow, EtfPcfRow } from './etf.types'
import { createPcfColumnDefs } from './pcfColumns'

const props = defineProps<{
  show: boolean
  row: EtfLatestRow | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'jump-to-members', payload: { tsCodes: string[]; name: string }): void
}>()

const message = useMessage()

/**
 * ETF K 线副图：成交量 + KDJ + MACD + 活跃市值（0AMV / 0AMV_MACD）。
 * AMV 数据由后端 GET /api/etf/kline 直接 join raw.fund_amv_daily 返回（bar['0AMV']*）。
 */
const BASE_SUBPLOTS: SubplotKey[] = ['VOL', 'KDJ', 'MACD']
const AMV_SUBPLOTS: SubplotKey[] = ['0AMV', '0AMV_MACD']
const availableSubplots = computed(() => [...BASE_SUBPLOTS, ...AMV_SUBPLOTS])

const DEFAULT_WINDOW_DAYS = 365
const maxHeight = 'calc(92vh - 200px)'

const title = computed(() =>
  props.row ? `${props.row.name}（${props.row.tsCode}）` : 'ETF 详情',
)

const activeTab = ref('kline')

// ---- K 线数据 ----
const klineLoading = ref(false)
const bars = ref<KlineChartBar[]>([])
const klineRef = ref<{ renderChart: () => Promise<void>; resize?: () => void } | null>(null)

async function refreshChartAfterData() {
  if (!bars.value.length) return
  for (let attempt = 0; attempt < 10; attempt++) {
    const chart = klineRef.value
    if (!chart) {
      await nextTick()
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      continue
    }
    await nextTick()
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      requestAnimationFrame(done)
      setTimeout(done, 50)
    })
    await chart.renderChart()
    chart.resize?.()
    return
  }
}

async function loadKline(startDate: string, endDate: string) {
  if (!props.row) return
  klineLoading.value = true
  try {
    bars.value = await etfApi.queryKline({
      ts_code: props.row.tsCode,
      start_date: startDate,
      end_date: endDate,
    })
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    bars.value = []
  } finally {
    klineLoading.value = false
    void refreshChartAfterData()
    setTimeout(() => void refreshChartAfterData(), 150)
  }
}

watch(
  () => ({ ref: klineRef.value, len: bars.value.length, loading: klineLoading.value }),
  async ({ ref, len, loading: isLoading }) => {
    if (!ref || len === 0 || isLoading) return
    await refreshChartAfterData()
  },
  { flush: 'post', immediate: true },
)

watch(klineRef, async (ref) => {
  if (ref && bars.value.length > 0 && !klineLoading.value) {
    await refreshChartAfterData()
  }
}, { flush: 'post' })

const { range, onRangeUpdate } = useKlineRangePicker((r) => {
  if (!r) return
  void loadKline(r.startDate, r.endDate)
})

function initDefaultRange() {
  const now = Date.now()
  onRangeUpdate([now - DEFAULT_WINDOW_DAYS * 86400000, now])
}

// ---- PCF 成分股数据 ----
const pcfLoading = ref(false)
const pcfRows = ref<EtfPcfRow[]>([])

const pcfDateLabel = computed(() => {
  if (!props.row?.tradeDate) return ''
  const d = props.row.tradeDate
  if (d.length !== 8) return d
  return `(${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)})`
})

async function loadPcf() {
  if (!props.row) return
  pcfLoading.value = true
  pcfRows.value = []
  try {
    pcfRows.value = await etfApi.getPcf({
      ts_code: props.row.tsCode,
      trade_date: props.row.tradeDate,
    })
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    pcfLoading.value = false
  }
}

const pcfColumns = computed(() => createPcfColumnDefs())
const pcfMaxHeight = 'calc(92vh - 300px)'

function handleJumpToMembers() {
  if (!props.row || !pcfRows.value.length) return
  emit('jump-to-members', {
    tsCodes: pcfRows.value.map((r) => r.conCode),
    name: props.row.name,
  })
}

// ---- Modal 打开 / 关闭 ----
watch(
  () => props.show,
  (v) => {
    if (v && props.row) {
      activeTab.value = 'kline'
      bars.value = []
      range.value = null
      initDefaultRange()
      void loadPcf()
    }
  },
)
</script>

<style scoped>
.kline-pane-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 320px;
}
.modal-pane-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface, #fff);
  z-index: 1;
}
.modal-spin {
  flex-direction: column;
  padding: 60px 0;
}
.empty-state {
  color: var(--color-text-muted);
  text-align: center;
  padding: 60px 16px;
}
.pcf-pane-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 320px;
}
.pcf-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pcf-date-label {
  color: var(--color-text-secondary);
}
.pcf-count {
  color: var(--color-text-muted);
  font-size: 13px;
}
.pcf-spin {
  padding: 60px 0;
}
</style>
