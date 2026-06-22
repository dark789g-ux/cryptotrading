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
      <n-tabs type="line" animated>
        <n-tab-pane name="kline" tab="K 线">
          <KlineChart
            v-if="bars.length > 0"
            :data="bars"
            :height="maximized ? maxHeight : '520px'"
            show-toolbar
            granularity="date"
            :range="range"
            prefs-key="a-shares-index-kline"
            :available-subplots="availableSubplots"
            @update:range="onRangeUpdate"
          />
          <n-spin v-else-if="loading" class="modal-spin" />
          <div v-else class="empty-state">该指数暂无 K 线数据，可能尚未同步</div>
        </n-tab-pane>
      </n-tabs>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexKlineModal' })

import { computed, ref, watch } from 'vue'
import { NSpin, NTabPane, NTabs, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import KlineChart from '@/components/kline/KlineChart.vue'
import { indexDailyApi } from '@/api/modules/market/indexDaily'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { useKlineRangePicker } from '@/composables/kline/useKlineRangePicker'
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
 * 指数 K 线副图白名单：成交量 + KDJ + MACD。
 * MA（MA5/MA30/…）在主图叠加，KlineChart 默认渲染；指数无资金流 / 活跃市值，
 * 故不含 FLOW / 0AMV（与 FlowTrendModal 行业入口的副图集区分）。
 */
const availableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD']

/** 首屏默认窗口（近 365 天，≈244 大盘交易日）。用户可用工具栏日期选择器扩到更长区间。 */
const DEFAULT_WINDOW_DAYS = 365
/** 最大化时主图高度 = 92vh 减去 modal chrome（header/tabs/padding ~200px）。 */
const maxHeight = 'calc(92vh - 200px)'

const title = computed(() =>
  props.row ? `${props.row.name}（${props.row.tsCode}）K 线` : '指数 K 线',
)

const loading = ref(false)
const bars = ref<KlineChartBar[]>([])

async function loadKline(startDate: string, endDate: string) {
  if (!props.row) return
  loading.value = true
  try {
    bars.value = await indexDailyApi.queryKline({
      ts_code: props.row.tsCode,
      start_date: startDate,
      end_date: endDate,
    })
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    bars.value = []
  } finally {
    loading.value = false
  }
}

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
      bars.value = []
      range.value = null
      initDefaultRange()
    }
  },
)
</script>

<style scoped>
.modal-spin {
  display: flex;
  justify-content: center;
  padding: 60px 0;
}
.empty-state {
  color: var(--color-text-muted);
  text-align: center;
  padding: 60px 0;
}
</style>
