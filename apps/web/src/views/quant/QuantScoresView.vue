<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>量化 · 评分</h2>
        <p class="subtitle">按日 ranked 列表 · 多模型对照 · 单股评分历史</p>
      </div>
      <div class="filters">
        <ModelVersionSelect
          :model-value="modelVersions"
          multiple
          clearable
          placeholder="选择 1 或多个模型版本（多选则对照）"
          @change="onVersionsChange"
        />
        <n-date-picker
          v-model:value="datePickerValue"
          type="date"
          clearable
          @update:value="onDateChange"
        />
        <n-input-number
          v-model:value="topK"
          :min="1"
          :max="500"
          :step="10"
          size="small"
          style="width: 140px"
          placeholder="Top-K"
          @update:value="onTopKChange"
        >
          <template #prefix>Top-K</template>
        </n-input-number>
      </div>
    </div>

    <n-alert v-if="errorText" type="error" :title="errorText" closable style="margin-bottom: 12px;" />

    <!-- 单一模型 -->
    <n-card v-if="!isCompare" size="small" :bordered="false">
      <template #header>
        <span>{{ activeVersion || '请选择模型版本' }}</span>
      </template>
      <template #header-extra>
        <span class="meta">{{ formattedTradeDate }} · 共 {{ total }} 条</span>
      </template>
      <n-empty v-if="!loading && rows.length === 0" description="该模型当日无评分（可能未推理或日期为节假日）" />
      <ScoreTable
        v-else
        :rows="rows"
        :loading="loading"
        :page="page"
        :page-size="topK"
        :total="total"
        :remote="true"
        @row-click="onRowClick"
        @page-change="onPageChange"
      />
    </n-card>

    <!-- 多模型对照 -->
    <n-grid v-else x-gap="16" y-gap="16" :cols="compareCols">
      <n-gi v-for="group in compareGroups" :key="group.model_version">
        <n-card size="small" :title="group.model_version" :bordered="false">
          <template #header-extra>
            <span class="meta">Top-{{ topK }}</span>
          </template>
          <n-empty v-if="group.rows.length === 0" description="该版本当日无数据" />
          <ScoreTable
            v-else
            :rows="group.rows"
            show-version
            @row-click="onRowClick"
          />
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 单股评分历史抽屉 -->
    <n-drawer v-model:show="seriesDrawerShow" :width="640" placement="right">
      <n-drawer-content :title="seriesTitle" closable>
        <n-alert v-if="seriesError" type="error" :title="seriesError" style="margin-bottom: 12px;" />
        <n-spin v-if="seriesLoading">
          <div style="height: 320px"></div>
        </n-spin>
        <ScoreSeriesChart v-else-if="seriesPoints.length > 0" :points="seriesPoints" />
        <n-empty v-else description="该标的在选定区间无评分数据" />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert, NCard, NDatePicker, NDrawer, NDrawerContent, NEmpty, NGi,
  NGrid, NInputNumber, NSpin,
} from 'naive-ui'
import ModelVersionSelect from '@/components/quant/common/ModelVersionSelect.vue'
import ScoreTable from '@/components/quant/score/ScoreTable.vue'
import ScoreSeriesChart from '@/components/quant/score/ScoreSeriesChart.vue'
import { useQuantStore } from '@/stores/quant'
import {
  quantApi,
  type CompareGroup,
  type ScoreRow,
  type ScoreSeriesPoint,
} from '@/api/modules/quant'

const router = useRouter()
const quantStore = useQuantStore()

const modelVersions = ref<string[]>([])
const datePickerValue = ref<number | null>(null)
const tradeDate = ref<string>('')
const topK = ref<number>(50)
const page = ref<number>(1)

const rows = ref<ScoreRow[]>([])
const total = ref<number>(0)
const loading = ref(false)
const errorText = ref('')

const compareGroups = ref<CompareGroup[]>([])

const seriesDrawerShow = ref(false)
const seriesTitle = ref('')
const seriesPoints = ref<ScoreSeriesPoint[]>([])
const seriesLoading = ref(false)
const seriesError = ref('')

const isCompare = computed(() => modelVersions.value.length > 1)
const activeVersion = computed(() => modelVersions.value[0] ?? '')
const formattedTradeDate = computed(() => {
  const s = tradeDate.value
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  return s
})
const compareCols = computed(() => Math.min(compareGroups.value.length, 3))

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

