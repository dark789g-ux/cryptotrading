<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>凯利网格搜索操作台</h2>
        <p class="subtitle">
          入场条件 × 出场参数网格批量算凯利上界，找「信号少 + 凯利高」的方案（纯研究口径）
        </p>
      </div>
      <!-- 历史扫描下拉 -->
      <div class="header-actions">
        <div class="history-select-wrap">
          <n-select
            v-model:value="selectedHistoryJobId"
            :options="historyOptions"
            :loading="store.historyLoading"
            clearable
            placeholder="历史扫描…"
            size="small"
            style="min-width: 220px"
            @update:value="onHistorySelect"
          />
          <div v-if="store.historyError" class="err">{{ store.historyError }}</div>
        </div>
        <n-button size="small" @click="store.loadHistory()">刷新历史</n-button>
      </div>
    </div>

    <n-alert v-if="submitError" type="error" :title="submitError" closable style="margin-bottom: 12px" @close="submitError = ''" />

    <div class="main-layout">
      <!-- 左：配置表单 + 发起 -->
      <div class="left-col">
        <KellySweepConfigForm v-model="store.config" />

        <div class="launch-row">
          <n-button
            type="primary"
            :loading="submitting"
            :disabled="submitting"
            @click="onSubmit"
          >
            发起扫描
          </n-button>
          <span v-if="runningWarning" class="warn-hint">
            ⚠ 已有 kelly_sweep 任务运行中，确认继续？
          </span>
        </div>

        <!-- SSE 进度（job 存在时展示） -->
        <div v-if="store.currentJobId" class="progress-section">
          <div class="progress-label">运行进度</div>
          <ProgressLine
            :job-id="store.currentJobId"
            @done="onJobDone"
          />
        </div>
      </div>

      <!-- 右：结果面板 -->
      <div class="right-col">
        <template v-if="store.currentJobId">
          <KellySweepResultPanel
            :job-id="store.currentJobId"
            :summary="store.summary"
            :summary-loading="store.summaryLoading"
            :summary-error="store.summaryError"
            :scatter-with-rs="store.scatterWithRs"
            :scatter-no-rs="store.scatterNoRs"
            :scatter-loading="store.scatterLoading"
            :scatter-error="store.scatterError"
            :topk-with-rs="store.topkWithRs"
            :topk-no-rs="store.topkNoRs"
            :topk-total-with-rs="store.topkTotalWithRs"
            :topk-total-no-rs="store.topkTotalNoRs"
            :topk-loading="store.topkLoading"
            :topk-error="store.topkError"
          />
        </template>
        <div v-else class="empty-result">
          <n-empty description="发起扫描后查看结果，或从「历史扫描」加载已有结果" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import ProgressLine from '@/components/quant/ProgressLine.vue'
import KellySweepConfigForm from './KellySweepConfigForm.vue'
import KellySweepResultPanel from './KellySweepResultPanel.vue'
import { useKellySweepStore } from '@/stores/kellySweep'
import { kellySweepApi, type SweepParams } from '@/api/modules/quant/kellySweep'

const store = useKellySweepStore()

const submitting = ref(false)
const submitError = ref('')
const runningWarning = ref(false)
const selectedHistoryJobId = ref<string | null>(null)

// ---------- 历史下拉选项 ----------
const historyOptions = computed<SelectOption[]>(() => {
  const page = store.historyPage
  if (!page) return []
  return page.rows.map(r => ({
    label: `${r.createdAt?.slice(0, 16) ?? r.id.slice(0, 8)} [${r.status}]`,
    value: r.id,
  }))
})

// ---------- 加载历史 ----------
onMounted(async () => {
  await store.loadHistory()
})

// ---------- 历史 job 选择 ----------
async function onHistorySelect(jobId: string | null) {
  if (!jobId) return
  store.setCurrentJob(jobId)
  await store.loadResults(jobId)
  // I1 验收：历史 job 加载后，用 job.params 覆写 store.config，
  // ConfigForm 的 defineModel + watch(config, resyncLocalRefs, {deep:true}) 会同步
  // universeMode / universeListText / trainRange / validRange 等局部 ref
  const params = store.summary?.params
  if (params && typeof params === 'object') {
    // 深拷贝后 Object.assign，避免直接引用 summary 内部对象（防副作用）
    const newConfig = JSON.parse(JSON.stringify(params)) as SweepParams
    Object.assign(store.config, newConfig)
  }
}

// ---------- 发起扫描 ----------
async function onSubmit() {
  submitError.value = ''
  runningWarning.value = false
  submitting.value = true
  try {
    // 软护栏：检查是否有 running kelly_sweep job
    const history = await kellySweepApi.getHistory({ status: 'running', page: 1 })
    if (history.total > 0) {
      runningWarning.value = true
    }
    const job = await kellySweepApi.createSweepJob(store.config)
    store.setCurrentJob(job.id)
    // 刷新历史列表
    await store.loadHistory()
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : '发起失败'
  } finally {
    submitting.value = false
  }
}

// ---------- job 完成回调 ----------
async function onJobDone() {
  if (!store.currentJobId) return
  await store.loadResults(store.currentJobId)
  await store.loadHistory()
}
</script>

<style scoped>
.page {
  padding: 16px 24px;
  min-height: 100%;
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
.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.main-layout {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.left-col {
  flex: 0 0 360px;
  min-width: 320px;
}
.right-col {
  flex: 1;
  min-width: 0;
}

.launch-row {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
  flex-wrap: wrap;
}
.warn-hint {
  color: #d97706;
  font-size: 12px;
}
.history-select-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.err {
  color: var(--color-error, #d03050);
  font-size: 12px;
}

.progress-section {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.progress-label {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}

.empty-result {
  padding: 48px 24px;
  display: flex;
  justify-content: center;
}
</style>
