<template>
  <div class="metrics-wrap">
    <n-card class="filter-card" :bordered="false" size="small">
      <n-spin :show="loading" size="small">
        <div class="table-filter-bar">
          <n-input
            v-model:value="searchQuery"
            class="filter-field"
            placeholder="搜索标的..."
            clearable
            :disabled="loading"
            @keyup.enter="applyFilters"
          >
            <template #prefix><n-icon><search-outline /></n-icon></template>
          </n-input>
          <div class="filter-status-item">
            <n-tooltip placement="top">
              <template #trigger>
                <span class="filter-status-label">状态</span>
              </template>
              <div class="run-symbol-metrics-tooltip__status">
                <div><strong>本根买入</strong>：entries 中出现该标的，或相对上一根收盘在本根新增持仓。</div>
                <div><strong>本根卖出</strong>：exits 中出现该标的，或相对上一根收盘在本根减少持仓。</div>
                <div><strong>本根持有</strong>：本根 K 线收盘时仍持仓的标的。</div>
              </div>
            </n-tooltip>
            <n-select
              v-model:value="statusValues"
              class="filter-status-select"
              multiple
              clearable
              placeholder="状态"
              :options="statusFilterOptions"
              :disabled="loading"
              max-tag-count="responsive"
            />
          </div>
          <div v-if="conditions.length" class="filter-tags-inline">
            <n-tag
              v-for="(cond, i) in conditions"
              :key="i"
              :closable="!loading"
              @close="removeCondition(i)"
            >
              {{ cond.field }} {{ opLabels[cond.op] }} {{ cond.value }}
            </n-tag>
          </div>
          <div class="filter-actions">
            <n-popover
              v-model:show="showFilterDrawer"
              trigger="click"
              placement="bottom-end"
              :flip="true"
              :show-arrow="false"
              content-class="advanced-filter-popover-content run-symbol-metrics-popover__content"
            >
              <template #trigger>
                <n-button :disabled="loading">
                  <template #icon><n-icon><filter-outline /></n-icon></template>
                  高级筛选
                  <n-badge v-if="conditions.length" :value="conditions.length" />
                </n-button>
              </template>
              <div class="filter-popover-inner run-symbol-metrics-popover__inner">
                <div class="filter-popover-header">高级筛选</div>
                <div class="filter-form">
                  <h4>可用字段</h4>
                  <n-select
                    ref="fieldSelectRef"
                    v-model:value="newCondition.field"
                    :options="fieldOptions"
                    placeholder="选择字段"
                  />
                  <h4>操作符</h4>
                  <n-select v-model:value="newCondition.op" :options="opOptions" placeholder="选择操作符" />
                  <h4>数值</h4>
                  <n-input-number v-model:value="newCondition.value" style="width: 100%" />
                  <n-button
                    type="primary"
                    block
                    :disabled="!canAddCondition"
                    style="margin-top: 12px"
                    @click="addCondition"
                  >
                    添加条件
                  </n-button>
                  <n-divider />
                  <h4>当前条件</h4>
                  <n-empty
                    v-if="!conditions.length"
                    class="filter-conditions-empty"
                    description="暂无筛选条件"
                  >
                    <template #extra>
                      <span class="filter-empty-hint">在上方选择字段、操作符与数值后，点击「添加条件」</span>
                    </template>
                  </n-empty>
                  <div v-else class="condition-list">
                    <div v-for="(cond, i) in conditions" :key="i" class="condition-item">
                      <span>{{ cond.field }} {{ opLabels[cond.op] }} {{ cond.value }}</span>
                      <n-button quaternary circle size="small" @click="removeCondition(i)">
                        <template #icon><n-icon><close-outline /></n-icon></template>
                      </n-button>
                    </div>
                  </div>
                </div>
              </div>
            </n-popover>
            <n-button :disabled="loading" @click="resetFilters">重置</n-button>
            <n-button type="primary" :disabled="loading" @click="applyFilters">应用筛选</n-button>
          </div>
        </div>
      </n-spin>
    </n-card>

    <n-card class="data-card" :bordered="false" size="small" title="本根 K · 回测标的池指标">
      <n-data-table
        :columns="columns"
        :data="items"
        :loading="loading"
        :pagination="paginationState"
        :scroll-x="1360"
        remote
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
        @update:sorter="handleSort"
      />
    </n-card>

    <KlineChartModal
      v-model:show="klineModalShow"
      :run-id="runId"
      :ts="ts"
      :symbol="klineSymbol"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, h, nextTick } from 'vue'
