<template>
  <n-modal
    :show="show"
    @update:show="$emit('update:show', $event)"
    :title="isEdit ? '编辑策略' : '新建策略'"
    preset="dialog"
    style="width: 600px"
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
        <n-select
          v-model:value="importStrategyId"
          :options="importStrategyOptions"
          :loading="loadingImportStrategies"
          placeholder="从其他策略导入参数..."
          filterable
          clearable
          @update:value="handleImportStrategy"
          @focus="loadImportStrategies"
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
            @update:value="handleSymbolChange"
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
          <input class="param-input" v-model="positionPctDisplay" @change="commitPosition" @keydown.enter="($event.target as HTMLInputElement).blur()" />
          <span class="param-suffix">%</span>
        </div>
      </n-form-item>

      <n-form-item label="最大持仓">
        <n-input-number v-model:value="formData.params.maxPositions" :min="1" :max="20" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <span class="label-with-tip">仅全部盈利时开新仓
            <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
              开启后：当前所有持仓的止损价须已上移至成本之上（止损价 &gt; 入场价），才允许开新仓；空仓不受限
            </n-tooltip>
          </span>
        </template>
        <n-switch v-model:value="formData.params.requireAllPositionsProfitable" />
      </n-form-item>

      <n-divider>基础配置</n-divider>

      <n-form-item>
        <template #label>
          <span class="label-with-tip">低点扫描(K线)
            <n-tooltip style="max-width:260px"><template #trigger><span class="tip-icon">?</span></template>
              向前取最近 N 根 K 线的最低价作为阶段低点候选；影响止损基准价和入场距低点判断
            </n-tooltip>
          </span>
        </template>
        <n-input-number v-model:value="formData.params.recentLowWindow" :min="1" :max="200" style="width:100%" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <span class="label-with-tip">低点追溯缓冲
            <n-tooltip style="max-width:260px"><template #trigger><span class="tip-icon">?</span></template>
              在扫描窗口之外继续向前追溯最多 Y 根 K 线：若找到更低点则更新阶段低点并继续追溯，直到无更低点为止
            </n-tooltip>
          </span>
        </template>
        <n-input-number v-model:value="formData.params.recentLowBuffer" :min="0" :max="500" style="width:100%" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <span class="label-with-tip">高点窗口(K线)
            <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
              计算阶段高点时，向前取最近 N 根 K 线的最高价作为初始候选，影响止盈目标价
            </n-tooltip>
          </span>
        </template>
        <n-input-number v-model:value="formData.params.recentHighWindow" :min="1" :max="50" style="width:100%" />
      </n-form-item>

      <n-form-item>
        <template #label>
          <span class="label-with-tip">高点回溯缓冲
            <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
              在窗口之外继续向前追溯，找更高的连续高点；增大可找到更远的阻力位
            </n-tooltip>
          </span>
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
          <span class="label-with-tip">固定止损%
            <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
              止损价 = 入场价 × (1 - 该%)，与阶段低点无关
            </n-tooltip>
          </span>
        </template>
        <n-input-number v-model:value="formData.params.fixedStopLossPct" :min="0.1" :max="50" :step="0.5" style="width:100%" />
      </n-form-item>

      <n-form-item v-if="formData.params.stopLossMode === 'atr'">
        <template #label>
          <span class="label-with-tip">止损因子
            <n-tooltip placement="top" style="max-width:280px"><template #trigger><span class="tip-icon">?</span></template>
              止损价 = 阶段低点 × 止损因子。<br/>
              = 1 时止损贴近低点；&lt; 1 时在低点下方（更宽松）；&gt; 1 时在低点上方（更紧）
            </n-tooltip>
          </span>
        </template>
        <n-slider v-model:value="formData.params.stopLossFactor" :min="0.5" :max="2" :step="0.0001" />
        <div class="param-edit">
          <input class="param-input" v-model="stopLossDisplay" @change="commitStopLoss" @keydown.enter="($event.target as HTMLInputElement).blur()" />
        </div>
      </n-form-item>

      <ExitManagementSection v-model:params="formData.params" />

      <n-divider>出场策略</n-divider>

      <n-form-item label="MA5 破线出场">
        <span class="exit-strategy-desc">
          始终启用：收盘价 &lt; MA5 且 MA5 &lt; 前根MA5（MA5 下行时破线出场）
        </span>
      </n-form-item>

      <n-divider>风控参数</n-divider>

      <n-form-item>
        <template #label>
          <span class="label-with-tip">启用冷却期
            <n-tooltip style="max-width:280px"><template #trigger><span class="tip-icon">?</span></template>
              账户级全局冷却：连续亏损达到阈值后，暂停所有新开仓（已持仓可正常平仓）；盈利清零连亏计数
            </n-tooltip>
          </span>
        </template>
        <n-switch v-model:value="formData.params.enableCooldown" />
      </n-form-item>

      <template v-if="formData.params.enableCooldown">
        <n-form-item>
          <template #label>
            <span class="label-with-tip">基础冷却根数
              <n-tooltip style="max-width:280px"><template #trigger><span class="tip-icon">?</span></template>
                回测启动时冷却时长的初始值；后续每次亏损 +1、每次盈利 -1，在 [0, 最大冷却根数] 范围内变化
              </n-tooltip>
            </span>
          </template>
          <n-input-number v-model:value="formData.params.baseCooldownCandles" :min="0" :max="200" style="width:100%" />
        </n-form-item>

        <n-form-item>
          <template #label>
            <span class="label-with-tip">连亏触发阈值
              <n-tooltip><template #trigger><span class="tip-icon">?</span></template>
                账户连续亏损达到 N 次后，触发全局冷却期，暂停所有新开仓；盈利一笔即清零连亏计数
              </n-tooltip>
            </span>
          </template>
          <n-input-number v-model:value="formData.params.consecutiveLossesThreshold" :min="1" :max="20" style="width:100%" />
        </n-form-item>

        <n-form-item>
          <template #label>
            <span class="label-with-tip">最大冷却根数
              <n-tooltip style="max-width:280px"><template #trigger><span class="tip-icon">?</span></template>
                冷却时长的上限；冷却期间每亏损 1 根延长 1 根冷却，但不超过此上限；盈利 1 根缩短 1 根，降至 0 时立即解除冷却
              </n-tooltip>
            </span>
          </template>
          <n-input-number v-model:value="formData.params.maxCooldownCandles" :min="1" :max="10000" style="width:100%" />
        </n-form-item>
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
import { ref, watch, computed, onMounted } from 'vue'
import {
  useMessage,
  NModal, NForm, NFormItem, NInput, NSelect, NDivider,
  NInputNumber, NSlider, NDatePicker, NButton, NSwitch, NTooltip,
} from 'naive-ui'
import { strategyApi, symbolApi } from '../../composables/useApi'
import SymbolPresetPicker from './SymbolPresetPicker.vue'
import ExitManagementSection from './ExitManagementSection.vue'
import EntrySignalSection from './EntrySignalSection.vue'

