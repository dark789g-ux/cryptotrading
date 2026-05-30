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
import {
  quantApi, type JobRow, type JobRunType, type JobStatus,
} from '@/api/modules/quant'

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
const showTrigger = ref(false)
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
    key: 'run_type',
    width: 110,
    render: row => h('span', { class: 'mono' }, row.run_type),
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
          createdAt: row.created_at,
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
    render: row => `${row.attempts}/${row.max_attempts}`,
  },
  {
    title: '创建时间',
    key: 'created_at',
    width: 200,
    render: row => row.created_at,
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
          disabled: !canCancel || row.cancel_requested,
          onClick: () => onCancel(row),
        }, { default: () => (row.cancel_requested ? '已请求取消' : '取消') }),
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

function openDetail(row: JobRow) {
  // job 详情未单独成页：把关键字段塞 dialog
  const lines = [
    `id: ${row.id}`,
    `run_type: ${row.run_type}`,
    `status: ${row.status}`,
    `stage: ${row.stage ?? '—'}`,
    `progress: ${row.progress}`,
    `params: ${JSON.stringify(row.params, null, 2)}`,
    row.error_text ? `error_text: ${row.error_text}` : '',
    row.blocked_reason ? `blocked_reason: ${row.blocked_reason}` : '',
  ].filter(Boolean).join('\n')
  dialog.info({
    title: '作业详情',
    content: () => h('pre', { class: 'job-detail' }, lines),
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
</style>
