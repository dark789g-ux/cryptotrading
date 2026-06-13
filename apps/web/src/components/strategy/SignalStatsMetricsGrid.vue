<template>
  <n-grid :cols="5" :x-gap="12" :y-gap="12" class="metrics-grid">
    <n-grid-item>
      <n-statistic label="样本数">
        <span>{{ run.sampleCount ?? '—' }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="胜率">
        <n-tooltip v-if="run.winRate !== null" trigger="hover">
          <template #trigger>
            <span>{{ fmtPct(run.winRate) }}</span>
          </template>
          盈利笔数 / 总样本数
        </n-tooltip>
        <span v-else>—</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="赔率 b">
        <n-tooltip trigger="hover">
          <template #trigger>
            <span>{{ fmtNullable(run.payoffRatio) }}</span>
          </template>
          <span v-if="run.payoffRatio !== null">均盈 / |均亏|</span>
          <span v-else>无亏损样本，赔率无法计算</span>
        </n-tooltip>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="盈亏比 PF">
        <n-tooltip trigger="hover">
          <template #trigger>
            <span>{{ fmtNullable(run.profitFactor) }}</span>
          </template>
          <span v-if="run.profitFactor !== null">总盈利 / |总亏损|</span>
          <span v-else>无亏损样本，PF 无法计算</span>
        </n-tooltip>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="凯利 f*">
        <n-tooltip trigger="hover">
          <template #trigger>
            <span>{{ fmtNullable(run.kellyF) }}</span>
          </template>
          <span v-if="run.kellyF !== null">Kelly 最优仓位比例</span>
          <span v-else>无亏损样本，凯利无法计算</span>
        </n-tooltip>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="均持仓天数">
        <span>{{ fmtNullable(run.avgHoldDays) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="均盈">
        <span>{{ fmtPctNullable(run.avgWin) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="均亏">
        <span>{{ fmtPctNullable(run.avgLoss) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="最差单笔收益">
        <n-tooltip trigger="hover">
          <template #trigger>
            <span :style="worstStyle(run.worstTradeRet)">
              {{ fmtPctNullable(run.worstTradeRet) }}
            </span>
          </template>
          历史最差单笔收益（min ret），全胜时可为正
        </n-tooltip>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="最佳单笔收益">
        <n-tooltip trigger="hover">
          <template #trigger>
            <span :style="bestStyle(run.bestTradeRet)">
              {{ fmtPctNullable(run.bestTradeRet) }}
            </span>
          </template>
          历史最佳单笔收益（max ret）
        </n-tooltip>
      </n-statistic>
    </n-grid-item>
  </n-grid>
</template>

<script setup lang="ts">
import { NGrid, NGridItem, NStatistic, NTooltip } from 'naive-ui'
import type { SignalTestRun } from '../../api/modules/strategy/signalStats'

interface Props {
  run: SignalTestRun
}

defineProps<Props>()

function fmtNullable(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return n.toFixed(3)
}

function fmtPct(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return (n * 100).toFixed(1) + '%'
}

function fmtPctNullable(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return fmtPct(v)
}

function worstStyle(v: string | null | undefined): Record<string, string> {
  if (v === null || v === undefined) return {}
  const n = parseFloat(v)
  if (isNaN(n)) return {}
  return n < 0 ? { color: '#d03050' } : {}
}

function bestStyle(v: string | null | undefined): Record<string, string> {
  if (v === null || v === undefined) return {}
  const n = parseFloat(v)
  if (isNaN(n)) return {}
  return n > 0 ? { color: '#18a058' } : {}
}
</script>

<style scoped>
.metrics-grid {
  margin-bottom: 16px;
}
</style>
