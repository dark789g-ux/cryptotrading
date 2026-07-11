<template>
  <n-collapse>
    <n-collapse-item title="本次规则摘要" name="rules">
      <n-empty v-if="quadrants.length === 0" description="无规则快照" size="small" />
      <div v-else class="config-summary">
        <div v-if="universeLine" class="config-summary__universe">
          {{ universeLine }}
        </div>
        <div
          v-for="q in quadrants"
          :key="q.key"
          class="config-summary__row"
        >
          <div class="config-summary__main">
            <span class="config-summary__key">{{ q.key }}</span>
            <span class="config-summary__label">{{ q.label || '—' }}</span>
            <n-tag size="tiny" :type="q.action === 'trade' ? 'success' : 'default'" :bordered="false">
              {{ q.action }}
            </n-tag>
            <template v-if="q.action === 'trade'">
              <span class="config-summary__meta">r={{ formatRatio(q.positionRatio) }}</span>
              <span class="config-summary__meta">maxN={{ q.maxPositions ?? '—' }}</span>
              <span class="config-summary__meta">{{ rankSummary(q) }}</span>
            </template>
          </div>
          <div v-if="q.action === 'trade'" class="config-summary__exit">
            <span>exitMode={{ q.exitMode || '—' }}</span>
            <span v-if="trailingLine(q)" class="config-summary__trailing">{{ trailingLine(q) }}</span>
          </div>
        </div>
      </div>
    </n-collapse-item>

    <n-collapse-item v-if="capitalSummary.length > 0" title="资金与风控" name="capital">
      <div class="config-summary config-summary--capital">
        <div v-for="line in capitalSummary" :key="line" class="config-summary__capital-line">
          {{ line }}
        </div>
      </div>
    </n-collapse-item>
  </n-collapse>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCollapse, NCollapseItem, NEmpty, NTag } from 'naive-ui'
import type {
  QuadrantEntry,
  RegimeBacktestCapital,
  RegimeBacktestConfigSnapshot,
  RegimeBacktestRun,
  RegimeUniverse,
} from '@/api/modules/strategy/regimeEngine'
import { hydrateTrailingLockParams } from '@/components/regime/trailingLockParams'
import { labelForRankField } from '@/components/regime/rankFieldMeta'

const props = defineProps<{
  run: RegimeBacktestRun | null
}>()

const quadrants = computed<QuadrantEntry[]>(() => {
  const snap = props.run?.config as RegimeBacktestConfigSnapshot | undefined
  const list = snap?.config?.quadrants
  return Array.isArray(list) ? list : []
})

const universeLine = computed(() => {
  const snap = props.run?.config as RegimeBacktestConfigSnapshot | undefined
  const u = snap?.config?.universe as RegimeUniverse | undefined
  if (!u || u.mode === 'all') return 'universe=全市场'
  if (u.mode === 'watchlist') {
    const id = u.watchlistId ?? '—'
    return `universe=自选(${id})`
  }
  const n = u.symbols?.length ?? 0
  return `universe=自定义(${n}只)`
})

const capital = computed<RegimeBacktestCapital | null>(() => {
  const snap = props.run?.config as RegimeBacktestConfigSnapshot | undefined
  return snap?.capital ?? null
})

const capitalSummary = computed<string[]>(() => {
  const cap = capital.value
  if (!cap) return []

  const lines: string[] = []
  lines.push(`初始资金=${formatMoney(cap.initialCapital)}`)

  if (cap.requireAllPositionsProfitable) {
    lines.push('盈利门禁=on')
  }

  const sizing = cap.sizing
  if (sizing?.mode === 'source_kelly' && cap.kelly?.enabled) {
    const k = cap.kelly
    lines.push(
      `凯利=on · sim=${k.simTrades} · win=${k.windowTrades} · step=${k.stepTrades} · f=${k.kellyFraction} · maxMult=${k.kellyMaxMult} · probe=${k.enableProbe ? 'on' : 'off'}`,
    )
  } else {
    lines.push('凯利=off · sizing=fixed')
  }

  const cb = cap.circuitBreaker
  if (cb) {
    if (cb.enableCooldown) {
      lines.push(
        `连亏熔断=on · 阈值=${cb.consecutiveLossesThreshold} · base=${cb.baseCooldownDays}d · max=${cb.maxCooldownDays}d · 延=${cb.extendOnLoss} · 缩=${cb.reduceOnProfit}`,
      )
    } else {
      lines.push('连亏熔断=off')
    }
    if (cb.enableDrawdownHalt) {
      lines.push(
        `回撤熔断=on · 停于=${pct(cb.drawdownHaltPct)} · 复于=${pct(cb.drawdownResumePct)}`,
      )
    } else {
      lines.push('回撤熔断=off')
    }
  }

  return lines
})

function formatMoney(v: number): string {
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`
}

function formatRatio(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return String(v)
}

function rankSummary(q: QuadrantEntry): string {
  const label = labelForRankField(q.rankField)
  if (q.rankField === 'none' || q.rankField == null) return `sort=${label}`
  const arrow = q.rankDir === 'asc' ? '↑' : '↓'
  return `sort=${label}${arrow}`
}

function trailingLine(q: QuadrantEntry): string | null {
  if (q.exitMode !== 'trailing_lock') return null
  const p = hydrateTrailingLockParams(q.exitParams ?? null)
  const parts = [
    `maxHold=${p.maxHold ?? '—'}`,
    `stop=${p.stopRatio}`,
    `floor=${p.floorEnabled ? `on(${p.floorRatio})` : 'off'}`,
    `ma5↓=${p.ma5RequireDown ? 'yes' : 'no'}`,
  ]
  return parts.join(' · ')
}
</script>

<style scoped>
.config-summary {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.config-summary__universe {
  font-size: 12px;
  color: var(--n-text-color-3, #888);
  padding: 4px 10px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.config-summary__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--n-color-embedded, rgba(0, 0, 0, 0.03));
}

.config-summary__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.config-summary__key {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.config-summary__label {
  color: var(--n-text-color-2, #666);
}

.config-summary__meta {
  font-size: 12px;
  color: var(--n-text-color-3, #888);
  font-variant-numeric: tabular-nums;
}

.config-summary__exit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--n-text-color-3, #888);
  padding-left: 2px;
}

.config-summary__trailing {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}

.config-summary--capital {
  gap: 6px;
}

.config-summary__capital-line {
  font-size: 12px;
  color: var(--n-text-color-2, #666);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}
</style>
