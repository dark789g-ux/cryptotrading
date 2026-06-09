<template>
  <div class="signal-stats-result">
    <!-- Config summary bar -->
    <div class="config-summary">
      <span>{{ exitModeLabel }}</span>
      <span class="dot">·</span>
      <span>{{ universeLabel }}</span>
      <span class="dot">·</span>
      <span>{{ dateRangeLabel }}</span>
      <span class="dot">·</span>
      <span>{{ conditionLabel }}</span>
    </div>

    <template v-if="latestRun">
      <!-- Running progress -->
      <SignalStatsRunProgress v-if="latestRun.status === 'running'" :run="latestRun" />

      <!-- Failed -->
      <n-alert
        v-if="latestRun.status === 'failed'"
        type="error"
        title="运行失败"
        :bordered="false"
        style="margin-bottom: 16px"
      >
        {{ latestRun.errorMessage ?? '未知错误' }}
      </n-alert>

      <!-- Completed: metrics + tabs -->
      <template v-if="latestRun.status === 'completed'">
        <n-grid :cols="5" :x-gap="12" :y-gap="12" class="metrics-grid">
          <n-grid-item>
            <n-statistic label="样本数">
              <span>{{ latestRun.sampleCount ?? '—' }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="胜率">
              <n-tooltip v-if="latestRun.winRate !== null" trigger="hover">
                <template #trigger>
                  <span>{{ fmtPct(latestRun.winRate) }}</span>
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
                  <span>{{ fmtNullable(latestRun.payoffRatio) }}</span>
                </template>
                <span v-if="latestRun.payoffRatio !== null">均盈 / |均亏|</span>
                <span v-else>无亏损样本，赔率无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="盈亏比 PF">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span>{{ fmtNullable(latestRun.profitFactor) }}</span>
                </template>
                <span v-if="latestRun.profitFactor !== null">总盈利 / |总亏损|</span>
                <span v-else>无亏损样本，PF 无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="凯利 f*">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span>{{ fmtNullable(latestRun.kellyF) }}</span>
                </template>
                <span v-if="latestRun.kellyF !== null">Kelly 最优仓位比例</span>
                <span v-else>无亏损样本，凯利无法计算</span>
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均持仓天数">
              <span>{{ fmtNullable(latestRun.avgHoldDays) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均盈">
              <span>{{ fmtPctNullable(latestRun.avgWin) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="均亏">
              <span>{{ fmtPctNullable(latestRun.avgLoss) }}</span>
            </n-statistic>
          </n-grid-item>
          <n-grid-item>
            <n-statistic label="最差单笔收益">
              <n-tooltip trigger="hover">
                <template #trigger>
                  <span :style="worstStyle(latestRun.worstTradeRet)">
                    {{ fmtPctNullable(latestRun.worstTradeRet) }}
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
                  <span :style="bestStyle(latestRun.bestTradeRet)">
                    {{ fmtPctNullable(latestRun.bestTradeRet) }}
                  </span>
                </template>
                历史最佳单笔收益（max ret）
              </n-tooltip>
            </n-statistic>
          </n-grid-item>
        </n-grid>

        <n-tabs v-model:value="activeTab" display-directive="show:lazy" type="line">
          <n-tab-pane name="histogram" tab="收益率分布">
            <RetHistogram :run-id="latestRun.id" />
          </n-tab-pane>
          <n-tab-pane name="trades" tab="逐笔明细">
            <SignalTradesPanel :run-id="latestRun.id" />
          </n-tab-pane>
        </n-tabs>
      </template>
    </template>

    <n-empty v-else description="尚无运行结果" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  NGrid,
  NGridItem,
  NStatistic,
  NTooltip,
  NAlert,
  NTabs,
  NTabPane,
  NEmpty,
} from 'naive-ui'
import type { SignalTestWithLatestRun } from '../../api/modules/strategy/signalStats'
import RetHistogram from '../../components/strategy/RetHistogram.vue'
import SignalTradesPanel from '../../components/strategy/SignalTradesPanel.vue'
import SignalStatsRunProgress from './SignalStatsRunProgress.vue'
import { fmtTradeDate } from '../../components/strategy/signalStatsFormatters'

interface Props {
  test: SignalTestWithLatestRun
}

const props = defineProps<Props>()

const latestRun = computed(() => props.test.latestRun)

// ── Config summary ─────────────────────────────────────────────────────────────

const exitModeLabel = computed(() => {
  const t = props.test
  if (t.exitMode === 'fixed_n') return `固定${t.horizonN}日`
  if (t.exitMode === 'trailing_lock')
    return t.maxHold == null ? '波段跟踪止损' : `波段跟踪止损(≤${t.maxHold})`
  return `条件出场(≤${t.maxHold})`
})

const universeLabel = computed(() => {
  const u = props.test.universe
  return u.type === 'all' ? '全市场' : `指定${u.tsCodes?.length ?? 0}只`
})

const dateRangeLabel = computed(
  () => `${fmtTradeDate(props.test.dateStart)}~${fmtTradeDate(props.test.dateEnd)}`,
)

const conditionLabel = computed(
  () => `买${props.test.buyConditions.length}/卖${props.test.exitConditions?.length ?? 0}条`,
)

// ── Formatting helpers (metrics cards only) ────────────────────────────────────

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

// ── Tabs ────────────────────────────────────────────────────────────────────────

const activeTab = ref<'histogram' | 'trades'>('histogram')
</script>

<style scoped>
.signal-stats-result {
  padding: 0;
}

.config-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 16px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--n-action-color, #f7f7fa);
  font-size: 13px;
  color: var(--n-text-color-2, #666);
}

.config-summary .dot {
  color: var(--n-text-color-3, #bbb);
}

.metrics-grid {
  margin-bottom: 16px;
}
</style>
