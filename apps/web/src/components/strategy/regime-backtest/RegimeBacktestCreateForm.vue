<template>
  <div class="regime-backtest-create-form">
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100">
      <n-form-item label="方案名" path="name">
        <n-input v-model:value="form.name" placeholder="例：v3 现实成本回测" style="width: 280px" />
      </n-form-item>
      <n-form-item label="初始资金" path="initialCapital">
        <n-input-number
          v-model:value="form.initialCapital"
          :min="10000"
          :step="100000"
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item label="成本预设">
        <n-select
          v-model:value="costTier"
          :options="costTierOptions"
          style="width: 280px"
        />
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
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item v-if="universeMode === 'symbols'" label="ts_code">
        <n-input
          v-model:value="symbolsText"
          type="textarea"
          placeholder="每行一个 ts_code，如 000001.SZ"
          :rows="3"
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item label="回测区间">
        <n-date-picker
          v-model:value="dateRange"
          type="daterange"
          clearable
          :is-date-disabled="isDateDisabled"
          style="width: 280px"
        />
      </n-form-item>
    </n-form>

    <n-divider title-placement="left">资金与风控</n-divider>
    <RegimeBacktestCapitalForm v-model="capitalForm" />

    <n-divider title-placement="left">Regime 规则</n-divider>
    <RegimeConfigEditor v-if="active" ref="editorRef" mode="create" embedded />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NDatePicker,
  NDivider,
  NRadioGroup,
  NRadio,
  useMessage,
  type FormRules,
  type FormInst,
} from 'naive-ui'
import type {
  RegimeBacktestCostRates,
  RegimeBacktestRun,
  RegimeConfigMap,
  RegimeUniverse,
} from '@/api/modules/strategy/regimeEngine'
import { regimeBacktestApi } from '@/api/modules/strategy/regimeEngine'
import { watchlistApi } from '@/api'
import RegimeConfigEditor from '@/components/regime/RegimeConfigEditor.vue'
import RegimeBacktestCapitalForm from './RegimeBacktestCapitalForm.vue'
import {
  buildCapitalPayload,
  defaultCapitalFormState,
  type RegimeCapitalFormState,
} from './regimeCapitalForm'

const COST_TIER_PRESETS: Record<string, RegimeBacktestCostRates> = {
  optimistic: {
    commissionPerSide: 0.00025,
    transferPerSide: 0.00001,
    stampSellBefore20230828: 0.001,
    stampSellFrom20230828: 0.0005,
    slippagePerSide: 0,
  },
  realistic: {
    commissionPerSide: 0.00025,
    transferPerSide: 0.00001,
    stampSellBefore20230828: 0.001,
    stampSellFrom20230828: 0.0005,
    slippagePerSide: 0.0005,
  },
  conservative: {
    commissionPerSide: 0.00025,
    transferPerSide: 0.00001,
    stampSellBefore20230828: 0.001,
    stampSellFrom20230828: 0.0005,
    slippagePerSide: 0.001,
  },
  zero: {
    commissionPerSide: 0,
    transferPerSide: 0,
    stampSellBefore20230828: 0,
    stampSellFrom20230828: 0,
    slippagePerSide: 0,
  },
}

const COST_TIER_OPTIONS = [
  { label: '乐观（滑点 0）', value: 'optimistic' },
  { label: '现实（滑点万5）', value: 'realistic' },
  { label: '保守（滑点千1）', value: 'conservative' },
  { label: '零成本（对账用）', value: 'zero' },
]

type EditorExpose = {
  validateAndGetConfig: () => RegimeConfigMap | null
}

const props = defineProps<{
  active?: boolean
}>()

const emit = defineEmits<{
  success: [run: RegimeBacktestRun]
}>()

const message = useMessage()
const formRef = ref<FormInst | null>(null)
const editorRef = ref<EditorExpose | null>(null)
const submitting = ref(false)

const form = ref({
  name: '',
  initialCapital: 1000000,
})

const capitalForm = ref<RegimeCapitalFormState>(defaultCapitalFormState())

