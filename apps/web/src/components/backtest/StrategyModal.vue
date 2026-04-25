<template>
  <n-modal
    class="ember-strategy-modal"
    :show="show"
    @update:show="$emit('update:show', $event)"
    :title="isEdit ? '编辑策略' : '新建策略'"
    preset="dialog"
    style="width: 780px"
    :show-icon="false"
    :mask-closable="false"
    @after-leave="handleClose"
  >
    <n-form
      ref="formRef"
      :model="formData"
      label-placement="left"
      label-width="120px"
      class="strategy-form"
    >
      <div class="import-bar">
        <ImportStrategyPopover
          v-model:show="showImportPopover"
          v-model:searchText="importSearchText"
          :loading="loadingImportStrategies"
          :options="filteredImportOptions"
          @select="handleImport"
        />
      </div>

      <n-tabs
        v-model:value="strategyModalTab"
        class="strategy-form-tabs"
        type="line"
        animated
        display-directive="show"
      >
        <n-tab-pane name="basics" tab="基础信息">
          <div class="section-card">
            <div class="section-title">基础信息</div>
            <n-form-item label="策略名称" path="name">
              <n-input v-model:value="formData.name" placeholder="留空自动生成" clearable />
            </n-form-item>

            <n-form-item label="策略类型" path="typeId">
              <n-select v-model:value="formData.typeId" :options="strategyTypeOptions" placeholder="选择策略类型" />
            </n-form-item>

            <n-form-item label="时间周期" path="params.timeframe">
              <n-select v-model:value="formData.params.timeframe" :options="timeframeOptions" />
            </n-form-item>

            <n-form-item label="标的池" path="symbols" :show-require-mark="true">
              <div class="symbol-row">
                <n-select
                  :value="formData.symbols"
                  multiple
                  filterable
                  placeholder="搜索并选择标的..."
                  :options="symbolOptionsWithAll"
                  :loading="loadingSymbols"
                  max-tag-count="responsive"
                  @update:value="handleSymbolChangeWrapper"
                  class="symbol-select"
                />
                <SymbolPresetPicker
                  :current-symbols="formData.symbols"
                  :available-symbols="symbolOptions.map((o) => o.value)"
                  @load="(s) => (formData.symbols = s)"
                />
              </div>
            </n-form-item>
          </div>
        </n-tab-pane>

        <n-tab-pane name="capital" tab="资金与仓位">
          <StrategyCapitalSection v-model:params="formData.params" />
        </n-tab-pane>

        <n-tab-pane name="config" tab="基础配置">
          <StrategyConfigSection v-model:params="formData.params" />
        </n-tab-pane>

        <n-tab-pane name="entry" tab="入场信号">
          <div class="section-card">
            <div class="section-title">入场信号</div>
            <EntrySignalSection v-model:params="formData.params" />
          </div>
        </n-tab-pane>

        <n-tab-pane name="entrySorting" tab="入场排序">
          <div class="section-card">
            <div class="section-title">入场信号排序</div>
            <EntrySortSection v-model:params="formData.params" />
          </div>
        </n-tab-pane>

        <n-tab-pane name="stopExit" tab="止损与出场">
          <StrategyStopExitSection v-model:params="formData.params" />
        </n-tab-pane>

        <n-tab-pane name="riskBacktest" tab="风控与回测">
          <div class="section-card">
            <div class="section-title">风控参数</div>
            <n-form-item>
              <template #label>
                <LabelWithTip label="启用冷却期" :max-width="280">
                  账户级全局冷却：连续亏损达到阈值后，暂停所有新开仓（已持仓可正常平仓）；盈利清零连亏计数
                </LabelWithTip>
              </template>
              <n-switch v-model:value="formData.params.enableCooldown" />
            </n-form-item>

            <template v-if="formData.params.enableCooldown">
              <CooldownParamsSection v-model:params="formData.params" />
            </template>
          </div>

          <div class="section-card">
            <div class="section-title">回测区间</div>
            <n-form-item label="开始日期">
              <n-date-picker v-model:formatted-value="formData.params.dateStart" :value-format="dateFormat" :type="datePickerType" style="width:100%" clearable />
            </n-form-item>
            <n-form-item label="结束日期">
              <n-date-picker v-model:formatted-value="formData.params.dateEnd" :value-format="dateFormat" :type="datePickerType" style="width:100%" clearable />
            </n-form-item>
          </div>
        </n-tab-pane>
      </n-tabs>
    </n-form>

    <template #action>
      <n-button @click="$emit('update:show', false)">取消</n-button>
      <n-button type="primary" :loading="submitting" @click="handleSubmit">保存</n-button>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import {
  useMessage,
  NModal, NForm, NFormItem, NInput, NSelect,
  NDatePicker, NButton, NSwitch,
  NTabs, NTabPane,
} from 'naive-ui'
import { strategyApi } from '../../composables/useApi'
import { useStrategyForm } from '../../composables/backtest/useStrategyForm'
import { useImportStrategies } from '../../composables/backtest/useImportStrategies'
import { useSymbolOptions } from '../../composables/useSymbolOptions'
import { useDateRange } from '../../composables/useDateRange'
import './strategy/strategy-section.css'
import SymbolPresetPicker from './strategy/SymbolPresetPicker.vue'
import EntrySignalSection from './strategy/EntrySignalSection.vue'
import EntrySortSection from './strategy/EntrySortSection.vue'
import StrategyCapitalSection from './strategy/StrategyCapitalSection.vue'
import StrategyConfigSection from './strategy/StrategyConfigSection.vue'
import StrategyStopExitSection from './strategy/StrategyStopExitSection.vue'
import ImportStrategyPopover from './strategy/ImportStrategyPopover.vue'
import LabelWithTip from './strategy/LabelWithTip.vue'
import CooldownParamsSection from './strategy/CooldownParamsSection.vue'

