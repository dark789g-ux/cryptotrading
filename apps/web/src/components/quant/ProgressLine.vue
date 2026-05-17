<template>
  <div class="progress-line">
    <div class="progress-meta">
      <span class="stage">{{ stageText || '—' }}</span>
      <span class="meta-right">
        <span v-if="elapsedText" class="elapsed">{{ elapsedText }}</span>
        <span class="percent">{{ percent }}%</span>
      </span>
    </div>
    <n-progress
      type="line"
      :percentage="percent"
      :status="naiveStatus"
      :indicator-placement="indicatorPlacement"
      :show-indicator="false"
      :height="8"
      :border-radius="4"
    />
    <div v-if="connError" class="conn-error">SSE 连接异常：{{ connError }}（{{ retryHint }}）</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { NProgress } from 'naive-ui'
import { quantApi, type JobProgressEvent, type JobStatus } from '@/api/modules/quant'

/**
 * 训练进度条
 *
 * 两种模式：
 * 1) **受控模式**：父组件传 `progress` / `stage` / `state`，内部不开 SSE（兼容 M3）
 * 2) **SSE 模式**：父组件传 `jobId`，内部：
 *    a. POST /quant/jobs/:id/sse-token 拿 token
 *    b. new EventSource('/quant/jobs/:id/stream?token=...') 订阅 progress
 *    c. 终态（success/failed/blocked/cancelled）自动断流 + emit 'done'
 *    d. 失败重连：连接 onerror 时 5s 后重试，最多 3 次；每次重连先 GET /quant/jobs/:id
 *       立即拿当前 progress 兜底（00-index §3 SSE 重连回补行为）
 *
 * 设计：两模式互斥，jobId 优先；不混用，避免父组件状态被 SSE 覆盖造成抖动。
 */
const props = withDefaults(
  defineProps<{
    /** SSE 模式：传 jobId 后内部接管 progress / stage / state */
    jobId?: string | null
    /** 受控模式：0..100 */
    progress?: number
    stage?: string | null
    state?: JobStatus
    indicatorPlacement?: 'inside' | 'outside'
    /** 用 createdAt（UTC 墙钟字符串）算已耗时；不传则不显示 */
    createdAt?: string | null
  }>(),
  {
    jobId: null,
    progress: 0,
    stage: null,
    state: 'running',
    indicatorPlacement: 'outside',
    createdAt: null,
  },
)

const emit = defineEmits<{
  /** 终态触发；payload 为最终状态 */
  done: [state: JobStatus]
  /** 每次收到进度事件透出 */
  progress: [event: JobProgressEvent]
  /** SSE 重连兜底失败时 */
  error: [message: string]
}>()

// --- 内部状态（SSE 模式专用） ---
const innerProgress = ref(0)
const innerStage = ref<string | null>(null)
const innerState = ref<JobStatus>('pending')
const connError = ref<string | null>(null)
const retryCount = ref(0)
const MAX_RETRY = 3
const RETRY_DELAY_MS = 5000

let es: EventSource | null = null
let retryTimer: number | null = null
let elapsedTimer: number | null = null
const nowMs = ref(Date.now())

// 仅 SSE 模式生效
const isSseMode = computed(() => !!props.jobId)

const percent = computed(() => {
  const raw = isSseMode.value ? innerProgress.value : props.progress
  const v = Number(raw)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, Math.round(v)))
})

const stageText = computed(() => (isSseMode.value ? innerStage.value : props.stage) ?? '')

const status = computed<JobStatus>(() =>
  isSseMode.value ? innerState.value : (props.state ?? 'running'),
)

const naiveStatus = computed<'default' | 'success' | 'error' | 'warning' | 'info'>(() => {
  switch (status.value) {
    case 'success':
      return 'success'
    case 'failed':
      return 'error'
    case 'blocked':
    case 'cancelled':
      return 'warning'
    case 'pending':
      return 'info'
    default:
      return 'default'
  }
})

const retryHint = computed(() => {
  if (retryCount.value >= MAX_RETRY) return '已达最大重试次数'
  return `${RETRY_DELAY_MS / 1000}s 后第 ${retryCount.value + 1}/${MAX_RETRY} 次重连`
})

const elapsedText = computed(() => {
  if (!props.createdAt) return ''
  const start = parseUtcWallClock(props.createdAt)
  if (start === null) return ''
  const seconds = Math.max(0, Math.floor((nowMs.value - start) / 1000))
  if (seconds < 60) return `已耗时 ${seconds}s`
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  if (mm < 60) return `已耗时 ${mm}m ${ss}s`
  const hh = Math.floor(mm / 60)
  return `已耗时 ${hh}h ${mm % 60}m`
})

