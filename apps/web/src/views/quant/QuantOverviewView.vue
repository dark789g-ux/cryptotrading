<template>
  <div class="page">
    <!-- M4 Part C：critical 质量告警条（仅当当日存在 critical 时显示） -->
    <n-alert
      v-if="criticalAlerts.length > 0"
      type="error"
      :title="`${tradeDate || '当日'} 数据质量告警：${criticalAlerts.length} 条 critical`"
      style="margin-bottom: 12px;"
    >
      <ul class="critical-list">
        <li v-for="a in criticalAlerts" :key="a.id">
          <span class="mono">{{ a.rule }}</span>
          <span class="detail">· {{ summarizeDetail(a.detail) }}</span>
          <router-link
            v-if="tradeDate"
            class="link"
            :to="{ name: 'quant-quality-detail', params: { date: tradeDate } }"
          >
            查看详情
          </router-link>
        </li>
      </ul>
    </n-alert>

    <div class="page-header">
      <div>
        <h2>量化 · 总览</h2>
        <p class="subtitle">当日 Top-10 选股 + 最近 14 次 run 的 OOS 指标趋势</p>
      </div>
      <div class="filters">
        <ModelVersionSelect
          :model-value="modelVersion"
          @change="onVersionChange"
        />
        <n-date-picker
          v-model:value="datePickerValue"
          type="date"
          clearable
          :is-date-disabled="() => false"
          @update:value="onDateChange"
        />
        <n-button type="primary" size="small" @click="showTrigger = true">触发训练</n-button>
      </div>
    </div>

    <n-alert v-if="errorText" type="error" :title="errorText" closable style="margin-bottom: 12px;" />

    <QuantTrainTriggerModal v-model:show="showTrigger" />

    <n-grid x-gap="16" y-gap="16" cols="1 m:6" responsive="screen">
      <n-gi span="1 m:4">
        <n-card title="当日 Top-10" size="small" :bordered="false">
          <template #header-extra>
            <span class="meta">{{ formattedTradeDate || '—' }}</span>
          </template>
          <n-empty v-if="!loading && topRows.length === 0" description="当日无评分数据" />
          <ScoreTable
            v-else
            :rows="topRows"
            :loading="loading"
            @row-click="onRowClick"
          />
        </n-card>
      </n-gi>

      <n-gi span="1 m:2">
        <n-card title="最近 14 次 Run · OOS 指标" size="small" :bordered="false">
          <n-empty v-if="!trendLoading && trendPoints.length === 0" description="暂无趋势数据" />
          <OosTrendChart v-else :points="trendPoints" />
          <n-spin v-if="trendLoading" size="small" />
        </n-card>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert, NButton, NCard, NDatePicker, NEmpty, NGi, NGrid, NSpin, useMessage,
} from 'naive-ui'
import ModelVersionSelect from '@/components/quant/ModelVersionSelect.vue'
import ScoreTable from '@/components/quant/ScoreTable.vue'
import OosTrendChart from '@/components/quant/OosTrendChart.vue'
import QuantTrainTriggerModal from '@/components/quant/QuantTrainTriggerModal.vue'
import { useQuantStore } from '@/stores/quant'
import {
  quantApi,
  type QualityItem,
  type ScoreRow,
} from '@/api/modules/quant'

const router = useRouter()
const msg = useMessage()
const quantStore = useQuantStore()

const modelVersion = ref<string>('')
/** 本地午夜 ms（CLAUDE.md 日期选择器规范） */
const datePickerValue = ref<number | null>(null)
const tradeDate = ref<string>('') // YYYYMMDD

const topRows = ref<ScoreRow[]>([])
const loading = ref(false)
const trendPoints = ref<Array<{ date: string; ndcg10?: number | null; ic?: number | null; portfolio_annual_after_cost?: number | null }>>([])
const trendLoading = ref(false)
const errorText = ref<string>('')

// M4 Part C：critical 告警
const criticalAlerts = ref<QualityItem[]>([])
const showTrigger = ref(false)

function summarizeDetail(detail: Record<string, unknown> | null | undefined): string {
  if (!detail || typeof detail !== 'object') return ''
  // 优先展示有信息量的字段；其余 fallback 截断 JSON
  const keys = ['feature_id', 'model_version', 'api_name', 'table', 'column', 'ts_code', 'factor_id']
  for (const k of keys) {
    const v = detail[k]
    if (typeof v === 'string' || typeof v === 'number') return `${k}=${v}`
  }
  try { return JSON.stringify(detail).slice(0, 80) } catch { return '' }
}

async function loadCriticalAlerts() {
  if (!tradeDate.value) return
  try {
    const res = await quantApi.getQuality(tradeDate.value, ['critical'])
    criticalAlerts.value = res.items ?? []
  } catch (e) {
    // 告警条加载失败不阻断主流程，仅 warn
    console.warn('[overview] critical alerts load failed', e)
    criticalAlerts.value = []
  }
}

const formattedTradeDate = computed(() => {
  const s = tradeDate.value
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  return s
})

