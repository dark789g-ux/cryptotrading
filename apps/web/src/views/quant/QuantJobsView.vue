<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>量化 · 作业队列</h2>
        <p class="subtitle">实时查看 ml.jobs 状态；运行中的 job 进度条订阅 SSE 推送</p>
      </div>
      <div class="filters">
        <n-select
          v-model:value="statusFilter"
          :options="statusOptions"
          multiple
          clearable
          placeholder="按状态过滤"
          size="small"
          style="min-width: 220px"
          @update:value="reload"
        />
        <n-select
          v-model:value="runTypeFilter"
          :options="runTypeOptions"
          multiple
          clearable
          placeholder="按 run_type 过滤"
          size="small"
          style="min-width: 240px"
          @update:value="reload"
        />
        <n-button type="primary" size="small" @click="showTrigger = true">触发训练</n-button>
        <n-button size="small" @click="showPrepare = true">备料</n-button>
        <n-button
          v-if="auth.isAdmin.value"
          size="small"
          @click="showTargetedUpdate = true"
        >定向更新</n-button>
        <n-button size="small" :disabled="loading" @click="reload">刷新</n-button>
      </div>
    </div>

    <n-alert v-if="errorText" type="error" :title="errorText" closable
      style="margin-bottom: 12px;" />

    <n-card size="small" :bordered="false">
      <n-empty v-if="!loading && rows.length === 0" description="无作业记录" />
      <n-data-table
        v-else
        :columns="columns"
        :data="rows"
        :loading="loading"
        :pagination="pagination"
        :remote="true"
        size="small"
        :bordered="false"
        :row-key="(row: JobRow) => row.id"
        :row-class-name="rowClassName"
        @update:page="onPageChange"
      />
    </n-card>

    <QuantTrainTriggerModal
      v-model:show="showTrigger"
      @submitted="onSubmitted"
    />

    <QuantTargetedUpdateModal
      v-model:show="showTargetedUpdate"
      @submitted="onSubmitted"
    />

    <PrepareModal
      v-model:show="showPrepare"
      @submitted="onSubmitted"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert, NButton, NCard, NDataTable, NEmpty, NSelect, NTag, useDialog, useMessage,
} from 'naive-ui'
import type { DataTableColumns, PaginationProps, SelectOption } from 'naive-ui'
import ProgressLine from '@/components/quant/ProgressLine.vue'
import QuantTrainTriggerModal from '@/components/quant/QuantTrainTriggerModal.vue'
import QuantTargetedUpdateModal from '@/components/quant/targeted-update/QuantTargetedUpdateModal.vue'
import PrepareModal from '@/components/quant/PrepareModal.vue'
import JobWarningsPanel from '@/components/quant/JobWarningsPanel.vue'
import {
  quantApi, type JobRow, type JobRunType, type JobStatus, type WarningItem,
} from '@/api/modules/quant'
import { useAuth } from '@/composables/hooks/useAuth'

const route = useRoute()
const router = useRouter()
const dialog = useDialog()
const msg = useMessage()

const rows = ref<JobRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const errorText = ref('')

const statusFilter = ref<JobStatus[]>([])
const runTypeFilter = ref<JobRunType[]>([])
const auth = useAuth()
const showTrigger = ref(false)
const showPrepare = ref(false)
const showTargetedUpdate = ref(false)
const highlightId = ref<string>('')

let pollTimer: number | null = null
const POLL_MS = 5000

interface StatusOption extends SelectOption {
  label: string
  value: JobStatus
}
interface RunTypeOption extends SelectOption {
  label: string
  value: JobRunType
}

const statusOptions: StatusOption[] = [
  { label: 'pending', value: 'pending' },
  { label: 'running', value: 'running' },
  { label: 'success', value: 'success' },
  { label: 'failed', value: 'failed' },
  { label: 'blocked', value: 'blocked' },
  { label: 'cancelled', value: 'cancelled' },
]

