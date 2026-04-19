<template>
  <div class="backtest-detail">
    <n-empty v-if="!run && !loading" description="暂无回测结果，请先运行回测" />
    <n-spin v-else-if="loading" style="width:100%;padding:60px 0;display:flex;justify-content:center" />

    <template v-else-if="run">
      <div class="run-selector">
        <n-select
          v-model:value="selectedRunId"
          :options="runOptions"
          @update:value="loadRun"
          style="width: 280px"
        />
      </div>

      <template v-if="reportData">
        <n-tabs v-model:value="activeTab" type="line" animated>
          <n-tab-pane name="kpiOverview" tab="统计概况">
            <div class="stats-grid">
              <div v-for="item in statItems" :key="item.label" class="stat-item">
                <span class="label">{{ item.label }}</span>
                <span class="value" :class="item.cls">{{ item.value }}</span>
              </div>
            </div>
            <div ref="chartRef" class="chart-container" style="margin-top:16px"></div>
          </n-tab-pane>

          <n-tab-pane name="positions" :tab="`仓位记录（${reportData?.totalPositions ?? 0} 次）`">
            <div class="table-filter-bar">
              <n-select
                v-model:value="posFiltersDraft.symbol"
                :options="symbolOptions"
                filterable
                clearable
                placeholder="标的"
                class="filter-field"
              />
              <n-input-number v-model:value="posFiltersDraft.pnlMin" clearable placeholder="最小盈亏" class="filter-field" />
              <n-input-number v-model:value="posFiltersDraft.pnlMax" clearable placeholder="最大盈亏" class="filter-field" />
              <n-input-number v-model:value="posFiltersDraft.returnPctMin" clearable placeholder="最小收益率%" class="filter-field" />
              <n-input-number v-model:value="posFiltersDraft.returnPctMax" clearable placeholder="最大收益率%" class="filter-field" />
              <n-select
                v-model:value="posFiltersDraft.stopType"
                :options="stopTypeOptions"
                filterable
                clearable
                placeholder="出场原因"
                class="filter-field"
              />
              <n-date-picker
                v-model:formatted-value="posFiltersDraft.entryStart"
                type="datetime"
                value-format="yyyy-MM-dd HH:mm:ss"
                clearable
                placeholder="买入开始时间"
                class="filter-field filter-date"
              />
              <n-date-picker
                v-model:formatted-value="posFiltersDraft.entryEnd"
                type="datetime"
                value-format="yyyy-MM-dd HH:mm:ss"
                clearable
                placeholder="买入结束时间"
                class="filter-field filter-date"
              />
              <n-date-picker
                v-model:formatted-value="posFiltersDraft.closeStart"
                type="datetime"
                value-format="yyyy-MM-dd HH:mm:ss"
                clearable
                placeholder="平仓开始时间"
                class="filter-field filter-date"
              />
              <n-date-picker
                v-model:formatted-value="posFiltersDraft.closeEnd"
                type="datetime"
                value-format="yyyy-MM-dd HH:mm:ss"
                clearable
                placeholder="平仓结束时间"
                class="filter-field filter-date"
              />
              <div class="filter-actions">
                <n-button type="primary" :loading="posLoading" @click="applyPosFilters">查询</n-button>
                <n-button :disabled="posLoading" @click="resetPosFilters">重置</n-button>
              </div>
            </div>
            <n-data-table
              remote
              :columns="posColumns"
              :data="posRows"
              :pagination="posPagination"
              :empty-text="posEmptyText"
              :loading="posLoading"
              @update:page="onPosPage"
              @update:page-size="onPosPageSize"
              @update:sorter="onPosSort"
              size="small"
            />
          </n-tab-pane>

          <n-tab-pane name="symbols" tab="标的盈亏统计">
            <div class="table-filter-bar">
              <n-select
                v-model:value="symFiltersDraft.symbol"
                :options="symbolOptions"
                filterable
                clearable
                placeholder="标的"
                class="filter-field"
              />
              <n-input-number v-model:value="symFiltersDraft.totalPnlMin" clearable placeholder="最小总盈亏" class="filter-field" />
              <n-input-number v-model:value="symFiltersDraft.totalPnlMax" clearable placeholder="最大总盈亏" class="filter-field" />
              <n-input-number v-model:value="symFiltersDraft.winRateMin" clearable placeholder="最小胜率%" class="filter-field" />
              <n-input-number v-model:value="symFiltersDraft.winRateMax" clearable placeholder="最大胜率%" class="filter-field" />
              <div class="filter-actions">
                <n-button type="primary" :loading="symLoading" @click="applySymFilters">查询</n-button>
                <n-button :disabled="symLoading" @click="resetSymFilters">重置</n-button>
              </div>
            </div>
            <n-data-table
              remote
              :columns="symColumns"
              :data="symRows"
              :pagination="symPagination"
              :empty-text="symEmptyText"
              :loading="symLoading"
              @update:page="onSymPage"
              @update:page-size="onSymPageSize"
              @update:sorter="onSymSort"
              size="small"
            />
          </n-tab-pane>

          <n-tab-pane name="candleLog" tab="K线记录">
            <div class="table-filter-bar">
              <n-select
                v-model:value="candleFiltersDraft.symbol"
                :options="symbolOptions"
                filterable
                clearable
                placeholder="标的"
                class="filter-field"
              />
              <n-select
                v-model:value="candleFiltersDraft.inCooldown"
                :options="cooldownOptions"
                clearable
                placeholder="是否冷却中"
                class="filter-field"
              />
              <n-date-picker
                v-model:formatted-value="candleFiltersDraft.startTs"
                type="datetime"
                value-format="yyyy-MM-dd HH:mm:ss"
                clearable
                placeholder="开始时间"
                class="filter-field filter-date"
              />
              <n-date-picker
                v-model:formatted-value="candleFiltersDraft.endTs"
                type="datetime"
                value-format="yyyy-MM-dd HH:mm:ss"
                clearable
                placeholder="结束时间"
                class="filter-field filter-date"
              />
              <n-input-number v-model:value="candleFiltersDraft.equityChangeMin" clearable placeholder="净值变化最小值" class="filter-field" />
              <n-input-number v-model:value="candleFiltersDraft.equityChangeMax" clearable placeholder="净值变化最大值" class="filter-field" />
              <n-input-number v-model:value="candleFiltersDraft.equityChangePctMin" clearable placeholder="净值变化%最小值" class="filter-field" />
              <n-input-number v-model:value="candleFiltersDraft.equityChangePctMax" clearable placeholder="净值变化%最大值" class="filter-field" />
              <n-checkbox v-model:checked="candleFiltersDraft.onlyWithAction">仅显示有操作的K线</n-checkbox>
              <div class="filter-actions">
                <n-button type="primary" :loading="candleLogLoading" @click="applyCandleFilters">查询</n-button>
                <n-button :disabled="candleLogLoading" @click="resetCandleFilters">重置</n-button>
              </div>
            </div>
            <n-data-table
              remote
              :columns="candleLogColumns"
              :data="candleLogRows"
              :pagination="candleLogPagination"
              :empty-text="candleEmptyText"
              :loading="candleLogLoading"
              @update:page="onCandleLogPage"
              @update:page-size="onCandleLogPageSize"
              @update:sorter="onCandleLogSort"
              size="small"
            />
          </n-tab-pane>

          <n-tab-pane name="config" tab="策略配置">
            <n-empty v-if="!configSnapshot" description="该历史回测未记录配置快照" />
            <template v-else>
              <div class="config-toolbar">
                <n-button size="small" @click="toggleConfigView">
                  {{ configView === 'form' ? '切换到 JSON 视图' : '切换到表单视图' }}
                </n-button>
                <template v-if="configView === 'json'">
                  <n-button size="small" @click="selectAllJson">全选</n-button>
                  <n-button size="small" @click="toggleFoldAll">
                    {{ allFolded ? '展开全部' : '折叠全部' }}
                  </n-button>
                </template>
                <n-button size="small" @click="copyConfig">复制 JSON</n-button>
              </div>

              <template v-if="configView === 'form'">
                <n-descriptions
                  v-for="grp in visibleConfigGroups"
                  :key="grp.title"
                  :title="grp.title"
                  bordered
                  :column="2"
                  size="small"
                  label-placement="left"
                  class="config-group"
                >
                  <n-descriptions-item
                    v-for="f in grp.fields"
                    :key="f.key"
                    :label="f.label"
                  >
                    {{ formatConfigValue(f.key, configSnapshot[f.key]) }}
                  </n-descriptions-item>
                </n-descriptions>
              </template>

              <div v-else ref="jsonViewRef" class="json-view">
                <span class="json-brace">{</span>
                <div
                  v-for="(key, idx) in jsonKeys"
                  :key="key"
                  class="json-line"
                >
                  <span class="json-key">"{{ key }}"</span><span class="json-punct">: </span>
                  <template v-if="isArray(configSnapshot[key])">
                    <span class="json-toggle" @click="toggleFold(key)">{{ foldedKeys.has(key) ? '▶' : '▼' }}</span>
                    <span class="json-bracket">[</span>
                    <template v-if="!foldedKeys.has(key)">
                      <template
                        v-for="(item, i) in (configSnapshot[key] as unknown[])"
                        :key="i"
                      >
                        <span :class="primClass(item)">{{ primText(item) }}</span>
                        <span
                          v-if="i < (configSnapshot[key] as unknown[]).length - 1"
                          class="json-punct"
                        >, </span>
                      </template>
                    </template>
                    <span v-else class="json-ellipsis">…{{ (configSnapshot[key] as unknown[]).length }} 项</span>
                    <span class="json-bracket">]</span>
                  </template>
                  <template v-else>
                    <span :class="primClass(configSnapshot[key])">{{ primText(configSnapshot[key]) }}</span>
                  </template>
                  <span v-if="idx < jsonKeys.length - 1" class="json-punct">,</span>
                </div>
                <span class="json-brace">}</span>
              </div>
            </template>
          </n-tab-pane>
        </n-tabs>
      </template>
    </template>
  </div>

  <CandleDetailModal
    v-model:show="showCandleDetail"
    :candle-row="selectedCandleRow"
    :run-id="selectedRunId"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as echarts from 'echarts'
