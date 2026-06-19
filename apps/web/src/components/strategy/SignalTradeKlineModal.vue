<template>
  <AppModal
    :show="show"
    :title="headerTitle"
    width="min(1100px, 96vw)"
    maximizable
    @update:show="emit('update:show', $event)"
  >
    <template #default="{ maximized }">
      <n-spin :show="loading">
        <!-- Tier 3 豁免日期选择器：本图取单笔交易 signalDate-30~exitDate+20 的固定上下文，
             并在买/卖那根 bar 注入买卖点标注；按日期裁会破坏标注语义，故保持 disabled-range。 -->
        <KlineChart
          v-if="bars.length"
          :data="bars"
          :current-ts="entryTs"
          :height="maximized ? 'calc(92vh - 160px)' : '560px'"
          show-toolbar
          disabled-range
          granularity="date"
          prefs-key="signal-kline"
          :available-subplots="availableSubplots"
          :recalc-indicators="recalcKdjIndicators"
        />
        <n-empty v-else-if="!loading" description="无 K 线数据" />
      </n-spin>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'SignalTradeKlineModal' })

import { computed, ref, watch } from 'vue'
import { NEmpty, NSpin } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import KlineChart from '@/components/kline/KlineChart.vue'
import { aSharesApi } from '@/api/modules/market/aShares'
import type { KlineChartBar, TradeOnBar } from '@/api/modules/market/symbols'
import type { IndicatorSubplotParams, SubplotKey } from '@/composables/kline/subplotConfig'
import type { SignalTestTrade } from '@/api/modules/strategy/signalStats'
import { exitReasonLabel, fmtRetPct, fmtTradeDate } from './signalStatsFormatters'

// 信号 K 线不含资金流/AMV 数据源：排除 FLOW/0AMV/0AMV_MACD，只保留技术副图
const availableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD']

const props = defineProps<{ show: boolean; trade: SignalTestTrade | null }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const bars = ref<KlineChartBar[]>([])
const loading = ref(false)
const entryTs = ref('')

const headerTitle = computed(() => {
  const t = props.trade
  if (!t) return 'K 线详情'
  return `${t.tsCode} ${t.name ?? ''} · 买 ${fmtTradeDate(t.buyDate)} / 卖 ${fmtTradeDate(t.exitDate)} · ${fmtRetPct(t.ret)}`
})

// YYYYMMDD ± days → YYYYMMDD（datetime 规范：转 Date 必插分隔符 + Z，用 UTC 方法）
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`,
  )
  d.setUTCDate(d.getUTCDate() + days)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

// 在买/卖那根 bar 注入 trades 标记。
// ⚠️ 对齐 key：bar.open_time 是 'YYYY-MM-DD'，buyDate/exitDate 是 'YYYYMMDD'，
//    必须用 fmtTradeDate 转换后再做字面比对。
function injectMarkers(raw: KlineChartBar[], t: SignalTestTrade): KlineChartBar[] {
  const buyKey = fmtTradeDate(t.buyDate)
  const exitKey = fmtTradeDate(t.exitDate)
  return raw.map((bar) => {
    const trades: TradeOnBar[] = []
    if (bar.open_time === buyKey) {
      trades.push({ type: 'entry', symbol: t.tsCode, price: Number(t.buyPrice), shares: 0, reason: '买入' })
    }
    if (bar.open_time === exitKey) {
      trades.push({ type: 'exit', symbol: t.tsCode, price: Number(t.exitPrice), shares: 0, reason: exitReasonLabel(t.exitReason) })
    }
    return trades.length ? { ...bar, trades } : bar
  })
}

let reqSeq = 0

async function load() {
  const t = props.trade
  if (!t) return
  const my = ++reqSeq
  loading.value = true
  try {
    const range = {
      startDate: shiftYmd(t.signalDate, -30),
      endDate: shiftYmd(t.exitDate, +20),
    }
    const raw = await aSharesApi.getKlines(t.tsCode, 500, 'qfq', range)
    if (my !== reqSeq) return
    bars.value = injectMarkers(raw, t)
    entryTs.value = fmtTradeDate(t.buyDate)
  } finally {
    if (my === reqSeq) loading.value = false
  }
}

async function recalcKdjIndicators(params?: IndicatorSubplotParams): Promise<void> {
  const t = props.trade
  if (!t) return
  try {
    const range = {
      startDate: shiftYmd(t.signalDate, -30),
      endDate: shiftYmd(t.exitDate, +20),
    }
    const raw = await aSharesApi.recalcKlines(
      t.tsCode,
      500,
      'qfq',
      range,
      { kdjParams: params?.KDJ },
    )
    bars.value = injectMarkers(raw, t)
  } catch (err: unknown) {
    throw err
  }
}

watch(
  () => props.show,
  (s) => {
    if (s) {
      load()
    } else {
      bars.value = []
      entryTs.value = ''
    }
  },
)
</script>