const runTypeOptions: RunTypeOption[] = [
  { label: 'sync', value: 'sync' },
  { label: 'quality', value: 'quality' },
  { label: 'factors', value: 'factors' },
  { label: 'labels', value: 'labels' },
  { label: 'features', value: 'features' },
  { label: 'train', value: 'train' },
  { label: 'train_e2e', value: 'train_e2e' },
  { label: 'infer', value: 'infer' },
  { label: 'optuna', value: 'optuna' },
  { label: 'seed_avg', value: 'seed_avg' },
  { label: 'noop', value: 'noop' },
]

const statusTagMap: Record<JobStatus, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'info',
  running: 'info',
  success: 'success',
  failed: 'error',
  blocked: 'warning',
  cancelled: 'warning',
}

function rowClassName(row: JobRow): string {
  return row.id === highlightId.value ? 'job-row-hl' : ''
}

const columns = computed<DataTableColumns<JobRow>>(() => [
  {
    title: '状态',
    key: 'status',
    width: 100,
    render(row) {
      return h(NTag, { type: statusTagMap[row.status], size: 'small' }, { default: () => row.status })
    },
  },
  {
    title: 'run_type',
    key: 'runType',
    width: 110,
    render: row => h('span', { class: 'mono' }, row.runType),
  },
  {
    title: '进度',
    key: 'progress',
    minWidth: 260,
    render(row) {
      // 运行中：开 SSE 实时推送；终态：仅显示静态条
      if (row.status === 'running' || row.status === 'pending') {
        return h(ProgressLine, {
          jobId: row.id,
          createdAt: row.createdAt,
          onDone: () => { void reload() },
        })
      }
      return h(ProgressLine, {
        progress: row.progress,
        stage: row.stage,
        state: row.status,
      })
    },
  },
  {
    title: '尝试次数',
    key: 'attempts',
    width: 90,
    align: 'right',
    render: row => `${row.attempts}/${row.maxAttempts}`,
  },
  {
    title: '警告',
    key: 'warnings',
    width: 80,
    align: 'right',
    render(row) {
      const n = row.warnings_count
        ?? (Array.isArray(row.warnings) ? row.warnings.length : 0)
      if (!n || n <= 0) return h('span', { class: 'muted' }, '—')
      return h(NTag, { type: 'warning', size: 'small' }, { default: () => `⚠ ${n}` })
    },
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 200,
    render: row => row.createdAt,
  },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    render(row) {
      const canCancel = row.status === 'pending' || row.status === 'running'
      return h('div', { class: 'row-actions' }, [
        h(NButton, {
          size: 'tiny',
          quaternary: true,
          onClick: () => openDetail(row),
        }, { default: () => '详情' }),
        h(NButton, {
          size: 'tiny',
          quaternary: true,
          disabled: !canCancel || row.cancelRequested,
          onClick: () => onCancel(row),
        }, { default: () => (row.cancelRequested ? '已请求取消' : '取消') }),
      ])
    },
  },
])

const pagination = computed<PaginationProps>(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: false,
}))