import {
  useMessage,
  NEmpty, NSpin, NSelect, NDataTable, NTabs, NTabPane,
  NDescriptions, NDescriptionsItem, NButton, NCheckbox, NInputNumber, NDatePicker,
} from 'naive-ui'
import { backtestApi } from '../../composables/useApi'
import { useTheme } from '../../composables/useTheme'
import { useBacktestCandleLog } from '../../composables/useBacktestCandleLog'
import { useBacktestPositions } from '../../composables/useBacktestPositions'
import { useBacktestSymbols } from '../../composables/useBacktestSymbols'
import { useBacktestConfigSnapshot } from '../../composables/useBacktestConfigSnapshot'
import CandleDetailModal from './CandleDetailModal.vue'

const props = defineProps<{ strategy: any; run: any; loading: boolean }>()

const message = useMessage()
const { echartsTheme } = useTheme()
const chartRef = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

const allRuns = ref<any[]>([])
const selectedRunId = ref<string | null>(null)
const currentRunDetail = ref<any>(null)
const reportData = ref<any>(null)
const activeTab = ref<'kpiOverview' | 'positions' | 'symbols' | 'config' | 'candleLog'>('kpiOverview')

const runOptions = computed(() =>
  allRuns.value.map((r) => ({
    label: `${new Date(r.createdAt).toLocaleString('zh-CN')} · ${r.timeframe}`,
    value: r.id,
  })),
)

