<template>
  <n-card size="small" :bordered="false" class="config-card">
    <template #header>
      <span class="card-title">入场 base 触发</span>
    </template>
    <!-- base 触发三元组 -->
    <div class="trigger-row">
      <n-select
        v-model:value="config.base_trigger.field"
        :options="baseFieldOptions"
        :loading="metaLoading"
        placeholder="字段"
        size="small"
        style="width: 160px"
      />
      <n-select
        v-model:value="config.base_trigger.op"
        :options="opOptions"
        size="small"
        style="width: 88px"
      />
      <n-input-number
        v-model:value="config.base_trigger.value"
        size="small"
        :show-button="false"
        style="width: 100px"
        placeholder="值"
      />
    </div>

    <n-divider style="margin: 10px 0" />

    <!-- universe -->
    <div class="field-row">
      <span class="field-label">标的范围</span>
      <n-radio-group v-model:value="universeMode" size="small">
        <n-radio value="all">全市场</n-radio>
        <n-radio value="list">指定列表</n-radio>
      </n-radio-group>
      <n-input
        v-if="universeMode === 'list'"
        v-model:value="universeListText"
        size="small"
        placeholder="ts_code 逗号分隔"
        style="width: 240px; margin-left: 8px"
      />
    </div>

    <!-- 训练/验证区间 -->
    <div class="field-row">
      <span class="field-label">训练区间</span>
      <n-date-picker
        v-model:value="trainRange"
        type="daterange"
        size="small"
        :is-date-disabled="isDateDisabled"
        clearable
        style="width: 240px"
        @update:value="onTrainRangeChange"
      />
    </div>
    <div class="field-row">
      <span class="field-label">验证区间</span>
      <n-date-picker
        v-model:value="validRange"
        type="daterange"
        size="small"
        clearable
        style="width: 240px"
        @update:value="onValidRangeChange"
      />
    </div>

    <n-divider style="margin: 10px 0" />

    <!-- 网格 & 门槛 -->
    <n-card size="small" embedded :bordered="true" class="sub-card">
      <template #header>
        <span class="sub-title">网格 &amp; 门槛（专家档）</span>
      </template>
      <div class="grid-fields">
        <div class="field-row">
          <span class="field-label">max_entry_filters</span>
          <n-select
            v-model:value="config.max_entry_filters"
            :options="maxEntryOptions"
            size="small"
            style="width: 80px"
          />
        </div>
        <div class="field-row">
          <span class="field-label">min_samples</span>
          <n-input-number
            v-model:value="config.min_samples"
            size="small"
            :min="1"
            :show-button="false"
            style="width: 100px"
          />
        </div>
        <div class="field-row">
          <span class="field-label">top_k</span>
          <n-input-number
            v-model:value="config.top_k"
            size="small"
            :min="1"
            :show-button="false"
            style="width: 100px"
          />
        </div>
        <div class="field-row">
          <span class="field-label">RS 基准</span>
          <div class="checkbox-group">
            <n-checkbox
              v-for="b in rsBenchmarkOptions"
              :key="b.value"
              :checked="config.rs_benchmark.includes(b.value)"
              :disabled="b.disabled"
              size="small"
              @update:checked="(v) => toggleRsBenchmark(b.value, v)"
            >
              {{ b.label }}
            </n-checkbox>
          </div>
        </div>
        <div class="field-row">
          <span class="field-label">rs_lookback</span>
          <n-input-number
            v-model:value="config.rs_lookback"
            size="small"
            :min="1"
            :show-button="false"
            style="width: 80px"
          />
        </div>
        <div class="field-row">
          <span class="field-label">same_day_rule</span>
          <n-radio-group v-model:value="config.same_day_rule" size="small">
            <n-radio value="sl_first">sl_first</n-radio>
            <n-radio value="tp_first">tp_first</n-radio>
          </n-radio-group>
        </div>
        <div class="field-row">
          <span class="field-label">max_window</span>
          <n-input-number
            v-model:value="config.max_window"
            size="small"
            :min="1"
            :show-button="false"
            style="width: 80px"
          />
        </div>
        <div class="field-row">
          <span class="field-label">bootstrap_iters</span>
          <n-input-number
            v-model:value="config.bootstrap_iters"
            size="small"
            :min="1"
            :show-button="false"
            style="width: 100px"
          />
        </div>
      </div>
    </n-card>

    <!-- 出场族 -->
    <n-card size="small" embedded :bordered="true" class="sub-card" style="margin-top: 8px">
      <template #header>
        <span class="sub-title">出场族（勾选要扫的）</span>
      </template>
      <div class="checkbox-group">
        <n-checkbox
          v-for="f in EXIT_FAMILY_OPTIONS"
          :key="f.value"
          :checked="config.exit_families.includes(f.value)"
          size="small"
          @update:checked="(v) => toggleExitFamily(f.value, v)"
        >
          {{ f.label }}
        </n-checkbox>
        <!-- band_lock 独立开关：不进 exit_families（NestJS DTO 不放行），仅决定是否传 band_lock_grid -->
        <n-checkbox
          :checked="bandLockEnabled"
          size="small"
          @update:checked="toggleBandLock"
        >
          band_lock（波段跟踪止损）
        </n-checkbox>
        <!-- phase_lock 独立开关：同 presence-driven，不进 exit_families，仅决定是否传 phase_lock_grid -->
        <n-checkbox
          :checked="phaseLockEnabled"
          size="small"
          @update:checked="togglePhaseLock"
        >
          phase_lock（分阶段锁定止损）
        </n-checkbox>
      </div>

      <!-- band_lock 候选集编辑器：仅勾选时展开 -->
      <div v-if="bandLockEnabled" class="band-lock-wrap">
        <BandLockGridEditor v-model="bandLockGridModel" />
      </div>

      <!-- phase_lock 候选集编辑器：仅勾选时展开 -->
      <div v-if="phaseLockEnabled" class="band-lock-wrap">
        <PhaseLockGridEditor v-model="phaseLockGridModel" />
      </div>
    </n-card>

    <!-- 组合数预估 -->
    <div class="combo-estimate" :class="{ warn: comboCount > COMBO_WARN_THRESHOLD }">
      <template v-if="comboCount > COMBO_WARN_THRESHOLD">
        <span class="warn-icon">⚠</span>
      </template>
      预计组合数：<strong>{{ variantCount }}变体 × {{ exitCount }}出场 = {{ comboCount }}</strong>
      <span v-if="comboCount > COMBO_WARN_THRESHOLD" class="warn-hint">（估算较大，耗时可能超过 13 分钟）</span>
      <span v-else class="ok-hint">✓</span>
    </div>
  </n-card>
