<template>
  <AppModal
    :show="show"
    :title="title"
    width="min(1080px, 96vw)"
    maximizable
    @update:show="emit('update:show', $event)"
  >
    <!--
      n-tabs 包装 KlineChart（镜像 FlowTrendModal 结构）：
      AppModal/n-modal 的 default slot 在 LazyTeleport 上下文被调用，slot 顶层若是
      自定义组件（曾试 ASharesIndexKlineBody），其 vnode.el 始终 null（不挂载 DOM）；
      改用 naive-ui 的 n-tabs 作为 slot 顶层容器（naive-ui 组件在 slot 内正常 mount），
      KlineChart 放进 n-tab-pane（n-tabs 子组件 render context），mount / echarts.init 正常。
    -->
    <template #default="{ maximized }">
      <n-tabs v-model:value="activeTab" type="line" animated>
        <n-tab-pane name="kline" tab="K 线">
          <!--
            LazyTeleport 双约束（真机 2026-06-23 验证）：
            1) div 包裹 —— n-tab-pane slot 顶层自定义组件 vnode.el=null
            2) KlineChart 随 modal 首次 patch 常驻（overlay 遮 loading/empty），勿 v-if/v-else 等数据后再创建；
               数据就绪后父组件显式 renderChart()（内部 watch 二次触发在 LazyTeleport 内不可靠）
          -->
          <div class="kline-pane-body">
            <KlineChart
              ref="klineRef"
              :data="bars"
              :height="maximized ? maxHeight : '520px'"
              show-toolbar
              granularity="date"
              :range="range"
              prefs-key="a-shares-index-kline"
              :available-subplots="availableSubplots"
              :symbol-code="row?.tsCode"
              :symbol-name="row?.name"
              @update:range="onRangeUpdate"
            />
            <n-spin v-if="loading" class="modal-pane-overlay modal-spin" />
            <div v-else-if="!bars.length" class="modal-pane-overlay empty-state">
              该指数暂无 K 线数据，可能尚未同步
            </div>
          </div>
        </n-tab-pane>
      </n-tabs>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexKlineModal' })

import { computed, nextTick, ref, watch } from 'vue'
import { NSpin, NTabPane, NTabs, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import KlineChart from '@/components/kline/KlineChart.vue'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { useKlineRangePicker } from '@/composables/kline/useKlineRangePicker'
import { fetchIndexKline } from './aSharesIndexKlineFetcher'
import type { IndexLatestRow } from './types'

const props = defineProps<{
  show: boolean
  row: IndexLatestRow | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
}>()

const message = useMessage()

/**
 * 指数 K 线副图白名单：成交量 + KDJ + MACD；sw/industry/concept/custom 另含 0AMV / 0AMV_MACD。
 * MA（MA5/MA30/…）在主图叠加，KlineChart 默认渲染。
 */
const BASE_SUBPLOTS: SubplotKey[] = ['VOL', 'KDJ', 'MACD']
const AMV_SUBPLOTS: SubplotKey[] = ['0AMV', '0AMV_MACD']

const availableSubplots = computed(() =>
  props.row?.category === 'market'
    ? BASE_SUBPLOTS
    : [...BASE_SUBPLOTS, ...AMV_SUBPLOTS],
)
const DEFAULT_WINDOW_DAYS = 365
/** 最大化时主图高度 = 92vh 减去 modal chrome（header/tabs/padding ~200px）。 */
const maxHeight = 'calc(92vh - 200px)'

const title = computed(() =>
  props.row ? `${props.row.name}（${props.row.tsCode}）K 线` : '指数 K 线',
)

const activeTab = ref('kline')
const loading = ref(false)
const bars = ref<KlineChartBar[]>([])
const klineRef = ref<{ renderChart: () => Promise<void>; resize?: () => void } | null>(null)

/** modal/LazyTeleport 下 KlineChart 内部 watch 二次 renderChart 不可靠；ref 可能晚于 loadKline 就绪。 */
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
  loading.value = true
  try {
    bars.value = await fetchIndexKline(props.row, startDate, endDate)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    bars.value = []
  } finally {
    loading.value = false
    void refreshChartAfterData()
    // LazyTeleport 内 klineRef / 布局就绪常晚于 API；单次延迟补 render。
    setTimeout(() => void refreshChartAfterData(), 150)
  }
}

/** loadKline 可能比 LazyTeleport 内 KlineChart mount 更快 —— ref 就绪后再 renderChart。 */
watch(
  () => ({ ref: klineRef.value, len: bars.value.length, loading: loading.value }),
  async ({ ref, len, loading: isLoading }) => {
    if (!ref || len === 0 || isLoading) return
    await refreshChartAfterData()
  },
  { flush: 'post', immediate: true },
)

watch(klineRef, async (ref) => {
  if (ref && bars.value.length > 0 && !loading.value) {
    await refreshChartAfterData()
  }
}, { flush: 'post' })

/**
 * B 类（服务端重查）：A 股指数 open_time 是 YYYYMMDD（非 YYYY-MM-DD），
 * 不能用 A 类客户端裁切（sliceDateStringBarsByRange 仅支持 YYYY-MM-DD）。
 * 选了区间 → 用 YYYYMMDD 起止重查；清空 → no-op（保留当前数据）。
 * 模式同 FlowTrendModal kline 模式。
 */
const { range, onRangeUpdate } = useKlineRangePicker((r) => {
  if (!r) return
  void loadKline(r.startDate, r.endDate)
})

function initDefaultRange() {
  const now = Date.now()
  onRangeUpdate([now - DEFAULT_WINDOW_DAYS * 86400000, now])
}

// 每次打开：清空旧数据 + 用默认窗口触发首屏加载（onRangeUpdate → onApply 重查）
watch(
  () => props.show,
  (v) => {
    if (v && props.row) {
      activeTab.value = 'kline'
      bars.value = []
      range.value = null
      initDefaultRange()
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
</style>
