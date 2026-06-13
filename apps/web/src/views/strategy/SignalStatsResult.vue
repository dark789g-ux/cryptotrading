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

      <n-tabs v-model:value="activeTab" display-directive="show:lazy" type="line">
        <n-tab-pane name="config" tab="方案配置">
          <SignalTestConfigPanel :test="test" />
        </n-tab-pane>
        <n-tab-pane
          name="histogram"
          tab="收益率分布"
          :disabled="latestRun.status !== 'completed'"
        >
          <SignalStatsMetricsGrid
            v-if="latestRun.status === 'completed'"
            :run="latestRun"
          />
          <RetHistogram v-if="latestRun.status === 'completed'" :run-id="latestRun.id" />
        </n-tab-pane>
        <n-tab-pane
          name="trades"
          tab="逐笔明细"
          :disabled="latestRun.status !== 'completed'"
        >
          <SignalTradesPanel v-if="latestRun.status === 'completed'" :run-id="latestRun.id" />
        </n-tab-pane>
      </n-tabs>
    </template>

    <n-empty v-else description="尚无运行结果" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NAlert, NTabs, NTabPane, NEmpty } from 'naive-ui'
import type { SignalTestWithLatestRun } from '../../api/modules/strategy/signalStats'
import RetHistogram from '../../components/strategy/RetHistogram.vue'
import SignalStatsMetricsGrid from '../../components/strategy/SignalStatsMetricsGrid.vue'
import SignalTradesPanel from '../../components/strategy/SignalTradesPanel.vue'
import SignalTestConfigPanel from '../../components/strategy/SignalTestConfigPanel.vue'
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
  if (t.exitMode === 'phase_lock') return '两阶段锁定止损'
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

// ── Tabs ────────────────────────────────────────────────────────────────────────

const activeTab = ref<'config' | 'histogram' | 'trades'>('histogram')

watch(
  () => latestRun.value?.status,
  (status) => {
    if (status !== 'completed' && (activeTab.value === 'histogram' || activeTab.value === 'trades')) {
      activeTab.value = 'config'
    }
  },
  { immediate: true },
)
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
</style>