const statItems = computed(() => {
  const s = reportData.value?.stats
  if (!s) return []
  return [
    { label: '总收益率', value: `${s.totalReturnPct?.toFixed(2)}%`, cls: s.totalReturnPct >= 0 ? 'trend-up' : 'trend-down' },
    { label: '最终净值', value: `${s.finalValue?.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} USDT`, cls: '' },
    { label: '最大回撤', value: `${s.maxDrawdownPct?.toFixed(2)}%`, cls: 'trend-down' },
    { label: '夏普率(年化)', value: s.sharpeAnnualized?.toFixed(3) ?? '-', cls: '' },
    { label: '完整交易次数', value: s.fullTradeCount ?? 0, cls: '' },
    { label: '胜率', value: `${s.winRate?.toFixed(1)}%`, cls: '' },
    { label: '胜场平均收益', value: `${s.avgWinReturnPct?.toFixed(2)}%`, cls: 'trend-up' },
    { label: '败场平均亏损', value: `${s.avgLossReturnPct?.toFixed(2)}%`, cls: 'trend-down' },
    { label: '平均持仓周期', value: `${s.avgHoldCandles?.toFixed(1)} 根`, cls: '' },
    { label: '满仓K时长', value: `${s.fullPositionBars ?? 0} 根 (${s.fullPositionPct?.toFixed(1) ?? '0.0'}%)`, cls: '' },
  ]
})

