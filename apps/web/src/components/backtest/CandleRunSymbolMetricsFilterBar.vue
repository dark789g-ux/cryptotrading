<template>
  <n-card class="filter-card" :bordered="false" size="small">
    <n-spin :show="loading" size="small">
      <div class="table-filter-bar">
        <n-input
          :value="searchQuery"
          class="filter-field"
          placeholder="搜索标的..."
          clearable
          :disabled="loading"
          @update:value="emit('update:searchQuery', $event)"
          @keyup.enter="emit('apply')"
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
            :value="statusValues"
            class="filter-status-select"
            multiple
            clearable
            placeholder="状态"
            :options="statusFilterOptions"
            :disabled="loading"
            max-tag-count="responsive"
            @update:value="emit('update:statusValues', $event)"
          />
        </div>

        <div v-if="conditions.length" class="filter-tags-inline">
          <n-tag
            v-for="(condition, index) in conditions"
            :key="`${condition.field}-${condition.op}-${condition.value}-${index}`"
            :closable="!loading"
            @close="emit('removeCondition', index)"
          >
            {{ condition.field }} {{ opLabels[condition.op] }} {{ condition.value }}
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
                  @click="handleAddCondition"
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
                  <div v-for="(condition, index) in conditions" :key="index" class="condition-item">
                    <span>{{ condition.field }} {{ opLabels[condition.op] }} {{ condition.value }}</span>
                    <n-button quaternary circle size="small" @click="emit('removeCondition', index)">
                      <template #icon><n-icon><close-outline /></n-icon></template>
                    </n-button>
                  </div>
                </div>
              </div>
            </div>
          </n-popover>

          <n-button :disabled="loading" @click="emit('reset')">重置</n-button>
          <n-button type="primary" :disabled="loading" @click="emit('apply')">应用筛选</n-button>
        </div>
      </div>
    </n-spin>
  </n-card>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  NBadge,
  NButton,
  NCard,
  NDivider,
  NEmpty,
  NIcon,
  NInput,
  NInputNumber,
  NPopover,
  NSelect,
  NSpin,
  NTag,
  NTooltip,
} from 'naive-ui'
import { CloseOutline, FilterOutline, SearchOutline } from '@vicons/ionicons5'
import {
  opLabels,
  opOptions,
  statusFilterOptions,
  type RunSymbolMetricCondition,
  type StatusFilterValue,
} from '../../composables/backtest/candleRunSymbolMetrics'

const props = defineProps<{
  loading: boolean
  searchQuery: string
  statusValues: StatusFilterValue[]
  conditions: RunSymbolMetricCondition[]
  fieldOptions: Array<{ label: string; value: string }>
}>()

const emit = defineEmits<{
  (e: 'update:searchQuery', value: string): void
  (e: 'update:statusValues', value: StatusFilterValue[]): void
  (e: 'apply'): void
  (e: 'reset'): void
  (e: 'addCondition', value: RunSymbolMetricCondition): void
  (e: 'removeCondition', index: number): void
}>()

const showFilterDrawer = ref(false)
const fieldSelectRef = ref<{ focus: () => void } | null>(null)
const newCondition = ref<{ field: string; op: string; value: number | null }>({ field: '', op: 'gt', value: 0 })

const canAddCondition = computed(() => !!newCondition.value.field && newCondition.value.value !== null)

const resetDraftCondition = () => {
  newCondition.value = { field: '', op: 'gt', value: 0 }
}

const handleAddCondition = () => {
  if (!canAddCondition.value || newCondition.value.value === null) return
  emit('addCondition', {
    field: newCondition.value.field,
    op: newCondition.value.op,
    value: newCondition.value.value,
  })
  resetDraftCondition()
}

watch(showFilterDrawer, (open) => {
  if (!open) return
  void nextTick(() => {
    fieldSelectRef.value?.focus()
  })
})
</script>

<style scoped src="./candle-run-symbol-metrics-filter-bar.css"></style>
<style src="./candle-run-symbol-metrics-filter-bar.global.css"></style>
