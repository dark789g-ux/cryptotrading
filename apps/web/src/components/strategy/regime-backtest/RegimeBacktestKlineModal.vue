<template>
  <n-modal
    :show="show"
    :title="modalTitle"
    preset="card"
    :style="modalStyle"
    :bordered="false"
    :segmented="{ content: true }"
    @update:show="emit('update:show', $event)"
  >
    <n-empty v-if="!tsCode?.trim()" description="未选择标的" style="padding: 40px 0" />
    <template v-else>
      <div v-if="loading" class="chart-center">
        <n-spin />
      </div>
      <n-empty
        v-else-if="!klineData.length"
        description="暂无 K 线数据"
        style="padding: 40px 0"
      />
      <kline-chart
        v-else
        :data="klineData"
        :height="chartHeight"
        :current-ts="currentTs"
        :slider-start="0"
        show-toolbar
        granularity="date"
        :range="null"
        disabled-range
        prefs-key="regime-backtest"
        :available-subplots="availableSubplots"
        :symbol-code="tsCode ?? ''"
      />
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NEmpty, NModal, NSpin, useMessage } from 'naive-ui'
import KlineChart from '@/components/kline/KlineChart.vue'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import {
  regimeBacktestApi,
  type RegimeBacktestKlineBar,
} from '@/api/modules/strategy/regimeEngine'

const availableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']

const props = defineProps<{
  show: boolean
  runId: string | null
  tsCode: string | null
  signalDate: string | null
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const message = useMessage()
const loading = ref(false)
const klineData = ref<RegimeBacktestKlineBar[]>([])

const currentTs = computed(() => {
  const d = props.signalDate ?? ''
  if (d.length === 8) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  }
  return d
})

const modalTitle = computed(() => {
  if (!props.tsCode) return 'K 线'
  return `K 线 · ${props.tsCode}`
})

const modalStyle = computed(() => ({
  width: 'min(1200px, 96vw)',
}))

const chartHeight = 480

async function loadChart(): Promise<void> {
  if (!props.runId || !props.tsCode?.trim() || !props.signalDate?.trim()) {
    klineData.value = []
    return
  }
  loading.value = true
  try {
    klineData.value = await regimeBacktestApi.getKlineChart(props.runId, {
      tsCode: props.tsCode.trim(),
      signalDate: props.signalDate.trim(),
    })
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载 K 线失败')
    klineData.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.runId, props.tsCode, props.signalDate] as const,
  ([visible]) => {
    if (visible) void loadChart()
  },
)
</script>

<style scoped>
.chart-center {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}
</style>
