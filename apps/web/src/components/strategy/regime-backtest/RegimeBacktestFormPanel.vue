<template>
  <div class="regime-backtest-form-panel">
    <n-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-placement="left"
      label-width="100"
      class="regime-form"
    >
      <div class="import-bar">
        <ImportStrategyPopover
          v-model:show="showImportPopover"
          v-model:search-text="importSearchText"
          :loading="loadingImportSchemes"
          :options="filteredImportOptions"
          button-label="导入已有方案"
          search-placeholder="搜索方案..."
          empty-description="无匹配方案"
          @select="handleImportScheme"
        />
      </div>

      <n-tabs
        v-model:value="activeTab"
        class="regime-form-tabs"
        type="line"
        animated
        display-directive="show"
      >
        <n-tab-pane name="basics" tab="基础信息">
          <div class="section-card">
            <div class="section-title">基础信息</div>
            <n-form-item label="方案名" path="name">
              <n-input v-model:value="form.name" placeholder="例：v3 现实成本回测" />
            </n-form-item>
            <n-form-item label="初始资金" path="initialCapital">
              <n-input-number
                v-model:value="form.initialCapital"
                :min="10000"
                :step="100000"
                style="width: 100%"
              />
            </n-form-item>
            <n-form-item label="成本预设">
              <n-select v-model:value="costTier" :options="costTierOptions" />
            </n-form-item>
            <n-form-item label="标的范围">
              <n-radio-group v-model:value="universeMode" size="small">
                <n-radio value="all">全市场</n-radio>
                <n-radio value="watchlist">自选</n-radio>
                <n-radio value="symbols">自定义</n-radio>
              </n-radio-group>
            </n-form-item>
            <n-form-item v-if="universeMode === 'watchlist'" label="自选列表">
              <n-select
                v-model:value="watchlistId"
                :options="watchlistOptions"
                :loading="watchlistsLoading"
                placeholder="选择自选"
                clearable
              />
            </n-form-item>
            <n-form-item v-if="universeMode === 'symbols'" label="ts_code">
              <n-input
                v-model:value="symbolsText"
                type="textarea"
                placeholder="每行一个 ts_code，如 000001.SZ"
                :rows="3"
              />
            </n-form-item>
            <n-form-item label="回测区间">
              <div class="date-range-wrap">
                <n-date-picker
                  v-model:value="dateRange"
                  type="daterange"
                  clearable
                  :is-date-disabled="isDateDisabled"
                  style="width: 100%"
                />
                <div class="available-range-hint">可用区间 {{ availableRangeText }}</div>
              </div>
            </n-form-item>
          </div>
        </n-tab-pane>

        <n-tab-pane name="capital" tab="资金与仓位">
          <div class="section-card">
            <div class="section-title">资金与仓位</div>
            <RegimeBacktestCapitalForm v-model="capitalForm" section="sizing" />
          </div>
        </n-tab-pane>

        <n-tab-pane name="buckets" tab="象限分桶">
          <div class="section-card">
            <div class="section-title">象限分桶</div>
            <RegimeQuadrantChrome
              v-model:active-tab="activeQuadrantKey"
              :quadrants="regimeForm.quadrants"
              :overlap-warnings="overlapWarnings"
              :is-single-quadrant="isSingleQuadrant"
              @add="addQuadrant"
              @import="handleImportQuadrants"
              @remove="removeQuadrant"
            >
              <template #default="{ quadrant: q }">
                <RegimeQuadrantFormBody :quadrant="q" :is-single-quadrant="isSingleQuadrant" />
              </template>
            </RegimeQuadrantChrome>
          </div>
        </n-tab-pane>

        <n-tab-pane name="risk" tab="风控">
          <div class="section-card">
            <div class="section-title">风控</div>
            <RegimeBacktestCapitalForm v-model="capitalForm" section="risk" />
          </div>
        </n-tab-pane>
      </n-tabs>
    </n-form>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NDatePicker,
  NRadioGroup,
  NRadio,
  NTabs,
  NTabPane,
} from 'naive-ui'
import type { RegimeBacktestRun } from '@/api/modules/strategy/regimeEngine'
import RegimeQuadrantChrome from '@/components/regime/RegimeQuadrantChrome.vue'
import RegimeQuadrantFormBody from '@/components/regime/RegimeQuadrantFormBody.vue'
import ImportStrategyPopover from '@/components/backtest/strategy/ImportStrategyPopover.vue'
import '@/components/backtest/strategy/strategy-section.css'
import RegimeBacktestCapitalForm from './RegimeBacktestCapitalForm.vue'
import { useRegimeBacktestFormPanel } from './useRegimeBacktestFormPanel'

const props = withDefaults(
  defineProps<{
    active?: boolean
    /** 编辑模式：传入已有 run id，打开时 hydrate 并用 PATCH 保存 */
    runId?: string | null
  }>(),
  { active: true, runId: null },
)

const emit = defineEmits<{
  success: [run: RegimeBacktestRun]
}>()

const {
  formRef,
  submitting,
  activeTab,
  form,
  capitalForm,
  costTier,
  costTierOptions,
  dateRange,
  availableRangeText,
  universeMode,
  watchlistId,
  symbolsText,
  watchlistOptions,
  watchlistsLoading,
  showImportPopover,
  importSearchText,
  loadingImportSchemes,
  filteredImportOptions,
  rules,
  canSubmit,
  regimeForm,
  activeQuadrantKey,
  isSingleQuadrant,
  overlapWarnings,
  addQuadrant,
  handleImportQuadrants,
  removeQuadrant,
  handleImportScheme,
  isDateDisabled,
  resetForm,
  submit,
} = useRegimeBacktestFormPanel({
  active: toRef(props, 'active'),
  runId: toRef(props, 'runId'),
  onSuccess: (run) => emit('success', run),
})

defineExpose({ submit, canSubmit, submitting, resetForm })
</script>

<style scoped>
.regime-form {
  max-height: 68vh;
  overflow-y: auto;
  padding-right: 16px;
  padding-left: 4px;
}
.regime-form::-webkit-scrollbar {
  width: 6px;
}
.regime-form::-webkit-scrollbar-track {
  background: transparent;
}
.regime-form::-webkit-scrollbar-thumb {
  background: var(--ember-border, var(--color-border));
  border-radius: 3px;
}
.import-bar {
  margin-bottom: 16px;
  display: flex;
  justify-content: flex-end;
}
.regime-form-tabs {
  margin-top: 0;
}
.regime-form-tabs :deep(.n-tabs-nav) {
  margin-bottom: 12px;
}
.regime-form-tabs :deep(.n-tab-pane) {
  padding-top: 2px;
}
.regime-form-tabs :deep(.n-tab-pane) .section-card:last-child {
  margin-bottom: 4px;
}
.available-range-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--n-text-color-3, #999);
}
.date-range-wrap {
  width: 100%;
}
</style>