/** 本地日期 -> YYYYMMDD（用 getFullYear/getMonth/getDate，不用 UTC） */
function toTradeDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function defaultLocalMidnightMs(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

async function loadVersions() {
  await quantStore.fetchAvailableVersions()
  if (quantStore.lastError) {
    errorText.value = quantStore.lastError
  }
  // 与共享 store 双向初始化：本地无值则承袭 store；本地有值则同步给 store
  if (!modelVersion.value && quantStore.currentModelVersion) {
    modelVersion.value = quantStore.currentModelVersion
  } else if (modelVersion.value && modelVersion.value !== quantStore.currentModelVersion) {
    quantStore.setCurrentModelVersion(modelVersion.value)
  }
}

async function loadTopK() {
  if (!modelVersion.value || !tradeDate.value) return
  loading.value = true
  errorText.value = ''
  try {
    const res = await quantApi.getDailyTopK({
      trade_date: tradeDate.value,
      model_version: modelVersion.value,
      top_k: 10,
    })
    topRows.value = res.rows ?? []
  } catch (e) {
    errorText.value = `加载 Top-K 失败：${(e as Error).message}`
    topRows.value = []
  } finally {
    loading.value = false
  }
}

async function loadTrend() {
  // J 不存在专门的 OOS 趋势端点；用 `/quant/runs` 取最近 N 次 run，从 oos_metrics_core 抽指标。
  // 注意：J 对 model_version filter 是**精确等于**（不是前缀匹配），如果按当前选中版本过滤大多
  //       数情况会只剩 1 条，趋势无意义；这里改为"全模型 + 取最新 14 条"，更符合"近期训练效果一览"。
  trendLoading.value = true
  try {
    const res = await quantApi.listRuns({
      page: 1,
      pageSize: 14,
      sortField: 'created_at',
      sortOrder: 'DESC',
    })
    // J 按 created_at DESC 返回；前端按时间正序绘图
    const rows = (res.rows ?? []).slice().reverse()
    trendPoints.value = rows.map((r) => ({
      date: (r.created_at || '').slice(0, 10),
      ndcg10: r.oos_metrics_core?.ndcg_at_10 ?? null,
      ic: r.oos_metrics_core?.ic ?? null,
      portfolio_annual_after_cost: r.oos_metrics_core?.portfolio_annual_after_cost ?? null,
    }))
  } catch (e) {
    // 不阻断主流程，仅在控制台 warn；errorText 给主接口留
    console.warn('[overview] trend load failed', e)
    trendPoints.value = []
  } finally {
    trendLoading.value = false
  }
}

function onVersionChange(v: string | string[] | null) {
  if (Array.isArray(v) || !v) return
  modelVersion.value = v
  quantStore.setCurrentModelVersion(v)
  syncQuery()
  loadTopK()
  loadTrend()
}

function onDateChange(ms: number | null) {
  if (ms === null) return
  tradeDate.value = toTradeDate(ms)
  syncQuery()
  loadTopK()
}

function syncQuery() {
  router.replace({
    query: {
      ...router.currentRoute.value.query,
      model_version: modelVersion.value || undefined,
      trade_date: tradeDate.value || undefined,
    },
  })
}

function applyQueryFromRoute() {
  const q = router.currentRoute.value.query
  if (typeof q.model_version === 'string') {
    modelVersion.value = q.model_version
    quantStore.setCurrentModelVersion(q.model_version)
  } else if (quantStore.currentModelVersion) {
    // URL 没带，但 store 已有（从别的 view 切过来）：承袭
    modelVersion.value = quantStore.currentModelVersion
  }
  if (typeof q.trade_date === 'string' && /^\d{8}$/.test(q.trade_date)) {
    tradeDate.value = q.trade_date
    const y = Number(tradeDate.value.slice(0, 4))
    const m = Number(tradeDate.value.slice(4, 6)) - 1
    const d = Number(tradeDate.value.slice(6, 8))
    datePickerValue.value = new Date(y, m, d).getTime()
  } else {
    datePickerValue.value = defaultLocalMidnightMs()
    tradeDate.value = toTradeDate(datePickerValue.value)
  }
}

function onRowClick(row: ScoreRow) {
  router.push({
    path: '/quant/scores',
    query: {
      trade_date: row.trade_date,
      model_version: row.model_version,
      ts_code: row.ts_code,
    },
  })
}

async function refreshAll() {
  applyQueryFromRoute()
  await loadVersions()
  await Promise.all([loadTopK(), loadTrend(), loadCriticalAlerts()])
}

onMounted(refreshAll)
onActivated(() => {
  // CLAUDE.md keep-alive 规范：切换回来重拉
  refreshAll()
})

// 兜底：保留 watch 占位以备后续扩展
watch([modelVersion, tradeDate], () => {
  // 已由各 change handler 显式触发；这里 noop
})

// 把 msg 标记为已使用（保留 import 供未来 toast）
void msg
</script>

<style scoped>
.page {
  padding: 16px 24px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.subtitle {
  color: var(--color-text-muted);
  font-size: 13px;
  margin: 4px 0 0;
}
.filters {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.meta {
  color: var(--color-text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.critical-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}
.critical-list li {
  margin: 2px 0;
}
.critical-list .mono {
  font-family: 'Menlo', 'Consolas', monospace;
  font-weight: 600;
}
.critical-list .detail {
  color: var(--color-text-muted);
  margin-left: 6px;
}
.critical-list .link {
  margin-left: 8px;
  color: var(--color-primary);
  text-decoration: underline;
  font-size: 12px;
}
</style>