function parseUtcWallClock(s: string): number | null {
  // 形如 '2026-05-17 10:30:00Z' or ISO；统一兜底
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'))
  return Number.isFinite(t) ? t : null
}

function isTerminal(st: JobStatus): boolean {
  return st === 'success' || st === 'failed' || st === 'blocked' || st === 'cancelled'
}

function closeStream() {
  if (es) {
    es.close()
    es = null
  }
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }
}

async function pullCurrent(id: string) {
  try {
    const job = await quantApi.getJob(id)
    innerProgress.value = job.progress ?? 0
    innerStage.value = job.stage ?? null
    innerState.value = job.status
    if (isTerminal(job.status)) {
      closeStream()
      emit('done', job.status)
    }
  } catch (e) {
    // 兜底失败不抛；连接 onerror 主流程会继续走重连
    console.warn('[ProgressLine] pullCurrent failed', e)
  }
}

async function openStream(id: string) {
  closeStream()
  connError.value = null
  try {
    const { token } = await quantApi.issueSseToken(id)
    const url = quantApi.buildSseUrl(id, token)
    es = new EventSource(url)
    es.onopen = () => {
      retryCount.value = 0
      connError.value = null
    }
    es.onmessage = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as JobProgressEvent
        if (payload.job_id && payload.job_id !== id) return
        if (typeof payload.progress === 'number') {
          innerProgress.value = payload.progress
        }
        if (typeof payload.stage === 'string') {
          innerStage.value = payload.stage
        }
        emit('progress', payload)
        // 进度达 100 时再 GET 拿最终 status（NOTIFY 不带 status）
        if (innerProgress.value >= 100) {
          void pullCurrent(id)
        }
      } catch (err) {
        console.warn('[ProgressLine] bad SSE payload', err, ev.data)
      }
    }
    es.onerror = () => {
      connError.value = '连接中断'
      if (es) {
        es.close()
        es = null
      }
      scheduleRetry(id)
    }
  } catch (e) {
    connError.value = (e as Error).message
    scheduleRetry(id)
  }
}

function scheduleRetry(id: string) {
  if (retryCount.value >= MAX_RETRY) {
    emit('error', `SSE 连接重试 ${MAX_RETRY} 次仍失败`)
    return
  }
  retryCount.value += 1
  retryTimer = window.setTimeout(() => {
    // 重连前先 GET 一次当前 progress 兜底（00-index §3）
    void pullCurrent(id).then(() => {
      if (!isTerminal(innerState.value)) {
        void openStream(id)
      }
    })
  }, RETRY_DELAY_MS) as unknown as number
}

// jobId 变化时（包括从 null → 有值）重新建立流
watch(
  () => props.jobId,
  (id, prev) => {
    if (prev) closeStream()
    if (!id) return
    retryCount.value = 0
    // 先回补一次当前 progress，再开流
    void pullCurrent(id).then(() => {
      if (!isTerminal(innerState.value)) {
        void openStream(id)
      }
    })
  },
  { immediate: true },
)

// elapsed 计时（仅在有 createdAt 时启动）
watch(
  () => props.createdAt,
  (s) => {
    if (elapsedTimer !== null) {
      window.clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    if (s) {
      elapsedTimer = window.setInterval(() => {
        nowMs.value = Date.now()
      }, 1000) as unknown as number
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  closeStream()
  if (elapsedTimer !== null) {
    window.clearInterval(elapsedTimer)
    elapsedTimer = null
  }
})

// CLAUDE.md keep-alive 规范：被 <keep-alive> 缓存的父组件切走 → onDeactivated 关流；
// 切回来 → onActivated 重连。避免缓存场景下 EventSource 长期占用浏览器连接配额。
onDeactivated(() => {
  closeStream()
})
onActivated(() => {
  const id = props.jobId
  if (!id) return
  retryCount.value = 0
  void pullCurrent(id).then(() => {
    if (!isTerminal(innerState.value)) {
      void openStream(id)
    }
  })
})
</script>

<style scoped>
.progress-line {
  width: 100%;
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  margin-bottom: 4px;
}
.meta-right {
  display: inline-flex;
  gap: 10px;
  align-items: center;
}
.stage {
  color: var(--color-text-secondary);
  font-weight: 500;
}
.percent {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.elapsed {
  color: var(--color-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.conn-error {
  margin-top: 4px;
  color: var(--color-warning);
  font-size: 11px;
}
</style>
