<!-- apps/web/src/components/money-flow/FlowTrendModal.vue -->
<template>
  <AppModal
    :show="visible"
    :title="`${entityName} — 详情`"
    :width="modalWidth"
    :maximizable="chartMode === 'kline'"
    @update:show="$emit('update:visible', $event)"
  >
    <template #default="{ maximized }">
      <n-tabs v-model:value="activeTab" type="line" animated>
        <n-tab-pane name="trend" tab="趋势">
          <div class="trend-modal-body">
            <FlowDateControl
              v-if="chartMode === 'bar'"
              default-mode="range"
              :default-range-days="30"
              @change="onDateChange"
            />
            <n-spin v-if="loading" />
            <template v-else-if="chartMode === 'bar'">
              <FlowTrendChart :rows="barRows" />
            </template>
            <template v-else>
              <div v-if="!klineBars.length" class="empty-state">
                该指数暂无 K 线数据，可能尚未同步
              </div>
              <KlineChart
                v-else
                :data="klineBars"
                :height="maximized ? klineMaxHeight : '520px'"
                show-toolbar
                granularity="date"
                :range="klineRange"
                prefs-key="money-flow-kline"
                :available-subplots="availableSubplots"
                :recalc-indicators="recalcKdjIndicators"
                @update:range="onKlineRangeChange"
              />
              <!-- 0AMV 副图合规标注（spec §8/§11）：信号未回测校准 + 成分股当前快照。
                   仅当本入口确实开了 0AMV 副图（行业 type='I' / 概念 type='N'）才展示，
                   大盘等不含 0AMV 的入口不出现；文案由调用方经 amvCaption prop 区分行业/板块措辞 -->
              <n-text v-if="klineBars.length && showAmvCaption" :depth="3" class="amv-caption">
                {{ amvCaption }}
              </n-text>
            </template>
          </div>
        </n-tab-pane>

        <n-tab-pane v-if="showMembersTab" name="members" tab="成分股">
          <div class="members-body">
            <div class="members-toolbar">
              <n-button type="primary" :disabled="!canAddTag" :loading="addTagLoading" @click="onAddTag">
                + 添加标签
              </n-button>
              <span class="hint">共 {{ memberRows.length }} 只</span>
            </div>
            <n-spin :show="membersLoading">
              <n-data-table
                :columns="memberColumns"
                :data="sortedMemberRows"
                :max-height="maximized ? '70vh' : 400"
                size="small"
                :pagination="{ pageSize: 50 }"
                @update:sorter="onUpdateSorter"
              />
              <div v-if="!membersLoading && !memberRows.length" class="empty-state">
                暂无成分股数据，请先同步资金流数据。
              </div>
            </n-spin>
          </div>
        </n-tab-pane>
      </n-tabs>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
defineOptions({ name: 'FlowTrendModal' })

