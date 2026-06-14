<template>
  <div class="detail">
    <!-- 运行中：步骤条 -->
    <div v-if="run.status === 'running'" class="detail__running">
      <PortfolioSimRunSteps
        :phase="run.phase"
        :progress-done="run.progressDone"
        :progress-total="run.progressTotal"
      />
    </div>

    <!-- 失败 -->
    <n-alert v-else-if="run.status === 'failed'" type="error" :bordered="false">
      运行失败：{{ run.errorMessage ?? '未知错误' }}
    </n-alert>

    <!-- 成功 -->
    <template v-else-if="run.status === 'success'">
      <!-- 锚点徽章 -->
      <div v-if="run.config.anchorMode && run.anchorCheck" class="detail__anchor">
        <n-tag
          :type="run.anchorCheck.pass ? 'success' : 'error'"
          size="large"
          round
        >
          {{ run.anchorCheck.pass ? '锚点对账通过' : '锚点对账未通过' }}
        </n-tag>
        <n-table :bordered="false" :single-line="false" size="small" class="detail__anchor-table">
          <thead>
            <tr><th>指标</th><th>官方</th><th>复算</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Kelly</td>
              <td>{{ fmt(run.anchorCheck.kellyOfficial, 4) }}</td>
              <td>{{ fmt(run.anchorCheck.kellyReplayed, 4) }}</td>
            </tr>
            <tr>
              <td>胜率</td>
              <td>{{ fmtPct(run.anchorCheck.winOfficial) }}</td>
              <td>{{ fmtPct(run.anchorCheck.winReplayed) }}</td>
            </tr>
            <tr>
              <td>样本数</td>
              <td>{{ run.anchorCheck.nOfficial }}</td>
              <td>{{ run.anchorCheck.nReplayed }}</td>
            </tr>
          </tbody>
        </n-table>
      </div>

      <!-- 指标卡 ×6 -->
      <div class="detail__metrics">
        <div v-for="m in metricCards" :key="m.label" class="metric-card">
          <div class="metric-card__label">{{ m.label }}</div>
          <div class="metric-card__value" :class="m.cls">{{ m.value }}</div>
        </div>
      </div>

      <!-- 净值曲线 -->
      <n-card title="净值曲线" size="small" :bordered="false" class="detail__card">
        <n-spin :show="dailyLoading">
          <PortfolioSimNavChart
            v-if="dailyRows.length"
            :rows="dailyRows"
            :initial-capital="run.config.initialCapital"
          />
          <n-empty v-else-if="!dailyLoading" description="暂无每日净值数据" />
        </n-spin>
      </n-card>

      <!-- 逐信号明细 -->
      <n-card size="small" :bordered="false" class="detail__card">
        <template #header>逐信号明细</template>
        <template #header-extra>
          <span class="detail__note">
            成交 {{ run.nTaken ?? '—' }} · 弃单 {{ run.nSkipped ?? '—' }}（弃单分布见下方「弃单原因」筛选）
          </span>
        </template>
        <PortfolioSimFillsTable :key="run.id" :run-id="run.id" :config="run.config" />
      </n-card>
    </template>

    <!-- pending -->
    <n-empty v-else description="尚未运行，请点「运行」" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NCard, NEmpty, NSpin, NTable, NTag } from 'naive-ui'
import PortfolioSimRunSteps from './PortfolioSimRunSteps.vue'
import PortfolioSimNavChart from './PortfolioSimNavChart.vue'
import PortfolioSimFillsTable from './PortfolioSimFillsTable.vue'
import { portfolioSimApi } from '../../api/modules/strategy/portfolioSim'
import type {
  PortfolioSimRun,
  PortfolioSimDailyRow,
} from '../../api/modules/strategy/portfolioSim'

const props = defineProps<{ run: PortfolioSimRun }>()

// ── 数字格式化 ───────────────────────────────────────────────────────────────
function fmt(v: number | string | null, digits = 2): string {
  if (v == null) return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

function fmtPct(v: number | string | null, digits = 2): string {
  if (v == null) return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—'
}

function signClass(v: string | null): string {
  if (v == null) return ''
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return ''
  return n > 0 ? 'pos' : n < 0 ? 'neg' : ''
}

// ── 指标卡 ×6 ────────────────────────────────────────────────────────────────
const metricCards = computed(() => {
  const r = props.run
  return [
    { label: '总收益', value: fmtPct(r.totalRet), cls: signClass(r.totalRet) },
    { label: '年化', value: fmtPct(r.annualRet), cls: signClass(r.annualRet) },
    { label: '最大回撤', value: fmtPct(r.maxDrawdown), cls: signClass(r.maxDrawdown) },
    { label: 'Sharpe', value: fmt(r.sharpe, 2), cls: '' },
    { label: '日 Kelly', value: fmt(r.dailyKelly, 4), cls: '' },
    { label: '总成本', value: fmt(r.totalCosts, 2), cls: '' },
  ]
})

// ── 每日净值 ─────────────────────────────────────────────────────────────────
const dailyRows = ref<PortfolioSimDailyRow[]>([])
const dailyLoading = ref(false)

async function loadDaily() {
  if (props.run.status !== 'success') return
  dailyLoading.value = true
  try {
    dailyRows.value = await portfolioSimApi.listDaily(props.run.id)
  } finally {
    dailyLoading.value = false
  }
}

watch(
  () => [props.run.id, props.run.status],
  () => {
    dailyRows.value = []
    void loadDaily()
  },
  { immediate: true },
)
</script>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail__running {
  padding: 8px 0;
}

.detail__anchor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail__anchor-table {
  max-width: 360px;
}

.detail__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.metric-card {
  border: 1px solid var(--color-border, #e0e0e6);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--color-surface-elevated, transparent);
}

.metric-card__label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
  margin-bottom: 6px;
}

.metric-card__value {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.detail__card {
  border: 1px solid var(--color-border, #e0e0e6);
  border-radius: 10px;
}

.detail__note {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.pos {
  color: #d03050;
}

.neg {
  color: #18a058;
}
</style>