const props = defineProps<{ show: boolean; isEdit: boolean; strategy?: unknown }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'success'): void }>()

const message = useMessage()
const formRef = ref()
const strategyModalTab = ref('basics')
const submitting = ref(false)
const strategyTypeOptions = ref<{ label: string; value: string }[]>([])

const { formData, resetForm, clearDates, setDates, mergeImportedParams } = useStrategyForm(
  { get value() { return props.strategy } },
  { get value() { return props.isEdit } }
)

const {
  showImportPopover,
  importSearchText,
  loadingImportStrategies,
  filteredImportOptions,
  resetImportState,
  handleImportStrategy,
  handlePopoverShow,
} = useImportStrategies({ get strategy() { return props.strategy } })

const {
  symbolOptions,
  loadingSymbols,
  symbolOptionsWithAll,
  loadSymbolOptions,
  isSelectAll,
  allSymbolValues,
} = useSymbolOptions()

const { datePickerType, dateFormat, applyDateRangeDefaults } = useDateRange(
  { get params() { return formData.value.params } }
)

const handleImport = (id: string) => {
  handleImportStrategy(id, {
    onSuccess: (imported) => {
      mergeImportedParams(imported, {
        name: formData.value.name,
        symbols: formData.value.symbols,
        dateStart: formData.value.params.dateStart,
        dateEnd: formData.value.params.dateEnd,
      })
    },
    onClose: () => { showImportPopover.value = false },
  })
}

const handleSymbolChangeWrapper = (vals: string[]) => {
  formData.value.symbols = isSelectAll(vals) ? allSymbolValues() : vals
}

const timeframeOptions = [
  { label: '1小时', value: '1h' },
  { label: '4小时', value: '4h' },
  { label: '日线', value: '1d' },
]

const handleClose = () => {
  if (!props.isEdit) resetForm()
}

const handleSubmit = async () => {
  if (!formData.value.symbols.length) {
    message.warning('请至少选择一个标的')
    return
  }
  submitting.value = true
  try {
    const payload = {
      name: formData.value.name || undefined,
      typeId: formData.value.typeId,
      symbols: formData.value.symbols,
      params: { ...formData.value.params },
    }
    const s = props.strategy as Record<string, unknown> | undefined
    if (props.isEdit) {
      await strategyApi.updateStrategy(s?.id as string, payload)
      message.success('更新成功')
    } else {
      await strategyApi.createStrategy(payload)
      message.success('创建成功')
    }
    emit('success')
    emit('update:show', false)
  } catch (err: unknown) {
    message.error((err as Error).message)
  } finally {
    submitting.value = false
  }
}

watch(
  () => props.show,
  (v) => {
    if (!v) return
    strategyModalTab.value = 'basics'
    resetImportState()
    if (!props.isEdit) {
      resetForm()
      applyDateRangeDefaults(formData.value.params.timeframe, setDates)
    }
    loadSymbolOptions(formData.value.params.timeframe)
  }
)

watch(
  () => formData.value.params.timeframe,
  (tf) => {
    if (!tf) return
    clearDates()
    loadSymbolOptions(tf)
    applyDateRangeDefaults(tf, setDates)
  },
  { immediate: false }
)

watch(showImportPopover, (v) => {
  if (v) handlePopoverShow(true)
})

onMounted(async () => {
  try {
    const types = await strategyApi.getStrategyTypes()
    strategyTypeOptions.value = types.map((t: Record<string, string>) => ({ label: t.name, value: t.id }))
  } catch { /* ignore */ }
})
</script>

<style scoped>
/* Modal 整体增强 */
.ember-strategy-modal :deep(.n-dialog) {
  box-shadow: 0 24px 48px color-mix(in srgb, var(--color-ink) 12%, transparent);
  border-radius: 12px;
}
.ember-strategy-modal :deep(.n-dialog__title) {
  font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--ember-text, var(--color-text));
  font-size: 20px;
}
.ember-strategy-modal :deep(.n-dialog__content) {
  padding-top: 4px;
}
.ember-strategy-modal :deep(.n-dialog__action) {
  padding-top: 12px;
}

.strategy-form {
  max-height: 68vh;
  overflow-y: auto;
  padding-right: 16px;
  padding-left: 4px;
}
.strategy-form::-webkit-scrollbar {
  width: 6px;
}
.strategy-form::-webkit-scrollbar-track {
  background: transparent;
}
.strategy-form::-webkit-scrollbar-thumb {
  background: var(--ember-border, var(--color-border));
  border-radius: 3px;
}
.strategy-form::-webkit-scrollbar-thumb:hover {
  background: var(--ember-neutral, var(--color-text-muted));
}

/* 区块卡片 */
.strategy-form-tabs :deep(.n-tab-pane) .section-card:last-child {
  margin-bottom: 4px;
}

.import-bar {
  margin-bottom: 16px;
  display: flex;
  justify-content: flex-end;
}

.strategy-form-tabs {
  margin-top: 0;
}
.strategy-form-tabs :deep(.n-tabs-nav) {
  margin-bottom: 12px;
}
.strategy-form-tabs :deep(.n-tab-pane) {
  padding-top: 2px;
}

.symbol-row {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: stretch;
}
.symbol-select {
  flex: 1;
  min-width: 0;
}
</style>