async function reload() {
  loading.value = true
  errorText.value = ''
  try {
    const res = await quantApi.listJobs({
      page: page.value,
      pageSize: pageSize.value,
      status: statusFilter.value.length > 0 ? statusFilter.value : undefined,
      run_type: runTypeFilter.value.length > 0 ? runTypeFilter.value : undefined,
    })
    rows.value = res.rows
    total.value = res.total
  } catch (e) {
    errorText.value = `加载作业列表失败：${(e as Error).message}`
    rows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function onPageChange(p: number) {
  page.value = p
  void reload()
}

/**
 * 打开 job 详情 dialog。
 *
 * onMounted 时机：dialog 命令式打开后立刻 GET /quant/jobs/:id 拉一次完整 job（含 warnings 明细）。
 * 列表行的 row 不带 warnings 明细（仅 warnings_count），明细只在 GET single 时返。
 * 详见 PIT 窗口护门 spec 04-frontend-backend.md §4.1.5 / 06-warnings-and-startup.md §6.3
 *
 * SSE 增量 summary 在 ProgressLine 里订阅；本 dialog 当前仅显示拉取瞬间的快照，
 * 用户重新打开 dialog 自动重拉（dialog 是命令式，无 keep-alive 缓存语义）。
 */
function openDetail(row: JobRow) {
  // 用 ref 持有最新 job，dialog content 是函数式渲染，会随 ref 变化自动重渲
  const fullJob = ref<JobRow>(row)
  const fetchError = ref<string>('')

  // 立即异步拉一次完整 job，覆盖列表行（明细字段如 warnings 只在 GET single 暴露）
  quantApi
    .getJob(row.id)
    .then((j) => { fullJob.value = j })
    .catch((e: Error) => { fetchError.value = e.message })

  dialog.info({
    title: '作业详情',
    content: () => {
      const j = fullJob.value
      const lines = [
        `id: ${j.id}`,
        `run_type: ${j.runType}`,
        `status: ${j.status}`,
        `stage: ${j.stage ?? '—'}`,
        `progress: ${j.progress}`,
        `params: ${JSON.stringify(j.params, null, 2)}`,
        j.errorText ? `error_text: ${j.errorText}` : '',
        j.blockedReason ? `blocked_reason: ${j.blockedReason}` : '',
      ].filter(Boolean).join('\n')
      const warnings: WarningItem[] = Array.isArray(j.warnings) ? j.warnings : []
      return h('div', null, [
        h('pre', { class: 'job-detail' }, lines),
        fetchError.value
          ? h('div', { class: 'job-detail-error' }, `拉取最新详情失败：${fetchError.value}`)
          : null,
        warnings.length > 0
          ? h(JobWarningsPanel, { warnings, defaultOpen: true })
          : null,
      ])
    },
    positiveText: '关闭',
  })
}

function onCancel(row: JobRow) {
  dialog.warning({
    title: '请求取消该作业？',
    content: `worker 将在下一次心跳前响应；id=${row.id.slice(0, 8)}…`,
    positiveText: '确认取消',
    negativeText: '不取消',
    onPositiveClick: async () => {
      try {
        await quantApi.cancelJob(row.id)
        msg.success('取消请求已发送')
        await reload()
      } catch (e) {
        msg.error(`取消失败：${(e as Error).message}`)
      }
    },
  })
}

function onSubmitted(jobId: string) {
  highlightId.value = jobId
  // 切回本页后由 onActivated 触发 reload；这里也立即拉一次
  void reload()
}

function startPoll() {
  stopPoll()
  pollTimer = window.setInterval(() => {
    // 仅当存在 running/pending 时才需要轮询列表（SSE 仅推单 job 进度，列表行计数仍需刷新）
    const hasInflight = rows.value.some(r => r.status === 'running' || r.status === 'pending')
    if (hasInflight) void reload()
  }, POLL_MS) as unknown as number
}

function stopPoll() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function pickHighlightFromRoute() {
  const v = route.query.highlight
  if (typeof v === 'string' && v.length > 0) {
    highlightId.value = v
    // 清掉 query，避免刷新后还高亮
    router.replace({ query: {} })
  }
}

onMounted(async () => {
  pickHighlightFromRoute()
  await reload()
  startPoll()
})
onActivated(async () => {
  pickHighlightFromRoute()
  await reload()
  startPoll()
})
onDeactivated(stopPoll)
onBeforeUnmount(stopPoll)
</script>

<style scoped>
.page { padding: 16px 24px; }
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
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
:deep(.mono) {
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 12px;
}
:deep(.muted) {
  color: var(--color-text-muted);
}
:deep(.row-actions) {
  display: flex;
  gap: 4px;
}
:deep(.job-row-hl > td) {
  background: color-mix(in srgb, var(--color-primary) 12%, var(--color-surface));
}
:deep(.job-detail) {
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 50vh;
  overflow: auto;
  margin: 0;
}
:deep(.job-detail-error) {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-error, #d03050);
}
</style>
