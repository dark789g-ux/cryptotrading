<template>
  <n-modal
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

      <n-divider>资金配置</n-divider>

      <n-form-item label="初始资金">
        <n-input-number v-model:value="formData.params.initialCapital" :min="1000" :step="10000" style="width:100%" />
      </n-form-item>

      <n-divider>仓位管理</n-divider>

      <n-form-item label="仓位比例">
        <n-slider v-model:value="formData.params.positionRatio" :min="0.01" :max="1" :step="0.0001" />
        <div class="param-edit">
          <input class="param-input" v-model="positionPctDisplay" @change="commitPosition" @keydown.enter="blurInput" />
          <span class="param-suffix">%</span>
        </div>
      </n-form-item>

      <n-form-item label="最大持仓">
        <n-input-number v-model:value="formData.params.maxPositions" :min="1" :max="20" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <LabelWithTip label="仅全部盈利时开新仓">
            开启后：当前所有持仓的止损价须已上移至成本之上（止损价 &gt; 入场价），才允许开新仓；空仓不受限
          </LabelWithTip>
        </template>
        <n-switch v-model:value="formData.params.requireAllPositionsProfitable" />
      </n-form-item>

      <n-divider>基础配置</n-divider>

      <n-form-item>
        <template #label>
          <LabelWithTip label="低点扫描(K线)" :max-width="260">
            向前取最近 N 根 K 线的最低价作为阶段低点候选；影响止损基准价和入场距低点判断
          </LabelWithTip>
        </template>
        <n-input-number v-model:value="formData.params.recentLowWindow" :min="1" :max="200" style="width:100%" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <LabelWithTip label="低点追溯缓冲" :max-width="260">
            在扫描窗口之外继续向前追溯最多 Y 根 K 线：若找到更低点则更新阶段低点并继续追溯，直到无更低点为止
          </LabelWithTip>
        </template>
        <n-input-number v-model:value="formData.params.recentLowBuffer" :min="0" :max="500" style="width:100%" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <LabelWithTip label="高点窗口(K线)">
            计算阶段高点时，向前取最近 N 根 K 线的最高价作为初始候选，影响止盈目标价
          </LabelWithTip>
        </template>
        <n-input-number v-model:value="formData.params.recentHighWindow" :min="1" :max="50" style="width:100%" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <LabelWithTip label="高点回溯缓冲">
            在窗口之外继续向前追溯，找更高的连续高点；增大可找到更远的阻力位
          </LabelWithTip>
        </template>
        <n-input-number v-model:value="formData.params.recentHighBuffer" :min="0" :max="500" style="width:100%" />
      </n-form-item>

      <EntrySignalSection v-model:params="formData.params" />

      <n-divider>止损策略</n-divider>

      <n-form-item label="止损类型">
        <n-select v-model:value="formData.params.stopLossMode" :options="stopLossModeOptions" />
      </n-form-item>

      <n-form-item v-if="formData.params.stopLossMode === 'fixed'">
        <template #label>
          <LabelWithTip label="固定止损%">
            止损价 = 入场价 × (1 - 该%)，与阶段低点无关
          </LabelWithTip>
        </template>
        <n-input-number v-model:value="formData.params.fixedStopLossPct" :min="0.1" :max="50" :step="0.5" style="width:100%" />
      </n-form-item>

      <n-form-item v-if="formData.params.stopLossMode === 'atr' || formData.params.stopLossMode === 'signal_midpoint'">
        <template #label>
          <LabelWithTip label="止损因子" placement="top" :max-width="280">
            止损价 = 基准价 × 止损因子。<br/>
            = 1 时贴近基准价；&lt; 1 时更宽松；&gt; 1 时更紧
          </LabelWithTip>
        </template>
        <n-slider v-model:value="formData.params.stopLossFactor" :min="0.5" :max="2" :step="0.0001" />
        <div class="param-edit">
          <input class="param-input" v-model="stopLossDisplay" @change="commitStopLoss" @keydown.enter="blurInput" />
        </div>
      </n-form-item>

      <n-divider style="margin:8px 0">止损上调规则</n-divider>

      <n-form-item>
        <template #label>
          <LabelWithTip label="阶段止盈后上调止损">
            触发阶段止盈后，是否以及如何上调剩余仓位的止损价
          </LabelWithTip>
        </template>
        <div class="adjust-row">
          <n-switch v-model:value="formData.params.enableProfitStopAdjust" />
          <n-select
            v-if="formData.params.enableProfitStopAdjust"
            v-model:value="formData.params.profitStopAdjustTo"
            :options="[{ label: '中点价', value: 'midpoint' }, { label: '保本价', value: 'breakeven' }]"
            style="width:120px;margin-left:8px"
          />
        </div>
      </n-form-item>

      <n-form-item>
        <template #label>
          <LabelWithTip label="MA5 上升后上调止损">
            MA5 首次由平/跌转升后，是否以及如何上调止损价
          </LabelWithTip>
        </template>
        <div class="adjust-row">
          <n-switch v-model:value="formData.params.enableMa5StopAdjust" />
          <n-select
            v-if="formData.params.enableMa5StopAdjust"
            v-model:value="formData.params.ma5StopAdjustTo"
            :options="[{ label: '中点价', value: 'midpoint' }, { label: '保本价', value: 'breakeven' }]"
            style="width:120px;margin-left:8px"
          />
        </div>
      </n-form-item>

      <n-form-item>
        <template #label>
          <LabelWithTip label="阶梯追踪止损">
            开启后按规则链动态上移止损：首次价格高于入场价即保本，随后以每根K线最低点追踪，封顶于信号K线最高价
          </LabelWithTip>
        </template>
        <n-switch v-model:value="formData.params.enableLadderStopLoss" />
      </n-form-item>

      <ExitManagementSection v-model:params="formData.params" />

      <n-divider>出场策略</n-divider>

      <n-form-item label="MA5 破线出场">
        <span class="exit-strategy-desc">
          始终启用：持仓期间收盘价曾站上 MA5 后，若出现收盘价 &lt; MA5 且 MA5 ≤ 前根 MA5，则全仓出场
        </span>
      </n-form-item>

      <n-divider>风控参数</n-divider>

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

      <n-divider>回测区间</n-divider>

      <n-form-item label="开始日期">
        <n-date-picker v-model:formatted-value="formData.params.dateStart" :value-format="dateFormat" :type="datePickerType" style="width:100%" clearable />
      </n-form-item>
      <n-form-item label="结束日期">
        <n-date-picker v-model:formatted-value="formData.params.dateEnd" :value-format="dateFormat" :type="datePickerType" style="width:100%" clearable />
      </n-form-item>
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
  NModal, NForm, NFormItem, NInput, NSelect, NDivider,
  NInputNumber, NSlider, NDatePicker, NButton, NSwitch,
} from 'naive-ui'
import { strategyApi } from '../../composables/useApi'
import { useStrategyForm } from '../../composables/backtest/useStrategyForm'
import { useImportStrategies } from '../../composables/backtest/useImportStrategies'
import { useSymbolOptions } from '../../composables/useSymbolOptions'
import { useDateRange } from '../../composables/useDateRange'
import SymbolPresetPicker from './strategy/SymbolPresetPicker.vue'
import ExitManagementSection from './strategy/ExitManagementSection.vue'
import EntrySignalSection from './strategy/EntrySignalSection.vue'
import ImportStrategyPopover from './strategy/ImportStrategyPopover.vue'
import LabelWithTip from './strategy/LabelWithTip.vue'
import CooldownParamsSection from './strategy/CooldownParamsSection.vue'

