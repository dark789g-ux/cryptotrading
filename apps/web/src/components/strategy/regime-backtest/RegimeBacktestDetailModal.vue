<template>
  <n-modal
    :show="show"
    preset="card"
    :title="run ? `回测详情 · ${run.name}` : '回测详情'"
    :bordered="false"
    :segmented="{ content: true }"
    style="width: min(1400px, 96vw)"
    :content-style="{ maxHeight: '80vh', overflow: 'auto' }"
    @update:show="$emit('update:show', $event)"
  >
    <n-tabs v-model:value="activeTab" type="line" animated>
      <n-tab-pane name="summary" tab="汇总">
        <n-card v-if="run" :bordered="false" size="small" style="margin-bottom: 16px">
          <RegimeBacktestConfigSummary :run="run" />
        </n-card>
        <n-card v-if="run" title="汇总指标" :bordered="false" size="small">
          <RegimeBacktestSummaryCards :run="run" />
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="nav" tab="净值">
        <n-spin :show="dailyLoading">
          <RegimeBacktestNavChart
            v-if="daily.length > 0"
            :rows="daily"
            :initial-capital="initialCapital"
          />
          <n-empty v-else description="暂无净值数据" />
        </n-spin>
      </n-tab-pane>

      <n-tab-pane name="trades" tab="交易">
        <n-spin :show="tradesLoading">
          <RegimeBacktestTradesTable
            v-if="trades.length > 0"
            :trades="trades"
            @open-kline="openKline"
          />
          <n-empty v-else description="暂无交易数据" />
        </n-spin>
      </n-tab-pane>

      <n-tab-pane name="audit" tab="日审计">
        <RegimeBacktestDailyLogTable
          :rows="dailyLog"
          :loading="dailyLogLoading"
          @open-kline="openKline"
        />
      </n-tab-pane>

      <n-tab-pane name="positions" tab="仓位/标的">
        <RegimeBacktestPositionsPanel
          :run-id="run?.id ?? null"
          :active="activeTab === 'positions'"
          @open-kline="openKline"
        />
      </n-tab-pane>
    </n-tabs>

    <RegimeBacktestKlineModal
      v-model:show="klineShow"
      :run-id="run?.id ?? null"
      :ts-code="klineTsCode"
      :signal-date="klineSignalDate"
    />
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NModal,
  NCard,
  NSpin,
  NEmpty,
  NTabs,
  NTabPane,
} from 'naive-ui'
import {
  regimeBacktestApi,
  type RegimeBacktestRun,
  type RegimeBacktestDaily,
  type RegimeBacktestTrade,
  type RegimeBacktestDailyLog,
} from '@/api/modules/strategy/regimeEngine'
import RegimeBacktestConfigSummary from '@/components/strategy/regime-backtest/RegimeBacktestConfigSummary.vue'
import RegimeBacktestSummaryCards from '@/components/strategy/regime-backtest/RegimeBacktestSummaryCards.vue'
import RegimeBacktestNavChart from '@/components/strategy/regime-backtest/RegimeBacktestNavChart.vue'
import RegimeBacktestTradesTable from '@/components/strategy/regime-backtest/RegimeBacktestTradesTable.vue'
import RegimeBacktestDailyLogTable from '@/components/strategy/regime-backtest/RegimeBacktestDailyLogTable.vue'
import RegimeBacktestPositionsPanel from '@/components/strategy/regime-backtest/RegimeBacktestPositionsPanel.vue'
import RegimeBacktestKlineModal from '@/components/strategy/regime-backtest/RegimeBacktestKlineModal.vue'

const props = defineProps<{
  show: boolean
  run: RegimeBacktestRun | null
  daily: RegimeBacktestDaily[]
  dailyLoading: boolean
  trades: RegimeBacktestTrade[]
  tradesLoading: boolean
  initialCapital: number
}>()

defineEmits<{
  'update:show': [value: boolean]
}>()

const activeTab = ref('summary')

const dailyLog = ref<RegimeBacktestDailyLog[]>([])
const dailyLogLoading = ref(false)

const klineShow = ref(false)
const klineTsCode = ref<string | null>(null)
const klineSignalDate = ref<string | null>(null)

function openKline(payload: { tsCode: string; signalDate: string }): void {
  klineTsCode.value = payload.tsCode
  klineSignalDate.value = payload.signalDate
  klineShow.value = true
}

async function loadDailyLog(runId: string): Promise<void> {
  dailyLogLoading.value = true
  try {
    dailyLog.value = await regimeBacktestApi.listDailyLog(runId)
  } finally {
    dailyLogLoading.value = false
  }
}

watch(
  () => [props.show, props.run?.id, activeTab.value] as const,
  ([visible, runId, tab]) => {
    if (visible && runId && tab === 'audit' && dailyLog.value.length === 0 && !dailyLogLoading.value) {
      void loadDailyLog(runId)
    }
  },
)
</script>
