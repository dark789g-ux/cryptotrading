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
        <n-tab-pane v-if="row?.category === 'sw'" name="hierarchy" tab="行业层级">
          <div class="hierarchy-pane-body">
            <n-spin v-if="hierarchyLoading" />
            <div v-else-if="!hierarchyData" class="empty-state">
              暂无行业层级数据
            </div>
            <div v-else class="hierarchy-tree-container">
              <div class="hierarchy-tree">
                <!-- 一级行业 -->
                <div 
                  class="tree-node level-1" 
                  :class="{ active: hierarchyData.level === 1 }"
                >
                  <div class="node-icon">Ⅰ</div>
                  <div class="node-content">
                    <span class="node-name">{{ hierarchyData.l1Name }}</span>
                    <span class="node-code">{{ hierarchyData.l1Code }}</span>
                  </div>
                </div>

                <!-- 二级行业 -->
                <template v-if="hierarchyData.l2Code">
                  <div class="tree-connector level-1-to-2"></div>
                  <div 
                    class="tree-node level-2" 
                    :class="{ active: hierarchyData.level === 2 }"
                  >
                    <div class="node-icon">Ⅱ</div>
                    <div class="node-content">
                      <span class="node-name">{{ hierarchyData.l2Name }}</span>
                      <span class="node-code">{{ hierarchyData.l2Code }}</span>
                    </div>
                  </div>
                </template>

                <!-- 三级行业 -->
                <template v-if="hierarchyData.l3Code">
                  <div class="tree-connector level-2-to-3"></div>
                  <div 
                    class="tree-node level-3" 
                    :class="{ active: hierarchyData.level === 3 }"
                  >
                    <div class="node-icon">Ⅲ</div>
                    <div class="node-content">
                      <span class="node-name">{{ hierarchyData.l3Name }}</span>
                      <span class="node-code">{{ hierarchyData.l3Code }}</span>
                    </div>
                  </div>
                </template>
              </div>
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
import { indexDailyApi } from '@/api/modules/market/indexDaily'
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
 * 指数 K 线副图白名单：成交量 + KDJ + MACD + 资金净流入（FLOW）；
 * sw/industry/concept/custom 另含 0AMV / 0AMV_MACD。
 * MA（MA5/MA30/…）在主图叠加，KlineChart 默认渲染。
 */
const BASE_SUBPLOTS: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'FLOW']
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

const hierarchyData = ref<{
  level: number;
  l1Code: string | null;
  l1Name: string | null;
  l2Code: string | null;
  l2Name: string | null;
  l3Code: string | null;
  l3Name: string | null;
} | null>(null)
const hierarchyLoading = ref(false)

async function loadHierarchy() {
  if (!props.row || props.row.category !== 'sw') {
    hierarchyData.value = null
    return
  }
  hierarchyLoading.value = true
  try {
    hierarchyData.value = await indexDailyApi.getSwHierarchy(props.row.tsCode)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    hierarchyData.value = null
  } finally {
    hierarchyLoading.value = false
  }
}
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
      if (props.row.category === 'sw') {
        void loadHierarchy()
      }
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

.hierarchy-pane-body {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.hierarchy-tree-container {
  width: 100%;
  max-width: 600px;
  background: var(--color-surface-elevated);
  border-radius: 12px;
  border: 1px solid var(--color-border);
  padding: 36px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}

.hierarchy-tree {
  display: flex;
  flex-direction: column;
  position: relative;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  z-index: 2;
}

.tree-node.level-1 {
  width: calc(100% - 120px);
}

.tree-node.level-2 {
  margin-left: 60px;
  width: calc(100% - 180px);
}

.tree-node.level-3 {
  margin-left: 120px;
  width: calc(100% - 240px);
}

.tree-node.active {
  background: color-mix(in srgb, var(--color-success) 12%, transparent) !important;
  border-color: var(--color-success) !important;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--color-success) 20%, transparent);
}

.node-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-text-muted) 15%, transparent);
  color: var(--color-text-secondary);
  font-weight: bold;
  font-size: 14px;
  flex-shrink: 0;
  border: 1px solid var(--color-border);
}

.active .node-icon {
  background: var(--color-success);
  color: var(--color-surface);
  border-color: var(--color-success);
}

.node-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.node-name {
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text);
}

.active .node-name {
  color: var(--color-success);
  font-weight: 600;
}

.node-code {
  font-size: 13px;
  color: var(--color-text-secondary);
  font-family: monospace;
}

.active .node-code {
  color: color-mix(in srgb, var(--color-success) 80%, var(--color-text));
}

/* 拐角连接线 */
.tree-connector {
  position: relative;
  height: 36px;
}

.tree-connector::before {
  content: '';
  position: absolute;
  top: -24px;
  width: 2px;
  height: calc(100% + 36px);
  border-left: 2px dashed var(--color-border);
  z-index: 1;
}

.level-1-to-2::before {
  left: 36px;
}

.level-1-to-2::after {
  content: '';
  position: absolute;
  left: 36px;
  top: 18px;
  width: 44px;
  height: 2px;
  border-top: 2px dashed var(--color-border);
  z-index: 1;
}

.level-2-to-3::before {
  left: 96px;
}

.level-2-to-3::after {
  content: '';
  position: absolute;
  left: 96px;
  top: 18px;
  width: 44px;
  height: 2px;
  border-top: 2px dashed var(--color-border);
  z-index: 1;
}
</style>