const props = defineProps<{ show: boolean; isEdit: boolean; strategy?: unknown }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'success'): void }>()

const message = useMessage()
const formRef = ref()
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

const stopLossModeOptions = [
  { label: '阶段低点 × 因子（默认）', value: 'atr' },
  { label: '固定百分比', value: 'fixed' },
  { label: '信号K线中点价', value: 'signal_midpoint' },
]

const useEditableNumber = (getValue: () => number, setValue: (v: number) => void, opts: { min: number; max: number; decimals: number; scale?: number }) => {
  const display = ref('')
  const updateDisplay = () => {
    const v = getValue()
    display.value = opts.scale ? (v * opts.scale).toFixed(opts.decimals) : v.toFixed(opts.decimals)
  }
  watch(getValue, updateDisplay, { immediate: true })
  const commit = () => {
    const raw = display.value.trim().replace('%', '')
    const num = Number(raw)
    if (!Number.isFinite(num) || raw === '') {
      message.warning('请输入有效数字')
      updateDisplay()
      return
    }
    const val = opts.scale ? num / opts.scale : num
    const clamped = Math.min(opts.max, Math.max(opts.min, val))
    const rounded = Math.round(clamped * 10 ** opts.decimals) / 10 ** opts.decimals
    if (Math.abs(rounded - val) > 1e-9) {
      message.info(`已调整为 ${opts.scale ? (rounded * opts.scale).toFixed(opts.decimals) : rounded.toFixed(opts.decimals)}${opts.scale ? '%' : ''}`)
    }
    setValue(rounded)
    display.value = opts.scale ? (rounded * opts.scale).toFixed(opts.decimals) : rounded.toFixed(opts.decimals)
  }
  return { display, commit, updateDisplay }
}

const { display: positionPctDisplay, commit: commitPosition } = useEditableNumber(
  () => formData.value.params.positionRatio,
  (v) => { formData.value.params.positionRatio = v },
  { min: 0.01, max: 1, decimals: 2, scale: 100 }
)

const { display: stopLossDisplay, commit: commitStopLoss } = useEditableNumber(
  () => formData.value.params.stopLossFactor,
  (v) => { formData.value.params.stopLossFactor = v },
  { min: 0.5, max: 2, decimals: 4 }
)

const blurInput = (e: KeyboardEvent) => {
  (e.target as HTMLInputElement).blur()
}

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

onMounted(async () => {
  try {
    const types = await strategyApi.getStrategyTypes()
    strategyTypeOptions.value = types.map((t: Record<string, string>) => ({ label: t.name, value: t.id }))
  } catch { /* ignore */ }
})
</script>

<style scoped>
.strategy-form { max-height: 68vh; overflow-y: auto; padding-right: 16px; padding-left: 4px; }
.param-edit { display: inline-flex; align-items: center; margin-left: 12px; gap: 2px; }
.param-input {
  width: 64px; text-align: right; background: transparent; color: var(--text-secondary);
  border: 1px solid transparent; border-radius: 4px; font-size: 14px; padding: 2px 4px; outline: none;
  font-family: inherit;
}
.param-input:hover { border-color: var(--border-color, #444); }
.param-input:focus { border-color: var(--primary-color, #f59e0b); color: var(--text-primary, #fff); }
.param-suffix { color: var(--text-secondary); font-size: 14px; }
:deep(.n-divider) { margin: 16px 0; }
.exit-strategy-desc { font-size: 13px; color: var(--n-text-color-3); line-height: 1.6; }
.adjust-row { display: flex; align-items: center; }
.import-bar { margin-bottom: 16px; }
.symbol-row { display: flex; gap: 8px; width: 100%; align-items: stretch; }
.symbol-select { flex: 1; min-width: 0; }
</style>
