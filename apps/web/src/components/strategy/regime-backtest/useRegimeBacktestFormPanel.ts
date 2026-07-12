import { computed, ref, watch, onMounted, type Ref } from 'vue'
import { useMessage, type FormInst, type FormRules } from 'naive-ui'
import type {
  RegimeBacktestCostRates,
  RegimeBacktestRun,
  RegimeConfigMap,
  RegimeUniverse,
  QuadrantEntry,
} from '@/api/modules/strategy/regimeEngine'
import { regimeBacktestApi } from '@/api/modules/strategy/regimeEngine'
import { aSharesApi } from '@/api/modules/market/aShares'
import { watchlistApi } from '@/api'
import { useRegimeConfigForm } from '@/components/regime/useRegimeConfigForm'
import { cloneQuadrant, makeDefaultQuadrant, hydrateProfitGateFromCapital } from '@/components/regime/regimeConfigEditor.helpers'
import {
  buildCapitalPayload,
  defaultCapitalFormState,
  hydrateCapitalFormState,
  type RegimeCapitalFormState,
} from './regimeCapitalForm'

export const COST_TIER_PRESETS: Record<string, RegimeBacktestCostRates> = {
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

export const COST_TIER_OPTIONS = [
  { label: '乐观（滑点 0）', value: 'optimistic' },
  { label: '现实（滑点万5）', value: 'realistic' },
  { label: '保守（滑点千1）', value: 'conservative' },
  { label: '零成本（对账用）', value: 'zero' },
]

function parseSymbols(text: string): string[] {
  return text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function tradeDateToMs(d: string): number {
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(4, 6)) - 1
  const day = Number(d.slice(6, 8))
  return new Date(y, m, day).getTime()
}

function msToTradeDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** 把毫秒时间戳格式化为 YYYY-MM-DD 展示串（仅供 hint 文字用，不复用于提交） */
function msToDisplay(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function matchCostTier(cost: RegimeBacktestCostRates | undefined): string {
  if (!cost) return 'realistic'
  for (const [key, preset] of Object.entries(COST_TIER_PRESETS)) {
    if (
      preset.commissionPerSide === cost.commissionPerSide &&
      preset.transferPerSide === cost.transferPerSide &&
      preset.stampSellBefore20230828 === cost.stampSellBefore20230828 &&
      preset.stampSellFrom20230828 === cost.stampSellFrom20230828 &&
      preset.slippagePerSide === cost.slippagePerSide
    ) {
      return key
    }
  }
  return 'realistic'
}

export function useRegimeBacktestFormPanel(options: {
  active: Ref<boolean>
  runId: Ref<string | null | undefined>
  onSuccess: (run: RegimeBacktestRun) => void
}) {
  const message = useMessage()
  const formRef = ref<FormInst | null>(null)
  const submitting = ref(false)
  const hydrating = ref(false)
  /** 编辑态：仅当成功 hydrate 到当前 runId 后才允许提交，避免竞态/失败后误写 */
  const hydratedRunId = ref<string | null>(null)
  const activeTab = ref('basics')

  const form = ref({
    name: '',
    initialCapital: 1000000,
  })

  const capitalForm = ref<RegimeCapitalFormState>(defaultCapitalFormState())
  const costTier = ref('realistic')
  const dateRange = ref<[number, number] | null>(null)

  /**
   * 回测区间可选下限（全局全市场 min/max of raw.daily_quote）。
   * null 表示未加载或加载失败 —— 此时 isDateDisabled 降级为仅禁未来，不阻塞用户。
   * 约束与标的集合无关，故跨 reset / 标的切换保持，不随表单字段清空。
   */
  const availableRange = ref<{ startMs: number; endMs: number } | null>(null)
  const availableRangeLoading = ref(false)
  const availableRangeText = computed(() => {
    if (availableRangeLoading.value) return '加载中...'
    if (!availableRange.value) return '获取失败，已忽略限制'
    const { startMs, endMs } = availableRange.value
    return `${msToDisplay(startMs)} ～ ${msToDisplay(endMs)}`
  })

  async function loadAvailableRange() {
    // 全局全市场 min/max 在应用生命周期内不变；已成功加载过则跳过，避免重复请求 / 旧响应覆盖
    if (availableRange.value) return
    availableRangeLoading.value = true
    try {
      const { min, max } = await aSharesApi.getDateRange()
      if (min && max) {
        availableRange.value = { startMs: tradeDateToMs(min), endMs: tradeDateToMs(max) }
      } else {
        availableRange.value = null
      }
    } catch {
      availableRange.value = null
    } finally {
      availableRangeLoading.value = false
    }
  }

  const universeMode = ref<'all' | 'watchlist' | 'symbols'>('all')
  const watchlistId = ref<string | null>(null)
  const symbolsText = ref('')
  const watchlistOptions = ref<Array<{ label: string; value: string }>>([])
  const watchlistsLoading = ref(false)

  const showImportPopover = ref(false)
  const importSearchText = ref('')
  const loadingImportSchemes = ref(false)
  const importSchemeOptions = ref<Array<{ label: string; value: string }>>([])
  let importSchemesLoaded = false

  const filteredImportOptions = computed(() => {
    if (!importSearchText.value) return importSchemeOptions.value
    const lower = importSearchText.value.toLowerCase()
    return importSchemeOptions.value.filter((o) => o.label.toLowerCase().includes(lower))
  })

  const isEdit = computed(() => !!options.runId.value)

  const {
    form: regimeForm,
    activeTab: activeQuadrantKey,
    isSingleQuadrant,
    overlapWarnings,
    addQuadrant,
    handleImportQuadrants,
    removeQuadrant,
    validateAndGetConfig,
  } = useRegimeConfigForm({
    initialData: ref(null),
    mode: ref('create'),
  })

  const rules: FormRules = {
    name: { required: true, message: '请输入方案名', trigger: 'blur' },
    initialCapital: {
      required: true,
      type: 'number',
      min: 10000,
      message: '最低 1 万',
      trigger: 'blur',
    },
  }

  const canSubmit = computed(() => {
    const universeOk =
      universeMode.value === 'all' ||
      (universeMode.value === 'watchlist' && !!watchlistId.value) ||
      (universeMode.value === 'symbols' && parseSymbols(symbolsText.value).length > 0)
    const hydrateOk =
      !isEdit.value || hydratedRunId.value === options.runId.value
    return (
      form.value.name.trim() !== '' &&
      dateRange.value !== null &&
      form.value.initialCapital >= 10000 &&
      universeOk &&
      !hydrating.value &&
      hydrateOk
    )
  })

  function buildUniverse(): RegimeUniverse {
    if (universeMode.value === 'watchlist' && watchlistId.value) {
      return { mode: 'watchlist', watchlistId: watchlistId.value }
    }
    if (universeMode.value === 'symbols') {
      return { mode: 'symbols', symbols: parseSymbols(symbolsText.value) }
    }
    return { mode: 'all' }
  }

  function applyUniverse(universe: RegimeUniverse | undefined) {
    if (!universe || universe.mode === 'all') {
      universeMode.value = 'all'
      watchlistId.value = null
      symbolsText.value = ''
      return
    }
    if (universe.mode === 'watchlist') {
      universeMode.value = 'watchlist'
      watchlistId.value = universe.watchlistId ?? null
      symbolsText.value = ''
      return
    }
    universeMode.value = 'symbols'
    watchlistId.value = null
    symbolsText.value = (universe.symbols ?? []).join('\n')
  }

  function applyQuadrants(
    quadrants: QuadrantEntry[] | undefined,
    capital?: { requireAllPositionsProfitable?: boolean } | null,
  ) {
    if (Array.isArray(quadrants) && quadrants.length > 0) {
      regimeForm.quadrants = quadrants.map((q) => cloneQuadrant(q))
      hydrateProfitGateFromCapital(regimeForm.quadrants, capital)
    } else {
      regimeForm.quadrants = [makeDefaultQuadrant('q1', '象限1')]
    }
    activeQuadrantKey.value = regimeForm.quadrants[0]?.key ?? ''
  }

  function hydrateFromRun(run: RegimeBacktestRun) {
    const snap = run.config
    const cfg = snap?.config
    const capital = snap?.capital

    form.value = {
      name: run.name ?? '',
      initialCapital: capital?.initialCapital ?? 1000000,
    }
    capitalForm.value = hydrateCapitalFormState(capital)
    costTier.value = matchCostTier(capital?.cost)
    if (run.dateStart && run.dateEnd) {
      dateRange.value = [tradeDateToMs(run.dateStart), tradeDateToMs(run.dateEnd)]
    } else {
      dateRange.value = null
    }
    applyUniverse(cfg?.universe)
    applyQuadrants(cfg?.quadrants, capital)
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

  async function loadImportSchemes() {
    if (importSchemesLoaded) return
    loadingImportSchemes.value = true
    try {
      const res = await regimeBacktestApi.list(1, 100)
      importSchemeOptions.value = res.items
        .filter((r) => r.id !== options.runId.value)
        .map((r) => ({ label: r.name, value: r.id }))
      importSchemesLoaded = true
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '加载方案列表失败')
    } finally {
      loadingImportSchemes.value = false
    }
  }

  async function handleImportScheme(id: string) {
    try {
      const run = await regimeBacktestApi.get(id)
      hydrateFromRun(run)
      message.success('方案参数已导入')
      showImportPopover.value = false
      importSearchText.value = ''
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '导入失败')
    }
  }

  async function hydrateEditRun() {
    const requestId = options.runId.value
    if (!requestId) return
    hydrating.value = true
    hydratedRunId.value = null
    try {
      const run = await regimeBacktestApi.get(requestId)
      if (options.runId.value !== requestId) return
      hydrateFromRun(run)
      hydratedRunId.value = requestId
    } catch (err: unknown) {
      if (options.runId.value !== requestId) return
      message.error(err instanceof Error ? err.message : '加载方案失败')
      resetForm()
    } finally {
      if (options.runId.value === requestId) {
        hydrating.value = false
      }
    }
  }

  function todayLocalMs(): number {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }

  function isDateDisabled(ts: number): boolean {
    if (ts > todayLocalMs()) return true
    if (availableRange.value && ts < availableRange.value.startMs) return true
    return false
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
    activeTab.value = 'basics'
    hydratedRunId.value = null
    hydrating.value = false
    applyQuadrants(undefined)
    formRef.value?.restoreValidation()
    importSchemesLoaded = false
    importSearchText.value = ''
    showImportPopover.value = false
  }

  function prepareOpen() {
    activeTab.value = 'basics'
    importSchemesLoaded = false
    importSearchText.value = ''
    void loadAvailableRange()
    if (options.runId.value) {
      void hydrateEditRun()
    } else {
      resetForm()
    }
  }

  watch(
    () => options.active.value,
    (v, prev) => {
      if (v) prepareOpen()
      else if (prev && !options.runId.value) resetForm()
    },
  )

  watch(showImportPopover, (v) => {
    if (v) void loadImportSchemes()
    else importSearchText.value = ''
  })

  watch(
    () => options.runId.value,
    (id) => {
      if (options.active.value && id) void hydrateEditRun()
    },
  )

  onMounted(() => {
    void loadWatchlists()
    if (options.active.value) {
      prepareOpen()
    } else {
      void loadAvailableRange()
    }
  })

  async function submit(): Promise<boolean> {
    if (!canSubmit.value) {
      message.warning('请填写完整参数')
      return false
    }
    if (!dateRange.value) {
      message.warning('请填写完整参数')
      return false
    }
    const cfg = validateAndGetConfig()
    if (!cfg) {
      activeTab.value = 'buckets'
      return false
    }

    const universe = buildUniverse()
    const config: RegimeConfigMap = { ...cfg, universe }
    const cost = COST_TIER_PRESETS[costTier.value] ?? COST_TIER_PRESETS.realistic
    const dto = {
      name: form.value.name.trim(),
      config,
      capital: {
        initialCapital: form.value.initialCapital,
        cost,
        ...buildCapitalPayload(capitalForm.value),
      },
      dateStart: msToTradeDate(dateRange.value[0]),
      dateEnd: msToTradeDate(dateRange.value[1]),
    }

    submitting.value = true
    try {
      const runId = options.runId.value
      const run =
        isEdit.value && runId
          ? await regimeBacktestApi.update(runId, dto)
          : await regimeBacktestApi.create(dto)
      message.success(isEdit.value ? `方案已更新：${run.name}` : `方案已保存：${run.name}`)
      options.onSuccess(run)
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : isEdit.value ? '更新失败' : '保存失败'
      message.error(msg)
      return false
    } finally {
      submitting.value = false
    }
  }

  return {
    formRef,
    submitting,
    activeTab,
    form,
    capitalForm,
    costTier,
    costTierOptions: COST_TIER_OPTIONS,
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
  }
}
