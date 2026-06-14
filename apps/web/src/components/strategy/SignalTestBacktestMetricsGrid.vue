<template>
  <n-grid :cols="4" :x-gap="12" :y-gap="12" class="bt-metrics-grid">
    <n-grid-item>
      <n-statistic label="总收益">
        <span :style="signStyle(run.totalRet)">{{ fmtPct(run.totalRet) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="年化收益">
        <span :style="signStyle(run.annualRet)">{{ fmtPct(run.annualRet) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="最大回撤">
        <span :style="ddStyle(run.maxDrawdown)">{{ fmtPct(run.maxDrawdown) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="夏普">
        <span>{{ fmtNum(run.sharpe) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="卡玛">
        <span>{{ fmtNum(run.calmar) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="日胜率">
        <span>{{ fmtPct(run.dailyWinRate) }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="成交 / 拒绝">
        <span>{{ run.nTaken ?? '—' }} / {{ run.nSkipped ?? '—' }}</span>
      </n-statistic>
    </n-grid-item>
    <n-grid-item>
      <n-statistic label="总成本">
        <span>{{ fmtMoney(run.totalCosts) }}</span>
      </n-statistic>
    </n-grid-item>
  </n-grid>
</template>

<script setup lang="ts">
import { NGrid, NGridItem, NStatistic } from 'naive-ui'
import type { SignalTestRun } from '../../api/modules/strategy/signalStats'

interface Props {
  run: SignalTestRun
}

defineProps<Props>()

function fmtNum(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return n.toFixed(3)
}

function fmtPct(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return (n * 100).toFixed(2) + '%'
}

function fmtMoney(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—'
  const n = parseFloat(v)
  if (isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function signStyle(v: string | null | undefined): Record<string, string> {
  if (v === null || v === undefined) return {}
  const n = parseFloat(v)
  if (isNaN(n)) return {}
  if (n > 0) return { color: '#18a058' }
  if (n < 0) return { color: '#d03050' }
  return {}
}

function ddStyle(v: string | null | undefined): Record<string, string> {
  if (v === null || v === undefined) return {}
  const n = parseFloat(v)
  if (isNaN(n) || n === 0) return {}
  return { color: '#d03050' }
}
</script>

<style scoped>
.bt-metrics-grid {
  margin-bottom: 16px;
}
</style>
