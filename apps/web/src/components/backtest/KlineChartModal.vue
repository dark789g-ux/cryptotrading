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
    <template #header-extra>
      <n-button text style="margin-right: 4px" @click="toggleFullscreen">
        <template #icon>
          <n-icon><contract-outline v-if="isFullscreen" /><expand-outline v-else /></n-icon>
        </template>
      </n-button>
    </template>

    <n-empty
      v-if="!symbol?.trim()"
      description="No symbol selected"
      style="padding: 40px 0"
    />
    <template v-else>
      <div v-if="loading" class="chart-center">
        <n-spin />
      </div>
      <n-empty
        v-else-if="!klineData.length"
        description="No kline data"
        style="padding: 40px 0"
      />
      <kline-chart v-else :data="klineData" :height="chartHeight" :current-ts="ts" :slider-start="0" />
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, NModal, NSpin, useMessage } from 'naive-ui'
import { ContractOutline, ExpandOutline } from '@vicons/ionicons5'
import KlineChart from '../kline/KlineChart.vue'
import { backtestApi, type KlineChartBar } from '../../composables/useApi'

const props = defineProps<{
  show: boolean
  runId: string | null
  ts: string
  symbol: string | null
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const message = useMessage()

const loading = ref(false)
const klineData = ref<KlineChartBar[]>([])
const isFullscreen = ref(false)

const modalTitle = computed(() => {
  const symbol = props.symbol?.trim() ?? ''
  const ts = props.ts ?? ''
  return symbol ? `Kline Chart · ${symbol} · ${ts}` : `Kline Chart · ${ts}`
})

const modalStyle = computed(() =>
  isFullscreen.value
    ? 'width: 100vw; height: 100vh; max-width: 100vw; border-radius: 0; margin: 0; top: 0; left: 0'
    : 'width: 1150px; max-width: 95vw',
)

const chartHeight = computed(() => (isFullscreen.value ? 'calc(100vh - 60px)' : '600px'))

const toggleFullscreen = () => {
  isFullscreen.value = !isFullscreen.value
}

const loadKline = async () => {
  const runId = props.runId
  const ts = props.ts?.trim() ?? ''
  const symbol = props.symbol?.trim() ?? ''
  if (!runId || !ts || !symbol) return

  loading.value = true
  klineData.value = []
  try {
    klineData.value = await backtestApi.getKlineChart(runId, {
      symbol,
      ts,
      before: 100,
      after: 30,
    })
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }

}

watch(
  () => [props.show, props.runId, props.ts, props.symbol] as const,
  async ([show, runId, ts, symbol]) => {
    if (!show) {
      klineData.value = []
      isFullscreen.value = false
      return
    }
    if (!runId || !ts?.trim() || !symbol?.trim()) return
    await loadKline()
  },
)
</script>

<style scoped>
.chart-center {
  display: flex;
  justify-content: center;
  padding: 80px 0;
}
</style>