const props = defineProps<{ show: boolean; isEdit: boolean; strategy?: unknown }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'success'): void }>()

const message = useMessage()
const formRef = ref()
const submitting = ref(false)
const strategyTypeOptions = ref<{ label: string; value: string }[]>([])
const symbolOptions = ref<{ label: string; value: string }[]>([])
const loadingSymbols = ref(false)
const SELECT_ALL = '__SELECT_ALL__'

const importStrategyId = ref<string | null>(null)
const importStrategyOptions = ref<{ label: string; value: string }[]>([])
const loadingImportStrategies = ref(false)
let importStrategiesLoaded = false

const loadImportStrategies = async () => {
  if (importStrategiesLoaded) return
  loadingImportStrategies.value = true
  try {
    const list = await strategyApi.getStrategies()
    const selfId = (props.strategy as Record<string, unknown>)?.id
    importStrategyOptions.value = (list as Record<string, unknown>[])
      .filter((s) => s.id !== selfId)
      .map((s) => ({ label: s.name as string, value: s.id as string }))
    importStrategiesLoaded = true
  } catch (err: unknown) {
    message.error((err as Error).message || '加载策略列表失败')
  } finally {
    loadingImportStrategies.value = false
  }
}

const handleImportStrategy = async (id: string | null) => {
  if (!id) return
  try {
    const s = await strategyApi.getStrategy(id)
    const imported = makeForm(s as Record<string, unknown>)
    formData.value = {
      ...imported,
      name: formData.value.name,
      symbols: formData.value.symbols,
      params: {
        ...imported.params,
        dateStart: formData.value.params.dateStart,
        dateEnd: formData.value.params.dateEnd,
      },
    }
    message.success('参数已导入')
  } catch (err: unknown) {
    message.error((err as Error).message || '导入失败')
  } finally {
    importStrategyId.value = null
  }
}