import {
  NButton,
  NIcon,
  NInput,
  NBadge,
  NTag,
  NCard,
  NDataTable,
  NInputNumber,
  NDivider,
  NEmpty,
  NPopover,
  NSelect,
  NSpin,
  NTooltip,
  useMessage,
  type DataTableSortState,
  NTag as NTagComponent,
} from 'naive-ui'

/** n-data-table 列 sortOrder 与 remote 表头高亮一致 */
type ColSortOrder = false | 'ascend' | 'descend'
import { SearchOutline, FilterOutline, CloseOutline } from '@vicons/ionicons5'
import { backtestApi, symbolApi, type RunSymbolMetricRow } from '../../composables/useApi'
import KlineChartModal from './KlineChartModal.vue'

const props = defineProps<{
  show: boolean
  runId: string
  ts: string
}>()

const message = useMessage()

const searchQuery = ref('')

type StatusFilterValue = 'buy' | 'sell' | 'hold'
const STATUS_BUY: StatusFilterValue = 'buy'
const STATUS_SELL: StatusFilterValue = 'sell'
const STATUS_HOLD: StatusFilterValue = 'hold'
const statusFilterOptions: { label: string; value: StatusFilterValue }[] = [
  { label: '本根买入', value: STATUS_BUY },
  { label: '本根卖出', value: STATUS_SELL },
  { label: '本根持有', value: STATUS_HOLD },
]
const statusValues = ref<StatusFilterValue[]>([STATUS_BUY, STATUS_SELL, STATUS_HOLD])
const showFilterDrawer = ref(false)
const fieldSelectRef = ref<{ focus: () => void } | null>(null)
const klineModalShow = ref(false)
const klineSymbol = ref<string | null>(null)
const loading = ref(false)
const items = ref<RunSymbolMetricRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)

const conditions = ref<{ field: string; op: string; value: number }[]>([])
const newCondition = ref({ field: '', op: 'gt', value: 0 })
const fieldOptions = ref<{ label: string; value: string }[]>([])

const opOptions = [
  { label: '大于', value: 'gt' },
  { label: '小于', value: 'lt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于等于', value: 'lte' },
]
const opLabels: Record<string, string> = { gt: '>', lt: '<', gte: '≥', lte: '≤' }
const canAddCondition = computed(() => !!newCondition.value.field)

const sortKey = ref('symbol')
const sortOrder = ref<'ascend' | 'descend' | null>(null)
const explicitSort = ref(false)

const paginationState = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `共 ${total.value} 条`,
}))

const headerOrder = (key: string): ColSortOrder =>
  explicitSort.value && sortKey.value === key
    ? sortOrder.value === 'descend'
      ? 'descend'
      : 'ascend'
    : false

const fmtNum = (v: number | null | undefined, d = 4) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '-' : Number(v).toFixed(d)

const openKline = (symbol: string) => {
  klineSymbol.value = symbol
  klineModalShow.value = true
}