function applyQueryFromRoute() {
  const q = router.currentRoute.value.query
  if (typeof q.model_version === 'string' && q.model_version) {
    modelVersions.value = q.model_version.split(',').filter(Boolean)
    quantStore.setCurrentModelVersion(modelVersions.value[0] ?? null)
  } else if (quantStore.currentModelVersion) {
    // URL 没带版本：承袭 store 当前版本（从 Overview 切过来时不丢失上下文）
    modelVersions.value = [quantStore.currentModelVersion]
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
  if (typeof q.top_k === 'string' && /^\d+$/.test(q.top_k)) {
    topK.value = Math.min(500, Math.max(1, Number(q.top_k)))
  }
  if (typeof q.page === 'string' && /^\d+$/.test(q.page)) {
    page.value = Math.max(1, Number(q.page))
  }
}

function syncQuery() {
  router.replace({
    query: {
      ...router.currentRoute.value.query,
      model_version: modelVersions.value.join(',') || undefined,
      trade_date: tradeDate.value || undefined,
      top_k: String(topK.value),
      page: String(page.value),
    },
  })
}

async function loadData() {
  errorText.value = ''
  if (!tradeDate.value) return
  if (modelVersions.value.length === 0) {
    rows.value = []
    total.value = 0
    compareGroups.value = []
    return
  }
  if (modelVersions.value.length === 1) {
    loading.value = true
    try {
      // J `/quant/scores/daily` 不支持 offset / 服务端分页；前端拿到 top_k 行后做 client-side 切片
      const res = await quantApi.getDailyTopK({
        trade_date: tradeDate.value,
        model_version: modelVersions.value[0],
        top_k: topK.value,
      })
      rows.value = res.rows ?? []
      total.value = res.total ?? rows.value.length
    } catch (e) {
      errorText.value = `加载评分失败：${(e as Error).message}`
      rows.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  } else {
    loading.value = true
    try {
      const res = await quantApi.compareModels({
        trade_date: tradeDate.value,
        model_versions: modelVersions.value,
        top_k: topK.value,
      })
      compareGroups.value = res.groups ?? []
    } catch (e) {
      errorText.value = `加载对照失败：${(e as Error).message}`
      compareGroups.value = []
    } finally {
      loading.value = false
    }
  }
}

function onVersionsChange(v: string | string[] | null) {
  if (Array.isArray(v)) modelVersions.value = v
  else if (typeof v === 'string') modelVersions.value = [v]
  else modelVersions.value = []
  // 共享 store 同步当前首选版本（单选首项；多选时也用第一项作 store 当前）
  quantStore.setCurrentModelVersion(modelVersions.value[0] ?? null)
  page.value = 1
  syncQuery()
  loadData()
}

function onDateChange(ms: number | null) {
  if (ms === null) return
  tradeDate.value = toTradeDate(ms)
  page.value = 1
  syncQuery()
  loadData()
}

function onTopKChange(v: number | null) {
  if (v === null) return
  topK.value = v
  page.value = 1
  syncQuery()
  loadData()
}

function onPageChange(p: number) {
  page.value = p
  syncQuery()
  loadData()
}

async function onRowClick(row: ScoreRow) {
  seriesTitle.value = `${row.ts_code}${row.name ? ' · ' + row.name : ''} · ${row.model_version}`
  seriesDrawerShow.value = true
  seriesPoints.value = []
  seriesError.value = ''
  seriesLoading.value = true
  try {
    // 默认查最近 6 个月窗口
    const end = tradeDate.value
    const endDate = new Date(
      Number(end.slice(0, 4)),
      Number(end.slice(4, 6)) - 1,
      Number(end.slice(6, 8)),
    )
    const startDate = new Date(endDate)
    startDate.setMonth(endDate.getMonth() - 6)
    const start = `${startDate.getFullYear()}${String(startDate.getMonth() + 1).padStart(2, '0')}${String(startDate.getDate()).padStart(2, '0')}`
    const res = await quantApi.getScoreTimeSeries({
      ts_code: row.ts_code,
      model_version: row.model_version,
      start,
      end,
    })
    seriesPoints.value = res.points ?? []
  } catch (e) {
    seriesError.value = `加载时间序列失败：${(e as Error).message}`
  } finally {
    seriesLoading.value = false
  }
}

async function init() {
  applyQueryFromRoute()
  if (modelVersions.value.length === 0) {
    await quantStore.fetchAvailableVersions()
    if (quantStore.lastError) {
      errorText.value = quantStore.lastError
    }
    if (quantStore.currentModelVersion) {
      modelVersions.value = [quantStore.currentModelVersion]
      syncQuery()
    }
  }
  await loadData()
}

onMounted(init)
onActivated(init)
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
</style>
