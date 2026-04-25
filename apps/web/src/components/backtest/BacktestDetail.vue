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

          <n-tab-pane name="positions" :tab="`仓位记录（${positionTabCount} 次）`">
            <div class="table-filter-bar">
              <n-select v-model:value="posFiltersDraft.symbol" :options="symbolOptions" filterable clearable placeholder="标的" class="filter-field" />
              <n-input-number v-model:value="posFiltersDraft.pnlMin" clearable placeholder="最小盈亏" class="filter-field" />
              <n-input-number v-model:value="posFiltersDraft.pnlMax" clearable placeholder="最大盈亏" class="filter-field" />
              <n-input-number v-model:value="posFiltersDraft.returnPctMin" clearable placeholder="最小收益率%" class="filter-field" />
              <n-input-number v-model:value="posFiltersDraft.returnPctMax" clearable placeholder="最大收益率%" class="filter-field" />
              <n-select v-model:value="posFiltersDraft.stopType" :options="stopTypeOptions" filterable clearable placeholder="出场原因" class="filter-field" />
              <n-date-picker v-model:formatted-value="posFiltersDraft.entryStart" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" clearable placeholder="买入开始时间" class="filter-field filter-date" />
              <n-date-picker v-model:formatted-value="posFiltersDraft.entryEnd" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" clearable placeholder="买入结束时间" class="filter-field filter-date" />
              <n-date-picker v-model:formatted-value="posFiltersDraft.closeStart" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" clearable placeholder="平仓开始时间" class="filter-field filter-date" />
              <n-date-picker v-model:formatted-value="posFiltersDraft.closeEnd" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" clearable placeholder="平仓结束时间" class="filter-field filter-date" />
              <div class="filter-actions">
                <n-button type="primary" :loading="posLoading" @click="applyPosFilters">查询</n-button>
                <n-button :disabled="posLoading" @click="resetPosFilters">重置</n-button>
              </div>
            </div>
            <div class="detail-table-shell">
              <n-data-table
                class="detail-data-table"
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
            </div>
          </n-tab-pane>

          <n-tab-pane name="symbols" :tab="`标的盈亏统计（${symbolTabCount} 个）`">
            <div class="table-filter-bar">
              <n-select v-model:value="symFiltersDraft.symbol" :options="symbolOptions" filterable clearable placeholder="标的" class="filter-field" />
              <n-input-number v-model:value="symFiltersDraft.totalPnlMin" clearable placeholder="最小总盈亏" class="filter-field" />
              <n-input-number v-model:value="symFiltersDraft.totalPnlMax" clearable placeholder="最大总盈亏" class="filter-field" />
              <n-input-number v-model:value="symFiltersDraft.winRateMin" clearable placeholder="最小胜率%" class="filter-field" />
              <n-input-number v-model:value="symFiltersDraft.winRateMax" clearable placeholder="最大胜率%" class="filter-field" />
              <div class="filter-actions">
                <n-button type="primary" :loading="symLoading" @click="applySymFilters">查询</n-button>
                <n-button :disabled="symLoading" @click="resetSymFilters">重置</n-button>
              </div>
            </div>
            <div class="detail-table-shell">
              <n-data-table
                class="detail-data-table"
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
            </div>
          </n-tab-pane>

          <n-tab-pane name="candleLog" :tab="`K线记录（${candleLogTotal} 根）`">
            <div class="table-filter-bar">
              <n-select v-model:value="candleFiltersDraft.symbol" :options="symbolOptions" filterable clearable placeholder="标的" class="filter-field" />
              <n-select v-model:value="candleFiltersDraft.inCooldown" :options="cooldownOptions" clearable placeholder="是否冷却中" class="filter-field" />
              <n-select v-model:value="candleFiltersDraft.isSimulation" :options="simulationOptions" clearable placeholder="模拟/实盘" class="filter-field" />
              <n-select
                v-model:value="candleFiltersDraft.tradeStates"
                :options="candleTradeStateFilterOptions"
                multiple
                filterable
                placeholder="交易状态"
                class="filter-field filter-trade-states"
                :disabled="candleLogLoading"
              />
              <n-date-picker v-model:formatted-value="candleFiltersDraft.startTs" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" clearable placeholder="开始时间" class="filter-field filter-date" />
              <n-date-picker v-model:formatted-value="candleFiltersDraft.endTs" type="datetime" value-format="yyyy-MM-dd HH:mm:ss" clearable placeholder="结束时间" class="filter-field filter-date" />
              <n-input-number v-model:value="candleFiltersDraft.equityChangeMin" clearable placeholder="净值变化最小值" class="filter-field" />
              <n-input-number v-model:value="candleFiltersDraft.equityChangeMax" clearable placeholder="净值变化最大值" class="filter-field" />
              <n-input-number v-model:value="candleFiltersDraft.equityChangePctMin" clearable placeholder="净值变化%最小值" class="filter-field" />
              <n-input-number v-model:value="candleFiltersDraft.equityChangePctMax" clearable placeholder="净值变化%最大值" class="filter-field" />
              <n-input-number v-model:value="candleFiltersDraft.cooldownDurationMin" clearable placeholder="冷却期长度最小值" class="filter-field" :precision="0" />
              <n-input-number v-model:value="candleFiltersDraft.cooldownDurationMax" clearable placeholder="冷却期长度最大值" class="filter-field" :precision="0" />
              <n-input-number v-model:value="candleFiltersDraft.cooldownRemainingMin" clearable placeholder="剩余冷却最小值" class="filter-field" :precision="0" />
              <n-input-number v-model:value="candleFiltersDraft.cooldownRemainingMax" clearable placeholder="剩余冷却最大值" class="filter-field" :precision="0" />
              <div class="filter-actions">
                <n-button type="primary" :loading="candleLogLoading" @click="applyCandleFilters">查询</n-button>
                <n-button :disabled="candleLogLoading" @click="resetCandleFilters">重置</n-button>
              </div>
            </div>
            <div class="detail-table-shell">
              <n-data-table
                class="detail-data-table"
                remote
                :columns="candleLogColumns"
                :data="candleLogRows"
                :empty-text="candleEmptyText"
                :loading="candleLogLoading"
                :row-props="candleLogRowProps"
                @update:sorter="onCandleLogSort"
                size="small"
              />
              <div class="candle-table-footer">
                <span class="record-count">
                  <template v-if="candleHasAppliedFilters">筛选 {{ candleLogTotal }} / 共 {{ candleLogGrandTotal }} 条</template>
                  <template v-else>共 {{ candleLogTotal }} 条</template>
                </span>
                <n-pagination
                  v-model:page="candleLogPage"
                  :item-count="candleLogTotal"
                  :page-size="candleLogPageSize"
                  :page-sizes="[10, 20, 50]"
                  show-size-picker
                  :disabled="candleLogLoading"
                  @update:page="onCandleLogPage"
                  @update:page-size="onCandleLogPageSize"
                />
              </div>
            </div>
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
                  class="config-group dark-descriptions"
                >
                  <n-descriptions-item v-for="f in grp.fields" :key="f.key" :label="f.label">
                    {{ formatConfigValue(f.key, configSnapshot[f.key]) }}
                  </n-descriptions-item>
                </n-descriptions>
              </template>

              <div v-else ref="jsonViewRef" class="json-view">
                <span class="json-brace">{</span>
                <div v-for="(key, idx) in jsonKeys" :key="key" class="json-line">
                  <span class="json-key">"{{ key }}"</span><span class="json-punct">: </span>
                  <template v-if="isArray(configSnapshot[key])">
                    <span class="json-toggle" @click="toggleFold(key)">{{ foldedKeys.has(key) ? '▶' : '▼' }}</span>
                    <span class="json-bracket">[</span>
                    <template v-if="!foldedKeys.has(key)">
                      <template v-for="(item, i) in (configSnapshot[key] as unknown[])" :key="i">
                        <span :class="primClass(item)">{{ primText(item) }}</span>
                        <span v-if="i < (configSnapshot[key] as unknown[]).length - 1" class="json-punct">, </span>
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
import { ref, computed, toRef } from 'vue'
import {
  NEmpty, NSpin, NSelect, NDataTable, NTabs, NTabPane,
  NDescriptions, NDescriptionsItem, NButton, NInputNumber, NDatePicker, NPagination,
} from 'naive-ui'
import { type BacktestCandleLogTradeState } from '../../composables/useApi'
import { useBacktestRun } from '../../composables/backtest/useBacktestRun'
import { useBacktestCandleLog } from '../../composables/backtest/useBacktestCandleLog'
import { useBacktestPositions } from '../../composables/backtest/useBacktestPositions'
import { useBacktestSymbols } from '../../composables/backtest/useBacktestSymbols'
import { useBacktestConfigSnapshot } from '../../composables/backtest/useBacktestConfigSnapshot'
import CandleDetailModal from './CandleDetailModal.vue'

const props = defineProps<{ strategy: any; run: any; loading: boolean }>()

const activeTab = ref<'kpiOverview' | 'positions' | 'symbols' | 'config' | 'candleLog'>('kpiOverview')

const {
  chartRef, allRuns, selectedRunId, currentRunDetail, reportData,
  runOptions, statItems, symbolOptions, stopTypeOptions, loadRun,
} = useBacktestRun(toRef(props, 'strategy'), toRef(props, 'run'), activeTab)

const cooldownOptions = [
  { label: '冷却中', value: 'true' },
  { label: '非冷却中', value: 'false' },
]

const candleTradeStateFilterOptions: { label: string; value: BacktestCandleLogTradeState }[] = [
  { label: '持仓', value: 'position' },
  { label: '入场', value: 'entry' },
  { label: '出场', value: 'exit' },
]

const simulationOptions = [
  { label: '模拟', value: 'true' },
  { label: '实盘', value: 'false' },
]

const {
  rows: posRows, total: posTotal, loading: posLoading,
  pagination: posPagination, columns: posColumns,
  filtersDraft: posFiltersDraft, emptyText: posEmptyText,
  applyFilters: applyPosFilters, resetFilters: resetPosFilters,
  onPage: onPosPage, onPageSize: onPosPageSize, onSort: onPosSort,
} = useBacktestPositions(selectedRunId, activeTab)

const {
  rows: symRows, total: symTotal, loading: symLoading,
  pagination: symPagination, columns: symColumns,
  filtersDraft: symFiltersDraft, emptyText: symEmptyText,
  applyFilters: applySymFilters, resetFilters: resetSymFilters,
  onPage: onSymPage, onPageSize: onSymPageSize, onSort: onSymSort,
} = useBacktestSymbols(selectedRunId, activeTab)

const {
  candleLogRows, candleLogTotal, candleLogGrandTotal, candleLogLoading,
  candleLogPage, candleLogPageSize,
  filtersDraft: candleFiltersDraft, emptyText: candleEmptyText,
  hasAppliedFilters: candleHasAppliedFilters,
  candleLogPagination, candleLogColumns,
  applyFilters: applyCandleFilters, resetFilters: resetCandleFilters,
  onCandleLogPage, onCandleLogPageSize, onCandleLogSort,
  showCandleDetail, selectedCandleRow, candleLogRowProps,
} = useBacktestCandleLog(selectedRunId, activeTab)

const positionTabCount = computed(() => {
  const fromList = posTotal.value
  const fromReport = reportData.value?.totalPositions
  if (fromList > 0) return fromList
  if (typeof fromReport === 'number') return fromReport
  return fromList
})

const symbolTabCount = computed(() => {
  const syms = reportData.value?.symbols
  if (Array.isArray(syms)) return syms.length
  return symTotal.value
})

const {
  configSnapshot, visibleConfigGroups, configView, foldedKeys, jsonViewRef,
  jsonKeys, allFolded, formatConfigValue, isArray, primClass, primText,
  toggleConfigView, toggleFold, toggleFoldAll, selectAllJson, copyConfig,
} = useBacktestConfigSnapshot(allRuns, selectedRunId)
</script>

<style scoped>
.backtest-detail { padding: 16px 20px; }
.run-selector { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 16px; }
.stat-item { background: var(--ember-surface); border: 1px solid var(--ember-border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.label { font-size: 12px; color: var(--ember-neutral); }
.value { font-size: 15px; font-weight: 600; color: var(--ember-text); }
.section-title { font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--ember-text); }
.chart-container { height: 300px; width: 100%; }
.table-filter-bar { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; align-items: center; }
.filter-field { width: 160px; min-width: 0; }
.filter-trade-states {
  width: auto;
  min-width: 200px;
  max-width: min(100%, 320px);
}
.filter-trade-states :deep(.n-base-selection--multiple) {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
}
.filter-trade-states :deep(.n-base-selection-tags) {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
}
.filter-date { width: 220px; }
.filter-actions { display: flex; gap: 8px; margin-left: auto; flex-shrink: 0; }
.detail-table-shell {
  width: 100%;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  overflow: hidden;
}
.detail-data-table {
  width: 100%;
}
.detail-table-shell :deep(.n-data-table-wrapper) {
  border-radius: 12px 12px 0 0;
}
.detail-table-shell :deep(.n-data-table-table) {
  background: var(--color-surface);
}
.detail-table-shell :deep(.n-data-table-base-table-header),
.detail-table-shell :deep(.n-data-table-base-table-body),
.detail-table-shell :deep(.n-data-table-base-table-body .n-scrollbar-content) {
  background: transparent;
}
.detail-table-shell :deep(.n-data-table-th) {
  background: var(--color-surface-elevated);
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--color-border);
  transition: background-color 0.2s ease, color 0.2s ease;
}
.detail-table-shell :deep(.n-data-table-th--sortable:hover),
.detail-table-shell :deep(.n-data-table-th--sorted),
.detail-table-shell :deep(.n-data-table-th--sorted:hover) {
  background: var(--color-surface-elevated);
  color: var(--color-text);
}
.detail-table-shell :deep(.n-data-table-th:first-child) {
  border-top-left-radius: 12px;
}
.detail-table-shell :deep(.n-data-table-th:last-child) {
  border-top-right-radius: 12px;
}
.detail-table-shell :deep(.n-data-table-td) {
  background: var(--color-surface);
  border-color: var(--color-border);
}
.detail-table-shell :deep(.n-data-table-tr:hover .n-data-table-td) {
  background: var(--color-surface-elevated);
}
.detail-table-shell :deep(.n-data-table-sorter) {
  color: var(--color-text-muted);
}
.detail-table-shell :deep(.n-data-table-th--sorted .n-data-table-sorter) {
  color: var(--n-th-icon-color-active, var(--n-primary-color));
}
.detail-table-shell :deep(.n-data-table-empty) {
  background: var(--color-surface);
}
.detail-table-shell :deep(.n-data-table-loading-container) {
  background: color-mix(in srgb, var(--color-surface) 72%, transparent);
}
.detail-table-shell :deep(.n-pagination) {
  padding: 12px 16px 16px;
}
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
.json-boolean { color: var(--ember-neutral); }
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
.candle-table-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface-elevated);
}
.record-count { font-size: 13px; color: var(--ember-neutral); margin-right: auto; }
</style>