const costTier = ref('realistic')
const dateRange = ref<[number, number] | null>(null)
const costTierOptions = COST_TIER_OPTIONS

const universeMode = ref<'all' | 'watchlist' | 'symbols'>('all')
const watchlistId = ref<string | null>(null)
const symbolsText = ref('')
const watchlistOptions = ref<Array<{ label: string; value: string }>>([])
const watchlistsLoading = ref(false)

const rules: FormRules = {
  name: { required: true, message: '请输入方案名', trigger: 'blur' },
  initialCapital: { required: true, type: 'number', min: 10000, message: '最低 1 万', trigger: 'blur' },
}

const canSubmit = computed(() => {
  const universeOk =
    universeMode.value === 'all' ||
    (universeMode.value === 'watchlist' && !!watchlistId.value) ||
    (universeMode.value === 'symbols' && parseSymbols(symbolsText.value).length > 0)
  return (
    form.value.name.trim() !== '' &&
    dateRange.value !== null &&
    form.value.initialCapital >= 10000 &&
    universeOk
  )
})

function parseSymbols(text: string): string[] {
  return text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function buildUniverse(): RegimeUniverse {
  if (universeMode.value === 'watchlist' && watchlistId.value) {
    return { mode: 'watchlist', watchlistId: watchlistId.value }
  }
  if (universeMode.value === 'symbols') {
    return { mode: 'symbols', symbols: parseSymbols(symbolsText.value) }
  }
  return { mode: 'all' }
}

async function loadWatchlists() {
  watchlistsLoading.value = true
  try {
    const lists = await watchlistApi.list()
    watchlistOptions.value = lists.map((w) => ({ label: w.name, value: w.id }))
  } catch {
    watchlistOptions.value = []
  } finally {
    watchlistsLoading.value = false
  }
}

onMounted(() => {
  void loadWatchlists()
})

function todayLocalMs(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function isDateDisabled(ts: number): boolean {
  return ts > todayLocalMs()
}

function msToTradeDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function resetForm() {
  form.value = {
    name: '',
    initialCapital: 1000000,
  }
  capitalForm.value = defaultCapitalFormState()
  costTier.value = 'realistic'
  dateRange.value = null
  universeMode.value = 'all'
  watchlistId.value = null
  symbolsText.value = ''
  formRef.value?.restoreValidation()
}

watch(
  () => props.active,
  (v, prev) => {
    if (prev && !v) resetForm()
  },
)

async function submit(): Promise<boolean> {
  if (!canSubmit.value) {
    message.warning('请填写完整参数')
    return false
  }
  if (!dateRange.value) {
    message.warning('请填写完整参数')
    return false
  }
  const cfg = editorRef.value?.validateAndGetConfig()
  if (!cfg) return false

  const universe = buildUniverse()
  const config: RegimeConfigMap = { ...cfg, universe }

  const cost = COST_TIER_PRESETS[costTier.value] ?? COST_TIER_PRESETS.realistic
  submitting.value = true
  try {
    const run = await regimeBacktestApi.create({
      name: form.value.name.trim(),
      config,
      capital: {
        initialCapital: form.value.initialCapital,
        cost,
        ...buildCapitalPayload(capitalForm.value),
      },
      dateStart: msToTradeDate(dateRange.value[0]),
      dateEnd: msToTradeDate(dateRange.value[1]),
    })
    message.success(`回测已创建：${run.name}`)
    try {
      await regimeBacktestApi.run(run.id)
    } catch (runErr: unknown) {
      const runMsg = runErr instanceof Error ? runErr.message : '回测启动失败，请稍后在列表中重试'
      message.error(runMsg)
    }
    emit('success', run)
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '创建失败'
    message.error(msg)
    return false
  } finally {
    submitting.value = false
  }
}

defineExpose({ submit, canSubmit, submitting, resetForm })
</script>

<style scoped>
.regime-backtest-create-form {
  max-height: 62vh;
  overflow-y: auto;
  padding-right: 8px;
}
</style>