const columns = computed(() => [
  {
    title: '标的',
    key: 'symbol',
    width: 120,
    fixed: 'left' as const,
    sortOrder: headerOrder('symbol'),
    sorter: true,
  },
  {
    title: '数据',
    key: 'dataStatus',
    width: 88,
    sortOrder: headerOrder('dataStatus'),
    sorter: true,
    render: (r: RunSymbolMetricRow) =>
      r.dataStatus === 'missing'
        ? h(
            NTagComponent,
            { type: 'warning', size: 'small' },
            { default: () => '缺数据' },
          )
        : h(NTagComponent, { type: 'success', size: 'small', bordered: false }, { default: () => '正常' }),
  },
  {
    title: '状态',
    key: 'barStatus',
    width: 200,
    render: (r: RunSymbolMetricRow) => {
      if (!r.buyOnBar && !r.sellOnBar && !r.holdAtClose) return '—'
      const nodes: ReturnType<typeof h>[] = []
      if (r.buyOnBar) {
        nodes.push(h(NTagComponent, { type: 'info', size: 'small' }, { default: () => '本根买入' }))
      }
      if (r.sellOnBar) {
        nodes.push(h(NTagComponent, { type: 'warning', size: 'small' }, { default: () => '本根卖出' }))
      }
      if (r.holdAtClose) {
        nodes.push(h(NTagComponent, { type: 'success', size: 'small' }, { default: () => '本根持有' }))
      }
      return h('div', { class: 'metric-row-status-tags' }, nodes)
    },
  },
  {
    title: '收盘价',
    key: 'close',
    width: 110,
    sortOrder: headerOrder('close'),
    sorter: true,
    render: (r: RunSymbolMetricRow) => (r.dataStatus === 'missing' ? '-' : fmtNum(r.close, 6)),
  },
  {
    title: 'MA5',
    key: 'ma5',
    width: 100,
    sortOrder: headerOrder('ma5'),
    sorter: true,
    render: (r: RunSymbolMetricRow) => (r.dataStatus === 'missing' ? '-' : fmtNum(r.ma5, 4)),
  },
  {
    title: 'MA30',
    key: 'ma30',
    width: 100,
    sortOrder: headerOrder('ma30'),
    sorter: true,
    render: (r: RunSymbolMetricRow) => (r.dataStatus === 'missing' ? '-' : fmtNum(r.ma30, 4)),
  },
  {
    title: 'MA60',
    key: 'ma60',
    width: 100,
    sortOrder: headerOrder('ma60'),
    sorter: true,
    render: (r: RunSymbolMetricRow) => (r.dataStatus === 'missing' ? '-' : fmtNum(r.ma60, 4)),
  },
  {
    title: 'KDJ.J',
    key: 'kdjJ',
    width: 90,
    sortOrder: headerOrder('kdjJ'),
    sorter: true,
    render: (r: RunSymbolMetricRow) => (r.dataStatus === 'missing' ? '-' : fmtNum(r.kdjJ, 2)),
  },
  {
    title: '盈亏比',
    key: 'riskRewardRatio',
    width: 90,
    sortOrder: headerOrder('riskRewardRatio'),
    sorter: true,
    render: (r: RunSymbolMetricRow) => (r.dataStatus === 'missing' ? '-' : fmtNum(r.riskRewardRatio, 2)),
  },
  {
    title: '止损%',
    key: 'stopLossPct',
    width: 90,
    sortOrder: headerOrder('stopLossPct'),
    sorter: true,
    render: (r: RunSymbolMetricRow) =>
      r.dataStatus === 'missing' || r.stopLossPct == null ? '-' : `${fmtNum(r.stopLossPct, 2)}%`,
  },
  {
    title: '操作',
    key: 'actions',
    width: 96,
    fixed: 'right' as const,
    render: (r: RunSymbolMetricRow) =>
      h(
        NButton,
        { size: 'small', type: 'primary', quaternary: true, onClick: () => openKline(r.symbol) },
        { default: () => 'K线' },
      ),
  },
])

const buildBody = () => ({
  ts: props.ts,
  q: searchQuery.value,
  conditions: conditions.value,
  sort: {
    field: explicitSort.value ? sortKey.value : 'symbol',
    asc: explicitSort.value ? sortOrder.value !== 'descend' : true,
  },
  page: page.value,
  page_size: pageSize.value,
  only_buy_on_bar: statusValues.value.includes(STATUS_BUY),
  only_sell_on_bar: statusValues.value.includes(STATUS_SELL),
  only_open_at_close: statusValues.value.includes(STATUS_HOLD),
})