const {
  rows: posRows,
  loading: posLoading,
  pagination: posPagination,
  columns: posColumns,
  filtersDraft: posFiltersDraft,
  emptyText: posEmptyText,
  applyFilters: applyPosFilters,
  resetFilters: resetPosFilters,
  onPage: onPosPage,
  onPageSize: onPosPageSize,
  onSort: onPosSort,
} = useBacktestPositions(selectedRunId, activeTab)

const {
  rows: symRows,
  loading: symLoading,
  pagination: symPagination,
  columns: symColumns,
  filtersDraft: symFiltersDraft,
  emptyText: symEmptyText,
  applyFilters: applySymFilters,
  resetFilters: resetSymFilters,
  onPage: onSymPage,
  onPageSize: onSymPageSize,
  onSort: onSymSort,
} = useBacktestSymbols(selectedRunId, activeTab)

const {
  candleLogRows, candleLogLoading,
  filtersDraft: candleFiltersDraft,
  emptyText: candleEmptyText,
  candleLogPagination, candleLogColumns,
  applyFilters: applyCandleFilters,
  resetFilters: resetCandleFilters,
  onCandleLogPage, onCandleLogPageSize, onCandleLogSort,
  showCandleDetail, selectedCandleRow,
} = useBacktestCandleLog(selectedRunId, activeTab)

const {
  configSnapshot, visibleConfigGroups, configView, foldedKeys, jsonViewRef,
  jsonKeys, allFolded, formatConfigValue, isArray, primClass, primText,
  toggleConfigView, toggleFold, toggleFoldAll, selectAllJson, copyConfig,
} = useBacktestConfigSnapshot(allRuns, selectedRunId)

const symbolOptions = computed(() => {
  const values = new Set<string>()
  for (const item of currentRunDetail.value?.symbols ?? []) {
    if (typeof item === 'string' && item.trim()) values.add(item.trim())
  }
  for (const row of reportData.value?.positions ?? []) {
    if (typeof row?.symbol === 'string' && row.symbol.trim()) values.add(row.symbol.trim())
  }
  for (const row of reportData.value?.symbols ?? []) {
    if (typeof row?.symbol === 'string' && row.symbol.trim()) values.add(row.symbol.trim())
  }
  return [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ label: value, value }))
})

