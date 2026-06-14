<template>
  <div class="ffd">
    <div class="ffd__head">
      <span class="ffd__title">逐因子原始值</span>
      <span v-if="rankScore != null" class="ffd__score">综合分 {{ fmtScore(rankScore) }}</span>
    </div>

    <div v-if="!hasFactors" class="ffd__empty">
      该笔无 factor_values（老 run 或 none 排序）。
    </div>

    <table v-else class="ffd__table">
      <thead>
        <tr>
          <th>因子</th>
          <th class="ffd__num">原始值</th>
          <th class="ffd__num">权重</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in factorRows" :key="r.key">
          <td>
            {{ r.label }}
            <span v-if="!r.histAvailable" class="ffd__warn">（前向专用）</span>
          </td>
          <td class="ffd__num">
            <span v-if="r.value == null" class="ffd__null">{{ r.nullLabel }}</span>
            <span v-else>{{ fmtVal(r.value) }}</span>
          </td>
          <td class="ffd__num">{{ r.weight != null ? fmtVal(r.weight) : '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type {
  PortfolioRankFactorKey,
  RankFactor,
} from '../../api/modules/strategy/portfolioSim'
import { RANK_FACTOR_OPTION_MAP } from './portfolioSimPresets'

const props = defineProps<{
  /** 该笔的逐因子原始值（jsonb），null = 无（老 run / none）。 */
  factorValues: Record<string, number | null> | null
  /** 综合排序分（numeric string），null = 无。 */
  rankScore: string | null
  /**
   * 该 run 的 rankSpec 因子配置（来自 run.config.sources[*].rankSpec）；
   * 用于回带每因子权重。可空（legacy / 拿不到时只显原值）。
   */
  rankFactors?: RankFactor[] | null
}>()

const hasFactors = computed(
  () => props.factorValues != null && Object.keys(props.factorValues).length > 0,
)

const weightByKey = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const f of props.rankFactors ?? []) m[f.factor] = f.weight
  return m
})

interface FactorRow {
  key: string
  label: string
  histAvailable: boolean
  value: number | null
  weight: number | null
  /** value=null 时的占位文案：前向专用因子标「无历史」，否则「—」。 */
  nullLabel: string
}

const factorRows = computed<FactorRow[]>(() => {
  if (!props.factorValues) return []
  return Object.entries(props.factorValues).map(([key, value]) => {
    const meta = RANK_FACTOR_OPTION_MAP[key as PortfolioRankFactorKey]
    const histAvailable = meta?.histAvailable ?? true
    return {
      key,
      label: meta?.label ?? key,
      histAvailable,
      value,
      weight: weightByKey.value[key] ?? null,
      nullLabel: value == null && !histAvailable ? '无历史' : '—',
    }
  })
})

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.001)) {
    return v.toExponential(3)
  }
  return v.toFixed(4)
}

function fmtScore(s: string): string {
  const n = parseFloat(s)
  return Number.isFinite(n) ? n.toFixed(4) : '—'
}
</script>

<style scoped>
.ffd {
  padding: 8px 12px;
  background: var(--color-fill-secondary, rgba(0, 0, 0, 0.02));
  border-radius: 6px;
}

.ffd__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.ffd__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, #888);
}

.ffd__score {
  font-size: 12px;
  color: var(--color-primary, #2080f0);
  font-variant-numeric: tabular-nums;
}

.ffd__empty {
  font-size: 11px;
  color: var(--color-text-muted, #aaa);
}

.ffd__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.ffd__table th,
.ffd__table td {
  padding: 3px 8px;
  text-align: left;
  border-bottom: 1px solid var(--color-border, #eee);
}

.ffd__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.ffd__null {
  color: var(--color-text-muted, #aaa);
}

.ffd__warn {
  font-size: 10px;
  color: #f0a020;
}
</style>