</template>

<script setup lang="ts">
/**
 * KellySweepConfigForm
 *
 * 配置表单，全量 12 字段 + 出场族开关 + 组合数预估。
 * base 字段下拉来自 /kelly-sweep/meta（不前端硬编码字段白名单）。
 *
 * 组合数粗估常量来源（加注释标源头）：
 *   EXIT_FAMILY_SIZES  — sweep.py:90-106 DEFAULT_EXIT_GRID
 *   ENTRY_CANDIDATES   — sweep.py:62    DEFAULT_ENTRY_FILTER_CANDIDATES（15 个）
 *
 * 这些常量是 UI 粗估用途，可接受与后端小重复（跨语言边界，前端维护粗估，meta 接口维护字段白名单）。
 *
 * I1 修复：defineModel 替代 defineProps；局部 ref 加 watch(config, resyncLocalRefs, {deep:true})
 * 保证父覆写（历史加载）时 universeMode/trainRange/validRange 同步。
 */
import { computed, onMounted, ref } from 'vue'
import {
  NCard, NCheckbox, NDatePicker, NDivider, NInput, NInputNumber,
  NRadio, NRadioGroup, NSelect,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { kellySweepApi, type ExitFamily, type BaseTriggerOp } from '@/api/modules/quant/kellySweep'
import type { SweepParams, BandLockGrid } from '@/api/modules/quant/kellySweep'
import { useKellySweepConfigSync } from '@/composables/quant/useKellySweepConfigSync'
import { usePhaseLockGrid } from '@/composables/quant/usePhaseLockGrid'
import {
  makeDefaultBandLockGrid, estimateBandLockGridSize, estimatePhaseLockGridSize,
} from '@/stores/kellySweep'
import BandLockGridEditor from '@/components/quant/kelly-sweep/BandLockGridEditor.vue'
import PhaseLockGridEditor from '@/components/quant/kelly-sweep/PhaseLockGridEditor.vue'

// ---------- 出场族常量（来源 sweep.py:90-106 DEFAULT_EXIT_GRID，UI 粗估用） ----------
const EXIT_FAMILY_SIZES: Record<ExitFamily, number> = {
  fixed_n: 5,
  tp_sl: 36,
  trailing: 6,
  atr_stop: 6,
}

/** 入场附加特征候选数（来源 sweep.py:62 DEFAULT_ENTRY_FILTER_CANDIDATES，15 个），粗估变体数上界用 */
const ENTRY_CANDIDATES = 15

/** >5000 显示警告（来源 sweep.py _COMBO_WARN_THRESHOLD=5000） */
const COMBO_WARN_THRESHOLD = 5000

const EXIT_FAMILY_OPTIONS: { label: string; value: ExitFamily }[] = [
  { label: `fixed_n(${EXIT_FAMILY_SIZES.fixed_n})`, value: 'fixed_n' },
  { label: `tp_sl(${EXIT_FAMILY_SIZES.tp_sl})`, value: 'tp_sl' },
  { label: `trailing(${EXIT_FAMILY_SIZES.trailing})`, value: 'trailing' },
  { label: `atr_stop(${EXIT_FAMILY_SIZES.atr_stop})`, value: 'atr_stop' },
]

// ---------- defineModel（I1 修复：替代 defineProps，避免直接 mutate） ----------
const config = defineModel<SweepParams>({ required: true })

// ---------- Meta 加载 ----------
const metaLoading = ref(false)
const baseFields = ref<string[]>([])

onMounted(async () => {
  metaLoading.value = true
  try {
    const meta = await kellySweepApi.getMeta()
    baseFields.value = meta.base_fields ?? []
  } catch (e) {
    console.warn('[KellySweepConfigForm] getMeta failed', e)
    baseFields.value = []
  } finally {
    metaLoading.value = false
  }
})

// ---------- 下拉选项 ----------
const baseFieldOptions = computed<SelectOption[]>(() =>
  baseFields.value.map(f => ({ label: f, value: f })),
)

const opOptions: SelectOption[] = [
  { label: '<', value: 'lt' as BaseTriggerOp },
  { label: '<=', value: 'lte' as BaseTriggerOp },
  { label: '>', value: 'gt' as BaseTriggerOp },
  { label: '>=', value: 'gte' as BaseTriggerOp },
  { label: '=', value: 'eq' as BaseTriggerOp },
  { label: '!=', value: 'neq' as BaseTriggerOp },
]

const maxEntryOptions: SelectOption[] = [0, 1, 2, 3, 4].map(n => ({ label: String(n), value: n }))

/** RS 基准，industry 禁用（Python 会抛 NotImplementedError） */
const rsBenchmarkOptions: { label: string; value: string; disabled: boolean }[] = [
  { label: 'hs300', value: 'hs300', disabled: false },
  { label: 'zz500', value: 'zz500', disabled: false },
  { label: 'industry（未接通）', value: 'industry', disabled: true },
]

// ---------- universe / 日期区间同步（抽至 composable） ----------
const {
  universeMode,
  universeListText,
  trainRange,
  validRange,
  onTrainRangeChange,
  onValidRangeChange,
} = useKellySweepConfigSync(config)

function isDateDisabled(): boolean {
  return false
}

// ---------- 出场族切换 ----------
function toggleExitFamily(f: ExitFamily, checked: boolean) {
  if (checked) {
    if (!config.value.exit_families.includes(f)) {
      config.value = { ...config.value, exit_families: [...config.value.exit_families, f] }
    }
  } else {
    config.value = { ...config.value, exit_families: config.value.exit_families.filter(x => x !== f) }
  }
}

// ---------- band_lock 出场族（独立开关，不进 exit_families） ----------
// band_lock 不属 NestJS DTO 合法 exit_families {fixed_n,tp_sl,trailing,atr_stop}，
// 故不写入 config.exit_families；band_lock 段是否生效由 config.band_lock_grid 是否存在驱动
// （Python kelly_sweep_runner._build_exit_grid_from_params：band_lock_grid 提供 → 生成 band_lock 段）。
const bandLockEnabled = computed(() => config.value.band_lock_grid !== undefined)

function toggleBandLock(checked: boolean) {
  if (checked) {
    config.value = { ...config.value, band_lock_grid: makeDefaultBandLockGrid() }
  } else {
    const { band_lock_grid, ...rest } = config.value
    void band_lock_grid
    config.value = rest as SweepParams
  }
}

/** band_lock 候选集 v-model 桥接：getter 兜底默认（v-if 保证仅 enabled 时渲染），setter 写回 config */
const bandLockGridModel = computed<BandLockGrid>({
  get: () => config.value.band_lock_grid ?? makeDefaultBandLockGrid(),
  set: (v) => {
    config.value = { ...config.value, band_lock_grid: v }
  },
})

// ---------- phase_lock 出场族（独立开关，不进 exit_families；逻辑见 usePhaseLockGrid） ----------
// presence-driven 完全镜像 band_lock：由 config.phase_lock_grid 是否存在驱动，不写 exit_families。
const { phaseLockEnabled, togglePhaseLock, phaseLockGridModel } = usePhaseLockGrid(config)

// ---------- RS 基准切换 ----------
function toggleRsBenchmark(v: string, checked: boolean) {
  if (checked) {
    if (!config.value.rs_benchmark.includes(v)) {
      config.value = { ...config.value, rs_benchmark: [...config.value.rs_benchmark, v] }
    }
  } else {
    config.value = { ...config.value, rs_benchmark: config.value.rs_benchmark.filter(x => x !== v) }
  }
}

// ---------- 组合数粗估 ----------

/** 粗估变体数：sum_{k=0..max_entry_filters} C(ENTRY_CANDIDATES, k)，含 base 变体 */
function comb(n: number, k: number): number {
  if (k > n) return 0
  if (k === 0) return 1
  let result = 1
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1)
  }
  return Math.round(result)
}

