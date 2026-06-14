<template>
  <div class="rank-spec">
    <div class="rank-spec__head">
      <span class="rank-spec__title">多因子排序 rankSpec</span>
      <span class="rank-spec__hint">{{ modeHint }}</span>
    </div>

    <div v-if="factors.length === 0" class="rank-spec__empty">
      未配置因子 = 不排序（按 ts_code 升序）。
    </div>

    <div v-for="(f, i) in factors" :key="i" class="rank-spec__row">
      <n-select
        :value="f.factor"
        :options="factorOptions"
        size="small"
        :disabled="disabled"
        style="flex: 1; min-width: 160px"
        @update:value="(v: PortfolioRankFactorKey) => onFactorChange(i, v)"
      />
      <n-input-number
        :value="f.weight"
        :min="0.0001"
        :step="0.1"
        size="small"
        :disabled="disabled"
        placeholder="权重"
        style="width: 100px"
        @update:value="(v: number | null) => patchFactor(i, { weight: v ?? 0.0001 })"
      />
      <n-select
        :value="f.dir"
        :options="dirOptions"
        size="small"
        :disabled="disabled"
        style="width: 130px"
        @update:value="(v: PortfolioRankDir) => patchFactor(i, { dir: v })"
      />
      <n-button
        size="tiny"
        quaternary
        type="error"
        :disabled="disabled"
        @click="removeFactor(i)"
      >
        −
      </n-button>
    </div>

    <div v-if="histWarning" class="rank-spec__warn">
      含前向专用因子（ml_score）：历史回测几乎全 null，仅前向有效。
    </div>

    <n-button
      size="tiny"
      dashed
      :disabled="disabled"
      class="rank-spec__add"
      @click="addFactor"
    >
      + 加因子
    </n-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInputNumber, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import type {
  RankFactor,
  PortfolioRankFactorKey,
  PortfolioRankDir,
} from '../../api/modules/strategy/portfolioSim'
import {
  RANK_FACTOR_OPTIONS,
  RANK_FACTOR_OPTION_MAP,
  RANK_DIR_OPTIONS,
} from './portfolioSimPresets'

const props = defineProps<{
  /** 当前因子数组（[] = none，len1 = 单因子，len>1 = composite）。 */
  factors: RankFactor[]
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:factors', factors: RankFactor[]): void
}>()

const factorOptions: SelectOption[] = RANK_FACTOR_OPTIONS.map((o) => ({
  label: o.label,
  value: o.value,
}))
const dirOptions: SelectOption[] = RANK_DIR_OPTIONS.map((o) => ({
  label: o.label,
  value: o.value,
}))

const modeHint = computed(() => {
  const n = props.factors.length
  if (n === 0) return '当前：none（不排序）'
  if (n === 1) return '当前：单因子'
  return `当前：composite（${n} 因子加权）`
})

const histWarning = computed(() =>
  props.factors.some((f) => RANK_FACTOR_OPTION_MAP[f.factor]?.histAvailable === false),
)

/** 取一个尚未被选用的因子 KEY 作为新行默认（优先历史可用、按选项顺序）。 */
function nextUnusedFactor(): PortfolioRankFactorKey {
  const used = new Set(props.factors.map((f) => f.factor))
  const free = RANK_FACTOR_OPTIONS.find((o) => !used.has(o.value))
  return (free ?? RANK_FACTOR_OPTIONS[0]).value
}

function emitFactors(next: RankFactor[]) {
  emit('update:factors', next)
}

function addFactor() {
  const key = nextUnusedFactor()
  const meta = RANK_FACTOR_OPTION_MAP[key]
  emitFactors([
    ...props.factors,
    { factor: key, weight: 1, dir: meta?.defaultDir ?? 'asc' },
  ])
}

function removeFactor(i: number) {
  emitFactors(props.factors.filter((_, idx) => idx !== i))
}

function patchFactor(i: number, patch: Partial<RankFactor>) {
  emitFactors(props.factors.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
}

/** 切因子时，方向重置为该因子的默认 dir（更贴合语义）。 */
function onFactorChange(i: number, v: PortfolioRankFactorKey) {
  const meta = RANK_FACTOR_OPTION_MAP[v]
  patchFactor(i, { factor: v, dir: meta?.defaultDir ?? props.factors[i].dir })
}
</script>

<style scoped>
.rank-spec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px dashed var(--color-border, #e0e0e6);
  border-radius: 6px;
}

.rank-spec__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rank-spec__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, #888);
}

.rank-spec__hint {
  font-size: 11px;
  color: var(--color-primary, #2080f0);
}

.rank-spec__empty {
  font-size: 11px;
  color: var(--color-text-muted, #aaa);
}

.rank-spec__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rank-spec__warn {
  font-size: 11px;
  color: #f0a020;
}

.rank-spec__add {
  align-self: flex-start;
}
</style>