const stopTypeOptions = computed(() => {
  const values = new Set<string>()
  for (const row of reportData.value?.positions ?? []) {
    if (!Array.isArray(row?.stopTypes)) continue
    for (const stopType of row.stopTypes) {
      if (typeof stopType === 'string' && stopType.trim()) values.add(stopType.trim())
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ label: value, value }))
})

const cooldownOptions = [
  { label: '冷却中', value: true },
  { label: '非冷却中', value: false },
]

const renderChart = () => {
  if (!chartRef.value || !reportData.value?.portfolio) return
  if (chart) chart.dispose()
  chart = echarts.init(chartRef.value)
  const { labels, values } = reportData.value.portfolio
  chart.setOption({
    ...echartsTheme.value,
    tooltip: { trigger: 'axis' },
    grid: { left: '8%', right: '4%', bottom: '12%', top: '8%' },
    xAxis: { type: 'category', data: labels, axisLabel: { rotate: 30 } },
    yAxis: { type: 'value', scale: true },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }, { type: 'slider' }],
    series: [{ name: '净值', type: 'line', data: values, smooth: false, showSymbol: false, areaStyle: { opacity: 0.2 } }],
  })
}

const loadRun = async (runId: string) => {
  try {
    const full = await backtestApi.getRun(runId)
    currentRunDetail.value = full ?? null
    reportData.value = full?.stats ?? null
    activeTab.value = 'kpiOverview'
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

watch([activeTab, reportData], ([tab, data]) => {
  if (tab === 'kpiOverview' && data?.portfolio) nextTick(() => renderChart())
})

watch(() => props.run, async (r) => {
  if (!r) { currentRunDetail.value = null; reportData.value = null; return }
  try {
    allRuns.value = await backtestApi.listRuns(props.strategy.id)
    if (allRuns.value.length) {
      selectedRunId.value = allRuns.value[0].id
      await loadRun(selectedRunId.value)
    }
  } catch { /* ignore */ }
}, { immediate: true })

onMounted(() => { window.addEventListener('resize', () => chart?.resize()) })
onUnmounted(() => { chart?.dispose(); window.removeEventListener('resize', () => chart?.resize()) })
</script>

<style scoped>
.backtest-detail { padding: 16px 20px; }
.run-selector { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 16px; }
.stat-item { background: var(--ember-surface); border: 1px solid var(--ember-border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.label { font-size: 12px; color: var(--ember-neutral); }
.value { font-size: 15px; font-weight: 600; color: var(--ember-text); }
.section-title { font-family: 'Source Sans 3', sans-serif; font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--ember-text); }
.chart-container { height: 300px; width: 100%; }
.table-filter-bar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; align-items: center; }
.filter-field { width: 160px; }
.filter-date { width: 220px; }
.filter-actions { display: flex; gap: 8px; margin-left: auto; }
.config-toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 12px; }
.config-group { margin-bottom: 20px; }
.json-view {
  font-family: 'Source Code Pro', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.6;
  background: var(--ember-surface);
  border: 1px solid var(--ember-border);
  border-radius: 8px;
  padding: 16px 20px;
  color: var(--ember-text);
  user-select: text;
}
.json-line { padding-left: 20px; }
.json-brace, .json-bracket { color: var(--ember-text-secondary); }
.json-key { color: var(--ember-warning); }
.json-string { color: var(--ember-success); }
.json-number { color: var(--ember-primary); }
.json-boolean { color: var(--ember-info, #60a5fa); }
.json-null { color: var(--ember-neutral); font-style: italic; }
.json-punct { color: var(--ember-text-secondary); }
.json-toggle {
  display: inline-block;
  width: 14px;
  cursor: pointer;
  color: var(--ember-text-secondary);
  user-select: none;
  margin-right: 2px;
}
.json-toggle:hover { color: var(--ember-primary); }
.json-ellipsis { color: var(--ember-neutral); font-style: italic; margin: 0 4px; }
</style>