const variantCount = computed(() => {
  let total = 0
  const maxK = config.value.max_entry_filters
  for (let k = 0; k <= maxK; k++) {
    total += comb(ENTRY_CANDIDATES, k)
  }
  return total
})

const exitCount = computed(() => {
  // exit_families 各族出场数 + band_lock 网格 + phase_lock 网格（勾选时）；
  // 与后端 build_exit_grid 合并 band_lock_grid / phase_lock_grid 同口径
  const familySum = config.value.exit_families.reduce((sum, f) => sum + (EXIT_FAMILY_SIZES[f] ?? 0), 0)
  const bandLockSum = config.value.band_lock_grid
    ? estimateBandLockGridSize(config.value.band_lock_grid)
    : 0
  const phaseLockSum = config.value.phase_lock_grid
    ? estimatePhaseLockGridSize(config.value.phase_lock_grid)
    : 0
  return familySum + bandLockSum + phaseLockSum
})

const comboCount = computed(() => variantCount.value * exitCount.value)
</script>

<style scoped>
.config-card { margin-bottom: 0; }
.card-title { font-weight: 600; font-size: 14px; }
.sub-title { font-size: 12px; color: var(--color-text-secondary); font-weight: 600; }

.trigger-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.field-label {
  font-size: 12px;
  color: var(--color-text-muted);
  min-width: 120px;
  flex-shrink: 0;
}

.grid-fields {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.checkbox-group {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}

.sub-card {
  background: color-mix(in srgb, var(--color-surface-elevated) 60%, transparent);
}

.band-lock-wrap {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--color-border);
}

.combo-estimate {
  margin-top: 12px;
  font-size: 13px;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.combo-estimate.warn {
  color: #d97706;
}
.warn-icon {
  font-size: 14px;
}
.warn-hint {
  color: #d97706;
  font-size: 12px;
}
.ok-hint {
  color: #18a058;
  font-size: 13px;
}
</style>
