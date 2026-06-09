<template>
  <div class="result-panel">
    <!-- 摘要行 -->
    <div v-if="summaryLoading" class="summary-row muted">加载摘要…</div>
    <div v-else-if="summaryError" class="summary-row err">{{ summaryError }}</div>
    <div v-else-if="summary" class="summary-row">
      <span class="summary-label">最优 Kelly</span>
      <strong class="kelly-val">{{ fmtNum(summary.result_payload?.best?.kelly_valid ?? null) }}</strong>
      <span v-if="summary.result_payload?.best?.kelly_ci_low != null && summary.result_payload?.best?.kelly_ci_high != null" class="muted-sm">
        CI [{{ fmtNum(summary.result_payload.best.kelly_ci_low) }}, {{ fmtNum(summary.result_payload.best.kelly_ci_high) }}]
      </span>
      <span v-if="summary.result_payload?.best?.n_valid != null" class="muted-sm">n={{ summary.result_payload.best.n_valid }}</span>
      <span class="sep">|</span>
      <span class="muted-sm">共 {{ summary.result_payload?.n_rows ?? '?' }} 组合</span>
      <span class="sep">|</span>
      <span class="muted-sm">Top-K {{ summary.result_payload?.n_topk ?? '?' }}</span>
    </div>

    <!-- RS 分组 tab -->
    <n-tabs v-model:value="activeGroup" type="segment" size="small" style="margin-top: 12px">
      <n-tab-pane name="with_rs" tab="含 RS (with_rs)">
        <KellyGroupPanel
          group="with_rs"
          :job-id="jobId"
          :scatter-points="scatterWithRs"
          :scatter-loading="scatterLoading"
          :initial-topk-rows="topkWithRs"
          :initial-topk-total="topkTotalWithRs"
          @detail="onDetailRequest"
        />
      </n-tab-pane>
      <n-tab-pane name="no_rs" tab="不含 RS (no_rs)">
        <KellyGroupPanel
          group="no_rs"
          :job-id="jobId"
          :scatter-points="scatterNoRs"
          :scatter-loading="scatterLoading"
          :initial-topk-rows="topkNoRs"
          :initial-topk-total="topkTotalNoRs"
          @detail="onDetailRequest"
        />
      </n-tab-pane>
    </n-tabs>

    <!-- 详情弹窗 -->
    <AppModal
      :show="showDetail"
      :title="detailTitle"
      width="min(700px, 95vw)"
      :maximizable="true"
      @update:show="showDetail = $event"
    >
      <KellySweepRowDetail
        :detail="detailData"
        :loading="detailLoading"
        :error="detailError"
      />
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NTabs, NTabPane } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import KellySweepRowDetail from '@/components/quant/kelly-sweep/KellySweepRowDetail.vue'
import KellyGroupPanel from '@/components/quant/kelly-sweep/KellyGroupPanel.vue'
import type { KellyScatterPoint, KellyTopkRow, KellySweepSummary, KellyRowDetail } from '@/api/modules/quant/kellySweep'
import { kellySweepApi } from '@/api/modules/quant/kellySweep'

// ---------- Props ----------
const props = defineProps<{
  jobId: string | null
  summary: KellySweepSummary | null
  summaryLoading?: boolean
  summaryError?: string | null
  scatterWithRs: KellyScatterPoint[]
  scatterNoRs: KellyScatterPoint[]
  scatterLoading?: boolean
  topkWithRs: KellyTopkRow[]
  topkNoRs: KellyTopkRow[]
  topkTotalWithRs: number
  topkTotalNoRs: number
  topkLoading?: boolean
}>()

// ---------- Tab ----------
const activeGroup = ref<'with_rs' | 'no_rs'>('with_rs')

// ---------- 格式化 ----------
function fmtNum(v: number | null): string {
  if (v === null || v === undefined) return '—'
  return v.toFixed(3)
}

// ---------- 详情弹窗 ----------
const showDetail = ref(false)
const detailData = ref<KellyRowDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)

const detailTitle = computed(() => {
  if (!detailData.value) return '行详情'
  const v = detailData.value.variantId ?? '?'
  const e = detailData.value.exitId ?? '?'
  return `${v} + ${e} [${detailData.value.windowGroup ?? ''}]`
})

async function onDetailRequest(row: KellyTopkRow) {
  if (!props.jobId) return
  showDetail.value = true
  detailData.value = null
  detailLoading.value = true
  detailError.value = null
  try {
    detailData.value = await kellySweepApi.getRowDetail(props.jobId, row.id)
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : '加载详情失败'
  } finally {
    detailLoading.value = false
  }
}
</script>

<style scoped>
.result-panel { padding: 0; }

.summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
  padding: 8px 0;
}
.summary-label { color: var(--color-text-muted); font-size: 12px; }
.kelly-val { font-size: 16px; color: #f6a623; }
.muted-sm { color: var(--color-text-muted); font-size: 12px; }
.sep { color: var(--color-border); }
.muted { color: var(--color-text-muted); font-size: 13px; padding: 8px 0; }
.err { color: var(--color-error, #d03050); font-size: 13px; padding: 8px 0; }
</style>