const loadData = async () => {
  if (!props.show || !props.runId || !props.ts.trim()) return
  loading.value = true
  try {
    const res = await backtestApi.querySymbolMetrics(props.runId, buildBody())
    items.value = res.items
    total.value = res.total
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

const loadFields = async () => {
  try {
    const cols = await symbolApi.getKlineColumns()
    fieldOptions.value = cols.map((c) => ({ label: c, value: c }))
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const applyFilters = () => {
  page.value = 1
  loadData()
}

const resetFilters = () => {
  conditions.value = []
  searchQuery.value = ''
  statusValues.value = []
  page.value = 1
  explicitSort.value = false
  sortKey.value = 'symbol'
  sortOrder.value = null
  loadData()
}

const addCondition = () => {
  if (!canAddCondition.value) return
  conditions.value.push({ ...newCondition.value })
  newCondition.value = { field: '', op: 'gt', value: 0 }
}

const removeCondition = (i: number) => {
  conditions.value.splice(i, 1)
  applyFilters()
}

const handlePageChange = (p: number) => {
  page.value = p
  loadData()
}

const handlePageSizeChange = (s: number) => {
  pageSize.value = s
  page.value = 1
  loadData()
}

const handleSort = (sorter: DataTableSortState | DataTableSortState[] | null) => {
  const s = Array.isArray(sorter) ? sorter[0] : sorter
  const o = s?.order
  if (o === false || o === undefined) {
    explicitSort.value = false
    sortKey.value = 'symbol'
    sortOrder.value = null
  } else {
    explicitSort.value = true
    sortKey.value = (s?.columnKey as string) ?? 'symbol'
    sortOrder.value = o
  }
  page.value = 1
  loadData()
}

watch(showFilterDrawer, (open) => {
  if (!open) return
  void nextTick(() => {
    fieldSelectRef.value?.focus()
  })
})

watch(
  () => [props.show, props.runId, props.ts] as const,
  ([visible]) => {
    if (!visible || !props.runId || !props.ts.trim()) {
      items.value = []
      total.value = 0
      klineModalShow.value = false
      klineSymbol.value = null
      return
    }
    page.value = 1
    loadData()
  },
)

onMounted(() => {
  loadFields()
  if (props.show && props.runId && props.ts.trim()) loadData()
})
</script>

<style scoped src="./candle-run-symbol-metrics.css"></style>
<style>
/* n-tooltip / n-popover 内容 teleport 到 body，不受 scoped 约束；类名加前缀避免污染全局 */
.run-symbol-metrics-tooltip__status {
  max-width: 280px;
  line-height: 1.5;
  font-size: 13px;
}
.run-symbol-metrics-tooltip__status > div + div {
  margin-top: 8px;
}
.run-symbol-metrics-popover__content {
  padding: 0;
  border-radius: 8px;
  box-shadow:
    0 4px 16px rgba(28, 25, 23, 0.08),
    0 0 0 1px rgba(28, 25, 23, 0.06);
}
.run-symbol-metrics-popover__inner {
  width: min(400px, calc(100vw - 24px));
  max-width: 100%;
  box-sizing: border-box;
  padding: 12px 16px 16px;
  background: var(--n-color);
}
.run-symbol-metrics-popover__inner .filter-popover-header {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color-1);
  letter-spacing: 0.02em;
}
.run-symbol-metrics-popover__inner .filter-form h4:first-of-type {
  margin-top: 0;
}
.run-symbol-metrics-popover__inner .filter-conditions-empty {
  margin-top: 4px;
  padding: 20px 16px;
  border-radius: 8px;
  background: rgba(120, 113, 108, 0.06);
  border: 1px solid rgba(120, 113, 108, 0.12);
}
.run-symbol-metrics-popover__inner .filter-conditions-empty .n-empty__description {
  margin-top: 8px;
  font-size: 13px;
  color: var(--n-text-color-2);
}
.run-symbol-metrics-popover__inner .filter-empty-hint {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--n-text-color-3);
  text-align: center;
  max-width: 280px;
  margin-left: auto;
  margin-right: auto;
}
@media (max-width: 420px) {
  .run-symbol-metrics-popover__inner {
    width: calc(100vw - 24px);
  }
}
</style>