const symbolOptionsWithAll = computed(() => [
  { label: '全选所有标的', value: SELECT_ALL },
  ...symbolOptions.value,
])

const handleSymbolChange = (vals: string[]) => {
  if (vals.includes(SELECT_ALL)) {
    formData.value.symbols = symbolOptions.value.map((o) => o.value)
  } else {
    formData.value.symbols = vals
  }
}

const timeframeOptions = [
  { label: '1小时', value: '1h' },
  { label: '4小时', value: '4h' },
  { label: '日线', value: '1d' },
]

const stopLossModeOptions = [
  { label: '阶段低点 × 因子（默认）', value: 'atr' },
  { label: '固定百分比', value: 'fixed' },
]

const defaultParams = () => ({
  initialCapital: 1000000, positionRatio: 0.4, maxPositions: 2,
  timeframe: '1h', dateStart: null as string | null, dateEnd: null as string | null,
  // 入场信号
  kdjN: 9, kdjM1: 3, kdjM2: 3, kdjJOversold: 10,
  maConditions: [] as Array<{ left: string; right: string }>,
  recentLowWindow: 9, recentLowBuffer: 5,
  entryMaxDistFromLowPct: 5,
  // 信号参数
  recentHighWindow: 9, recentHighBuffer: 5,
  // 止损策略
  stopLossMode: 'atr' as 'atr' | 'fixed', fixedStopLossPct: 2,
  // 出场管理
  enablePartialProfit: false, partialProfitRatio: 0.5,
  enableTrailingStop: false, trailingDrawdownPct: 3,
  enableBreakevenStop: false, breakevenTriggerR: 1.0,
  takeProfitTargets: [] as Array<{ rrRatio: number; sellRatio: number }>,
  enableTrailingProfit: false, trailingProfitTriggerR: 2.0, trailingProfitDrawdownPct: 5,
  // 风控参数
  stopLossFactor: 1.0, minRiskRewardRatio: 4.0,
  maxInitLoss: 0.01,
  requireAllPositionsProfitable: false,
  // 冷却期
  enableCooldown: false,
  baseCooldownCandles: 5,
  consecutiveLossesThreshold: 3,
  maxCooldownCandles: 20,
})

const normalizeDate = (v: unknown, tf: string): string | null => {
  if (typeof v !== 'string' || !v) return null
  const needsTime = tf !== '1d'
  const hasTime = v.includes(' ')
  if (needsTime && !hasTime) return `${v} 00:00:00`
  if (!needsTime && hasTime) return v.split(' ')[0]
  return v
}

const makeForm = (s?: Record<string, unknown>) => {
  const params = { ...defaultParams(), ...(s?.params as Record<string, unknown> ?? {}) }
  params.dateStart = normalizeDate(params.dateStart, params.timeframe as string)
  params.dateEnd = normalizeDate(params.dateEnd, params.timeframe as string)
  // 从已保存策略反推 enableCooldown 开关状态
  if (s?.params) {
    const sp = s.params as Record<string, unknown>
    // 优先读取已有的 enableCooldown 字段；旧数据无此字段时 fallback 反推
    if (sp.enableCooldown !== undefined) {
      params.enableCooldown = !!sp.enableCooldown
    } else {
      params.enableCooldown = ((sp.baseCooldownCandles as number) ?? 0) > 0 || ((sp.consecutiveLossesThreshold as number) ?? 9999) < 9999 || ((sp.cooldownBars as number) ?? 0) > 0
    }
  }
  return {
    name: (s?.name as string) ?? '',
    typeId: (s?.typeId as string) ?? 'ma_kdj',
    symbols: ((s?.symbols as string[]) ?? []),
    params,
  }
}

const formData = ref(makeForm())

const positionPctDisplay = ref('')
const stopLossDisplay = ref('')

watch(() => formData.value.params.positionRatio, (v) => {
  positionPctDisplay.value = ((v as number) * 100).toFixed(2)
}, { immediate: true })

watch(() => formData.value.params.stopLossFactor, (v) => {
  stopLossDisplay.value = (v as number).toFixed(4)
}, { immediate: true })

const commitPosition = () => {
  const raw = positionPctDisplay.value.trim().replace('%', '')
  const num = Number(raw)
  if (!Number.isFinite(num) || raw === '') {
    message.warning('请输入有效数字')
    positionPctDisplay.value = ((formData.value.params.positionRatio as number) * 100).toFixed(2)
    return
  }
  const ratio = num / 100
  const min = 0.01, max = 1
  let clamped = Math.min(max, Math.max(min, ratio))
  clamped = Math.round(clamped * 10000) / 10000
  if (Math.abs(clamped - ratio) > 1e-9) message.info(`已调整为 ${(clamped * 100).toFixed(2)}%`)
  formData.value.params.positionRatio = clamped
  positionPctDisplay.value = (clamped * 100).toFixed(2)
}

