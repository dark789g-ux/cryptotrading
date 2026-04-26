<template>
  <n-drawer
    :show="show"
    width="min(1180px, 92vw)"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <n-drawer-content :title="drawerTitle" closable>
      <n-space v-if="row" vertical size="large">
        <div class="detail-header">
          <div>
            <div class="symbol-line">
              <span class="symbol-name">{{ row.name }}</span>
              <n-tag size="small" :bordered="false">{{ row.tsCode }}</n-tag>
            </div>
            <div class="symbol-meta">
              {{ row.market ?? '-' }} / {{ row.industry ?? '-' }} / {{ formatTradeDate(row.tradeDate) }}
            </div>
          </div>
          <n-space>
            <n-statistic label="最新价" :value="formatPlain(row.close, 2)" />
            <n-statistic label="涨跌幅" :value="formatPercent(row.pctChg)" />
            <n-statistic label="成交额" :value="formatAmount(row.amount)" />
          </n-space>
        </div>

        <div class="chart-panel">
          <div v-if="loading" class="chart-center">
            <n-spin />
          </div>
          <n-empty v-else-if="!klineRows.length" description="暂无K线数据" class="chart-empty" />
          <kline-chart v-else :data="klineRows" height="clamp(520px, 62vh, 620px)" :slider-start="35" />
        </div>

        <n-descriptions
          v-if="latestBar"
          label-placement="top"
          bordered
          :column="4"
          size="small"
        >
          <n-descriptions-item label="DIF">{{ formatMetric(latestBar.DIF, 4) }}</n-descriptions-item>
          <n-descriptions-item label="DEA">{{ formatMetric(latestBar.DEA, 4) }}</n-descriptions-item>
          <n-descriptions-item label="MACD">{{ formatMetric(latestBar.MACD, 4) }}</n-descriptions-item>
          <n-descriptions-item label="KDJ.J">{{ formatMetric(latestBar['KDJ.J'], 2) }}</n-descriptions-item>
          <n-descriptions-item label="BBI">{{ formatMetric(latestBar.BBI, 4) }}</n-descriptions-item>
          <n-descriptions-item label="ATR14">{{ formatMetric(latestBar.atr_14, 4) }}</n-descriptions-item>
          <n-descriptions-item label="止损幅度">{{ formatMetric(latestBar.stop_loss_pct, 2) }}%</n-descriptions-item>
          <n-descriptions-item label="盈亏比">{{ formatMetric(latestBar.risk_reward_ratio, 2) }}</n-descriptions-item>
          <n-descriptions-item label="换手率">{{ formatMetric(latestBar.turnoverRate, 2) }}%</n-descriptions-item>
          <n-descriptions-item label="量比">{{ formatMetric(latestBar.volumeRatio, 2) }}</n-descriptions-item>
          <n-descriptions-item label="PE">{{ formatMetric(latestBar.pe, 2) }}</n-descriptions-item>
          <n-descriptions-item label="PB">{{ formatMetric(latestBar.pb, 2) }}</n-descriptions-item>
          <n-descriptions-item label="总市值">{{ formatMarketValue(latestBar.totalMv) }}</n-descriptions-item>
          <n-descriptions-item label="流通市值">{{ formatMarketValue(latestBar.circMv) }}</n-descriptions-item>
          <n-descriptions-item label="9日低点">{{ formatMetric(latestBar.low_9, 2) }}</n-descriptions-item>
          <n-descriptions-item label="9日高点">{{ formatMetric(latestBar.high_9, 2) }}</n-descriptions-item>
        </n-descriptions>
      </n-space>
      <n-empty v-else description="未选择股票" class="chart-empty" />
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NSpace,
  NSpin,
  NStatistic,
  NTag,
  useMessage,
} from 'naive-ui'
import KlineChart from '../../kline/KlineChart.vue'
import { aSharesApi, type AShareKlineBar, type AShareRow } from '../../../composables/useApi'
import { formatAmount, formatPercent, formatTradeDate } from './aSharesFormatters'

const props = defineProps<{
  show: boolean
  row: AShareRow | null
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const message = useMessage()

const loading = ref(false)
const klineRows = ref<AShareKlineBar[]>([])

const drawerTitle = computed(() => (props.row ? `A股详情 - ${props.row.name}` : 'A股详情'))
const latestBar = computed(() => klineRows.value[klineRows.value.length - 1] ?? null)

function formatPlain(value: string | null, digits: number) {
  if (value == null) return '-'
  const num = Number(value)
  return Number.isFinite(num) ? num.toFixed(digits) : '-'
}

function formatMetric(value: number | null | undefined, digits: number) {
  if (value == null) return '-'
  return Number.isFinite(value) ? value.toFixed(digits) : '-'
}

function formatMarketValue(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(2)} 亿`
  return `${value.toFixed(2)} 万`
}

async function loadKlines() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  klineRows.value = []
  try {
    klineRows.value = await aSharesApi.getKlines(tsCode, 360)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.row?.tsCode] as const,
  ([show, tsCode]) => {
    if (!show) {
      klineRows.value = []
      return
    }
    if (!tsCode) return
    void loadKlines()
  },
)
</script>

<style scoped>
.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.symbol-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.symbol-name {
  color: var(--color-text);
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}

.symbol-meta {
  margin-top: 6px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.chart-panel {
  min-height: 620px;
}

.chart-center,
.chart-empty {
  display: flex;
  justify-content: center;
  padding: 100px 0;
}

@media (max-width: 960px) {
  .detail-header {
    flex-direction: column;
  }

  .chart-panel {
    min-height: 520px;
    height: 520px;
  }
}
</style>