import { computed, h, ref, watch } from 'vue'
import { NButton, NDataTable, NSpin, NTabPane, NTabs, NText, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import FlowDateControl from './FlowDateControl.vue'
import FlowTrendChart from './FlowTrendChart.vue'
import KlineChart from '@/components/kline/KlineChart.vue'
import { moneyFlowApi, type MoneyFlowMemberRow, type MoneyFlowQueryParams } from '@/api/modules/market/moneyFlow'
import { thsIndexDailyApi } from '@/api/modules/market/thsIndexDaily'
import { watchlistApi } from '@/api'
import type { KlineChartBar } from '@/api'
import { AMV_CAPTION_INDUSTRY } from '@/composables/kline/amvCaption'
import type { IndicatorSubplotParams, SubplotKey } from '@/composables/kline/subplotConfig'
import { msToYyyymmdd } from '@/composables/kline/klineDateRange'
import { useKlineRangePicker } from '@/composables/kline/useKlineRangePicker'
import { useWatchlistStore } from '@/stores/watchlist'
import type { BarChartRow, TrendFetchResult } from './money-flow.types'

type ChartMode = 'bar' | 'kline'

// fetchFn 的返回类型由调用方按 chartMode 自行约束：
// - bar 模式：返回 BarChartRow[]
// - kline 模式：返回 TrendFetchResult
// 这里用联合类型并在 loadTrend 内按 chartMode 分发。
type TrendFetchFn = (params: MoneyFlowQueryParams) => Promise<BarChartRow[] | TrendFetchResult>

const props = withDefaults(defineProps<{
  visible: boolean
  tsCode: string
  entityName: string
  fetchFn: TrendFetchFn
  chartMode?: ChartMode
  showMembersTab?: boolean
  membersTradeDate?: string | null
  /** kline 模式副图白名单；默认不含 AMV，行业指数入口可显式传入含 0AMV 的列表 */
  availableSubplots?: SubplotKey[]
  /** 0AMV 副图合规标注文案；默认行业版（含「行业量」），概念板块入口可传板块版 */
  amvCaption?: string
}>(), {
  chartMode: 'bar',
  showMembersTab: false,
  membersTradeDate: null,
  // 默认副图白名单：不含 AMV（保证 sector / 大盘 等非 type='I' 入口布局不变）；
  // 行业指数（type='I'）入口由 IndustryFlowPanel 显式传入含 0AMV / 0AMV_MACD 的列表。
  // 注意：defineProps/withDefaults 会被编译器提升到 setup() 外，default 工厂内
  // 不能引用 <script setup> 里的局部 const，故此处直接内联字面量 / 模块顶层 import 常量。
  availableSubplots: () => ['VOL', 'KDJ', 'MACD', 'BRICK', 'FLOW'],
  amvCaption: AMV_CAPTION_INDUSTRY,
})

defineEmits<{
  'update:visible': [value: boolean]
}>()

const message = useMessage()

const modalWidth = computed(() =>
  props.chartMode === 'kline' ? 'min(1080px, 96vw)' : 'min(720px, 92vw)',
)

// 仅当本入口确实展示了 0AMV 副图（行业指数 type='I' 入口显式传入含 0AMV 的白名单）
// 才显示活跃市值标注；sector / 大盘 等不含 0AMV 的入口不出现该行小字。
const showAmvCaption = computed(
  () => props.chartMode === 'kline' && props.availableSubplots.includes('0AMV'),
)

// 最大化下 K 线高度 = 92vh 减去固定 chrome（modal header ~70 + card padding ~32 + tabs nav ~46 + tab pane padding ~12 + FlowDateControl ~40 + body gap ~16 = ~216px，留 24px 余量）
const klineMaxHeight = 'calc(92vh - 240px)'

const activeTab = ref('trend')
const barRows = ref<BarChartRow[]>([])
const klineBars = ref<KlineChartBar[]>([])
const loading = ref(false)
let skipNextEmit = false

// kline 模式日期范围（与 KlineChart 工具栏双向绑定）。B 类服务端重查：选了区间 → 用 start/end
// 重查；清空 → no-op（保留当前数据，与接入前行为一致）。ms→YYYYMMDD 转换收口在 composable。
const { range: klineRange, onRangeUpdate: onKlineRangeChange } = useKlineRangePicker((r) => {
  if (!r) return
  loadTrend({ start_date: r.startDate, end_date: r.endDate })
})

// 首次进入 kline 模式：用近 120 天默认窗口触发首屏加载。
// onKlineRangeChange 会置位 range 并经 composable 的 onApply 重查（取代旧的手动 loadTrend）。
function initKlineRangeDefault() {
  const now = Date.now()
  onKlineRangeChange([now - 120 * 86400000, now])
}

// 成分股相关
const memberRows = ref<MoneyFlowMemberRow[]>([])
const membersLoading = ref(false)
let membersLoaded = false

const sortState = ref<{ field: 'pctChange' | 'netAmount'; order: 'ascend' | 'descend' } | null>({
  field: 'netAmount',
  order: 'descend',
})

function compareWithNullsLast(
  a: number | null | undefined,
  b: number | null | undefined,
  order: 'ascend' | 'descend',
) {
  const aNull = a == null || !Number.isFinite(Number(a))
  const bNull = b == null || !Number.isFinite(Number(b))
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  const x = Number(a)
  const y = Number(b)
  return order === 'descend' ? y - x : x - y
}

const sortedMemberRows = computed(() => {
  if (!sortState.value) return memberRows.value
  const { field, order } = sortState.value
  return [...memberRows.value].sort((r1, r2) =>
    compareWithNullsLast(r1[field] as number | null | undefined, r2[field] as number | null | undefined, order),
  )
})

const memberColumns = computed((): DataTableColumns<MoneyFlowMemberRow> => [
  {
    title: '#',
    key: 'index',
    width: 50,
    render: (_row, index) => h('span', {}, String(index + 1)),
  },
  { title: '代码', key: 'conCode', width: 120 },
  { title: '名称', key: 'conName', width: 150 },
  {
    title: '涨跌幅%',
    key: 'pctChange',
    width: 90,
    sorter: true,
    sortOrder: sortState.value?.field === 'pctChange' ? sortState.value.order : (false as const),
    render: (row) => {
      if (row.pctChange == null) return h('span', {}, '—')
      const v = Number(row.pctChange)
      return h(
        'span',
        { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' },
        `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`,
      )
    },
  },
  {
    title: '净流入(亿)',
    key: 'netAmount',
    width: 110,
    sorter: true,
    sortOrder: sortState.value?.field === 'netAmount' ? sortState.value.order : (false as const),
    render: (row) => {
      if (row.netAmount == null) return h('span', {}, '—')
      const v = Number(row.netAmount)
      return h(
        'span',
        { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' },
        v.toFixed(2),
      )
    },
  },
])

function onUpdateSorter(sorter: { columnKey: string; order: 'ascend' | 'descend' | false } | null) {
  if (!sorter || !sorter.order) {
    sortState.value = null
    return
  }
  if (sorter.columnKey === 'pctChange' || sorter.columnKey === 'netAmount') {
    sortState.value = { field: sorter.columnKey, order: sorter.order }
  }
}

// 添加标签
const addTagLoading = ref(false)
const canAddTag = computed(() => memberRows.value.length > 0 && !!props.entityName?.trim())

async function onAddTag() {
  if (!canAddTag.value) return
  addTagLoading.value = true
  try {
    const res = await watchlistApi.upsertByName({
      name: props.entityName.trim(),
      symbols: memberRows.value.map((r) => r.conCode),
    })
    const msg = res.created
      ? `已新建标签「${res.name}」，加入 ${res.added} 只`
      : `已加入「${res.name}」：新增 ${res.added} 只，跳过已存在 ${res.skipped} 只`
    message.success(msg)
    try {
      await useWatchlistStore().loadWatchlists()
    } catch {
      /* ignore */
    }
  } catch (err: any) {
    message.error(err?.message || '添加标签失败')
  } finally {
    addTagLoading.value = false
  }
}

function resetTrendState() {
  barRows.value = []
  klineBars.value = []
}

async function loadTrend(params: MoneyFlowQueryParams) {
  loading.value = true
  try {
    const result = await props.fetchFn({ ...params, ts_code: props.tsCode })
    if (props.chartMode === 'bar') {
      barRows.value = result as BarChartRow[]
      klineBars.value = []
    } else {
      const r = result as TrendFetchResult
      klineBars.value = r.kline ?? []
      barRows.value = []
    }
  } catch {
    resetTrendState()
  } finally {
    loading.value = false
  }
}

async function recalcKdjIndicators(params?: IndicatorSubplotParams): Promise<void> {
  if (props.chartMode !== 'kline' || klineBars.value.length === 0) return
  const tsCode = props.tsCode
  if (!tsCode) return

  let startDate: string | undefined
  let endDate: string | undefined
  if (klineRange.value) {
    startDate = msToYyyymmdd(klineRange.value[0])
    endDate = msToYyyymmdd(klineRange.value[1])
  } else {
    startDate = klineBars.value[0]?.open_time?.replace(/-/g, '')
    endDate = klineBars.value[klineBars.value.length - 1]?.open_time?.replace(/-/g, '')
  }
  if (!startDate || !endDate) return

  try {
    const recalc = await thsIndexDailyApi.recalc(
      { ts_code: tsCode, start_date: startDate, end_date: endDate },
      { kdjParams: params?.KDJ },
    )
    const kdjMap = new Map(
      recalc.map((bar) => [
        bar.open_time,
        { k: bar['KDJ.K'], d: bar['KDJ.D'], j: bar['KDJ.J'] },
      ]),
    )
    klineBars.value = klineBars.value.map((bar) => {
      const kdj = kdjMap.get(bar.open_time)
      if (!kdj) return bar
      return {
        ...bar,
        'KDJ.K': kdj.k,
        'KDJ.D': kdj.d,
        'KDJ.J': kdj.j,
      }
    })
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    throw err
  }
}

async function loadLatest() {
  // 大盘 / bar 模式：保留原有 limit=30 取最近 30 条的语义
  if (props.chartMode === 'bar') {
    loading.value = true
    try {
      const result = await props.fetchFn({ ts_code: props.tsCode, limit: 30 })
      const data = result as BarChartRow[]
      barRows.value = [...data].reverse()
      klineBars.value = []
    } catch {
      resetTrendState()
    } finally {
      loading.value = false
    }
    return
  }
  // kline 模式不在此处主动加载——首次进入由 FlowDateControl 的初始 emit 触发 loadTrend
  resetTrendState()
}

function onDateChange(params: MoneyFlowQueryParams) {
  if (skipNextEmit) {
    skipNextEmit = false
    return
  }
  loadTrend(params)
}

async function loadMembers() {
  if (membersLoaded) return
  membersLoading.value = true
  try {
    memberRows.value = await moneyFlowApi.getMembers(props.tsCode, props.membersTradeDate ?? undefined)
    membersLoaded = true
  } catch {
    memberRows.value = []
  } finally {
    membersLoading.value = false
  }
}

watch(() => props.visible, (v) => {
  if (v) {
    resetTrendState()
    memberRows.value = []
    membersLoaded = false
    activeTab.value = 'trend'
    sortState.value = { field: 'netAmount', order: 'descend' }
    // bar 模式：直接拉最近 30 条柱状数据，跳过 FlowDateControl 初始 emit
    // kline 模式：FlowDateControl 已移除，由 KlineChart 工具栏管理，初次需主动拉一次
    if (props.chartMode === 'bar') {
      skipNextEmit = true
      loadLatest()
    } else {
      // kline 模式：FlowDateControl 已移除，由 KlineChart 工具栏管理；
      // 用默认 120 天窗口触发首屏加载（initKlineRangeDefault 内置 onApply 重查）。
      initKlineRangeDefault()
    }
  }
})

watch(activeTab, (tab) => {
  if (tab === 'members' && props.showMembersTab) {
    loadMembers()
  }
})
</script>

<style scoped>
.trend-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.members-body {
  min-height: 200px;
}
.members-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.members-toolbar .hint {
  color: var(--color-text-muted);
  font-size: 12px;
}
.empty-state {
  color: var(--color-text-muted);
  text-align: center;
  padding: 40px;
}
.amv-caption {
  display: block;
  margin-top: -8px;
  font-size: 12px;
  line-height: 1.4;
}
:deep(.positive) {
  color: #f04747;
}
:deep(.negative) {
  color: #4caf8a;
}
</style>