const commitStopLoss = () => {
  const raw = stopLossDisplay.value.trim()
  const num = Number(raw)
  if (!Number.isFinite(num) || raw === '') {
    message.warning('请输入有效数字')
    stopLossDisplay.value = (formData.value.params.stopLossFactor as number).toFixed(4)
    return
  }
  const min = 0.5, max = 2
  let clamped = Math.min(max, Math.max(min, num))
  clamped = Math.round(clamped * 10000) / 10000
  if (Math.abs(clamped - num) > 1e-9) message.info(`已调整为 ${clamped.toFixed(4)}`)
  formData.value.params.stopLossFactor = clamped
  stopLossDisplay.value = clamped.toFixed(4)
}

const datePickerType = computed(() => (formData.value.params.timeframe === '1d' ? 'date' : 'datetime'))
const dateFormat = computed(() => (formData.value.params.timeframe === '1d' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss'))

const pad = (n: number) => n.toString().padStart(2, '0')
const formatLocal = (iso: string, withTime: boolean) => {
  const d = new Date(iso)
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return withTime ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : s
}

const applyDateRangeDefaults = async (tf: string) => {
  try {
    const { min, max } = await symbolApi.getDateRange(tf)
    if (!min || !max) {
      formData.value.params.dateStart = null
      formData.value.params.dateEnd = null
      message.warning(`时间周期 ${tf} 暂无数据`)
      return
    }
    const withTime = tf !== '1d'
    formData.value.params.dateStart = formatLocal(min, withTime)
    formData.value.params.dateEnd = formatLocal(max, withTime)
  } catch (err: unknown) {
    message.error((err as Error).message || '加载数据区间失败')
  }
}

watch(() => props.strategy, (s) => { if (s) formData.value = makeForm(s as Record<string, unknown>) }, { immediate: true })
watch(() => props.show, (v) => {
  if (!v) return
  importStrategiesLoaded = false
  importStrategyId.value = null
  if (!props.isEdit) {
    formData.value = makeForm()
    applyDateRangeDefaults(formData.value.params.timeframe as string)
  }
  loadSymbolOptions(formData.value.params.timeframe as string)
})

const handleSubmit = async () => {
  if (!formData.value.symbols.length) {
    message.warning('请至少选择一个标的')
    return
  }
  submitting.value = true
  try {
    const p = formData.value.params
    // enableCooldown 直接传给后端，不再用 cooldownBars/threshold=9999 兼容
    const payload = {
      name: formData.value.name || undefined,
      typeId: formData.value.typeId,
      symbols: formData.value.symbols,
      params: { ...p },
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

const handleClose = () => {
  if (!props.isEdit) formData.value = makeForm()
}

const loadSymbolOptions = async (timeframe: string) => {
  loadingSymbols.value = true
  try {
    const names = await symbolApi.getNames(timeframe)
    symbolOptions.value = names.map((s: string) => ({ label: s, value: s }))
  } catch (err: unknown) {
    message.error((err as Error).message || '加载标的失败')
  } finally {
    loadingSymbols.value = false
  }
}

watch(() => formData.value.params.timeframe, (tf) => {
  if (!tf) return
  formData.value.params.dateStart = null
  formData.value.params.dateEnd = null
  loadSymbolOptions(tf as string)
  applyDateRangeDefaults(tf as string)
}, { immediate: false })

onMounted(async () => {
  try {
    const types = await strategyApi.getStrategyTypes()
    strategyTypeOptions.value = types.map((t: Record<string, string>) => ({ label: t.name, value: t.id }))
  } catch { /* ignore */ }
})
</script>

<style scoped>
.strategy-form { max-height: 60vh; overflow-y: auto; padding-right: 12px; }
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
.import-bar { margin-bottom: 16px; }
.symbol-row { display: flex; gap: 8px; width: 100%; align-items: stretch; }
.symbol-select { flex: 1; min-width: 0; }
.label-with-tip { display: inline-flex; align-items: center; gap: 4px; }
.tip-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--n-text-color-3, #888);
  font-size: 10px; color: var(--n-text-color-3, #888); cursor: help; flex-shrink: 0;
}
</style>
