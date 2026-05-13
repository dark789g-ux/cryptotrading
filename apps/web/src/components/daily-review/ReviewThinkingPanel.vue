<template>
  <div class="thinking-panel">
    <!-- 阶段时间线（所有用户可见） -->
    <ReviewStageTimeline
      :current="currentStage"
      :timings="effectiveTimings"
      :done="isDone"
      :failed="isFailed"
    />

    <!-- 元信息条（admin only） -->
    <div v-if="auth.isAdmin.value && showMeta" class="meta-bar">
      <span v-if="effectiveModel" class="meta">模型 <strong>{{ effectiveModel }}</strong></span>
      <span class="meta">已用 <strong>{{ formatElapsed(elapsedMs) }}</strong></span>
      <span v-if="effectiveTokens" class="meta">
        输入 <strong>{{ formatTokens(effectiveTokens.prompt) }}</strong>
        / 推理 <strong>{{ formatTokens(effectiveTokens.reasoning) }}</strong>
        / 输出 <strong>{{ formatTokens(effectiveTokens.completion) }}</strong> tokens
      </span>
    </div>

    <!-- 失败提示：所有用户可见 -->
    <n-alert v-if="isFailed && errorMsg" type="error" :title="'生成失败'" class="error-alert">
      {{ errorMsg }}
    </n-alert>

    <!-- 工具调用列表：admin only，默认折叠 -->
    <div
      v-if="auth.isAdmin.value && effectiveToolCalls.length > 0"
      class="tool-calls-wrap"
      data-testid="tool-calls-section"
    >
      <n-collapse>
        <n-collapse-item
          :title="`AI 工具调用（${effectiveToolCalls.length} 次）`"
          name="tool-calls"
          display-directive="show"
        >
          <ul class="tool-call-list">
            <li
              v-for="call in effectiveToolCalls"
              :key="call.callIndex"
              class="tool-call-item"
              :class="{ 'is-error': !!call.error }"
            >
              <div class="tool-call-head">
                <span class="tool-call-index">#{{ call.callIndex }}</span>
                <code class="tool-call-name">{{ call.toolName }}</code>
                <n-tag
                  v-if="call.error"
                  size="small"
                  type="error"
                  :bordered="false"
                  class="tool-call-status"
                >
                  失败
                </n-tag>
                <span class="tool-call-duration">{{ formatDuration(call.durationMs) }}</span>
              </div>
              <div class="tool-call-args">{{ summarizeArgs(call.args) }}</div>
              <div v-if="call.error" class="tool-call-error">{{ call.error }}</div>
            </li>
          </ul>
        </n-collapse-item>
      </n-collapse>
    </div>

    <!-- 左右两栏 -->
    <div class="split">
      <!-- 思考过程：admin only -->
      <section v-if="auth.isAdmin.value" class="col reasoning-col">
        <header class="col-header" @click="toggleReasoning">
          <span class="title">💭 AI 思考过程</span>
          <span v-if="reasoningCollapsed && isDone" class="summary">
            {{ collapsedSummary }} · 点击展开
          </span>
          <n-button quaternary size="tiny">
            {{ reasoningCollapsed ? '展开' : '折叠' }}
          </n-button>
        </header>
        <div v-show="!reasoningCollapsed" class="reasoning-wrap">
          <div
            v-if="!autoFollow"
            class="auto-follow-hint"
            @click="resumeAutoFollow"
          >
            已暂停自动滚动，点击回到底部
          </div>
          <pre
            ref="reasoningEl"
            class="reasoning"
            @scroll="onReasoningScroll"
          >{{ reasoningText || (isDone ? '（无）' : '等待推理…') }}</pre>
        </div>
      </section>

      <!-- 正文预览：所有用户可见 -->
      <section class="col article-col">
        <header class="col-header static">
          <span class="title">📄 正文预览</span>
        </header>
        <div class="article-wrap">
          <ReviewArticleViewer
            v-if="articleText"
            :md="articleText"
            :live="mode === 'live'"
          />
          <n-empty v-else description="等待正文输出…" size="small" />
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NCollapse, NCollapseItem, NEmpty, NTag } from 'naive-ui'
import ReviewStageTimeline from './ReviewStageTimeline.vue'
import ReviewArticleViewer from './ReviewArticleViewer.vue'
import { useAuth } from '@/composables/hooks/useAuth'
import { useDailyReviewProgress } from '@/composables/useDailyReviewProgress'
import type { Stage, StageTiming, TokenUsage, ToolCallEntry } from '@/types/daily-review'

interface ReplayData {
  reasoningContent: string | null
  articleMd: string | null
  stageTimings: StageTiming[] | null
  tokenUsage: TokenUsage | null
  llmModel: string | null
  toolCalls?: ToolCallEntry[] | null
  status: 'completed' | 'failed'
  errorMessage: string | null
}

const props = defineProps<{
  tradeDate: string
  mode: 'live' | 'replay'
  replayData?: ReplayData | null
}>()

const emit = defineEmits<{
  (e: 'completed'): void
  (e: 'failed', error: string): void
}>()

const auth = useAuth()

// live 分支：消费 composable；replay 分支：传 null，不连 SSE
const live =
  props.mode === 'live'
    ? useDailyReviewProgress(props.tradeDate)
    : null

// 只有当 mode='live' 且 live 实例存在时才读 composable；切到 replay 后改用 replayData。
// 这样保证父组件在 SSE 完成后改 mode 即可让 panel 切到 replay 数据源。
const useLive = computed(() => props.mode === 'live' && !!live)

const currentStage = computed<Stage>(() => {
  if (useLive.value) return live!.stage.value
  const timings = props.replayData?.stageTimings ?? []
  return (timings[timings.length - 1]?.stage as Stage) ?? 'finalize'
})

const effectiveTimings = computed<StageTiming[]>(() => {
  if (useLive.value) return live!.stageTimings.value
  return props.replayData?.stageTimings ?? []
})

const effectiveTokens = computed<TokenUsage | null>(() => {
  if (useLive.value) return live!.tokenUsage.value
  return props.replayData?.tokenUsage ?? null
})

const effectiveModel = computed<string | null>(() => {
  if (useLive.value) return live!.llmModel.value
  return props.replayData?.llmModel ?? null
})

const effectiveToolCalls = computed<ToolCallEntry[]>(() => {
  if (useLive.value) return live!.toolCalls.value
  return props.replayData?.toolCalls ?? []
})

function summarizeArgs(args: Record<string, unknown>): string {
  let json = ''
  try {
    json = JSON.stringify(args)
  } catch {
    json = '[unserializable]'
  }
  return json.length > 100 ? json.slice(0, 100) + '...' : json
}
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const reasoningText = computed<string>(() => {
  if (useLive.value) return live!.reasoning.value
  return props.replayData?.reasoningContent ?? ''
})

const articleText = computed<string>(() => {
  if (useLive.value) return live!.articleStream.value
  return props.replayData?.articleMd ?? ''
})

const isDone = computed<boolean>(() => {
  if (useLive.value) return live!.done.value
  return props.mode === 'replay'
})

const isFailed = computed<boolean>(() => {
  if (useLive.value) return live!.error.value != null
  return props.replayData?.status === 'failed'
})

const errorMsg = computed<string | null>(() => {
  if (useLive.value) return live!.error.value
  return props.replayData?.errorMessage ?? null
})

const showMeta = computed(() => effectiveModel.value || effectiveTokens.value || live)

// ===== 监听 SSE 完成/失败 → 通知父组件 =====
if (live) {
  watch(
    () => live.done.value,
    (v) => {
      if (!v) return
      if (live.error.value) emit('failed', live.error.value)
      else emit('completed')
    },
  )
}

// ===== 计时器：已用时（live：从挂载开始；replay：sum durations） =====
const startTs = Date.now()
const tickNow = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  if (props.mode === 'live') {
    timer = setInterval(() => (tickNow.value = Date.now()), 1000)
  }
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
const elapsedMs = computed<number>(() => {
  if (props.mode === 'live') {
    // done 后停止增长（用最后一帧 - startTs）
    if (live?.done.value) return tickNow.value - startTs
    return tickNow.value - startTs
  }
  return (props.replayData?.stageTimings ?? []).reduce((a, b) => a + b.durationMs, 0)
})

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s}s`
}
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

// ===== reasoning 折叠状态 =====
// 完成态默认折叠（mode=replay 也算"完成态"）
const reasoningCollapsed = ref(props.mode === 'replay')
watch(isDone, (v) => {
  if (v && props.mode === 'live') reasoningCollapsed.value = true
})
function toggleReasoning() {
  reasoningCollapsed.value = !reasoningCollapsed.value
}

const collapsedSummary = computed(() => {
  const reasoningTiming = effectiveTimings.value.find((t) => t.stage === 'reasoning')
  const sec = reasoningTiming ? Math.round(reasoningTiming.durationMs / 1000) : 0
  const tk = effectiveTokens.value?.reasoning ?? 0
  if (!sec && !tk) return '💭 思考过程'
  if (!tk) return `💭 思考 ${sec}s`
  return `💭 思考 ${sec}s · 推理 ${formatTokens(tk)} tokens`
})

// ===== reasoning 自动滚动 =====
const reasoningEl = ref<HTMLPreElement | null>(null)
const autoFollow = ref(true)

function onReasoningScroll() {
  const el = reasoningEl.value
  if (!el) return
  // 距底部 < 32px 视为"贴底"，否则用户已经向上滚——暂停跟随
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  autoFollow.value = nearBottom
}

function resumeAutoFollow() {
  autoFollow.value = true
  scrollToBottom()
}

function scrollToBottom() {
  const el = reasoningEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

watch(reasoningText, async () => {
  if (!autoFollow.value || reasoningCollapsed.value) return
  await nextTick()
  scrollToBottom()
})
</script>

<style scoped>
.thinking-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 16px 0;
}
.meta-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 8px 12px;
  background: var(--color-surface-elevated, #1e2028);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--color-text-muted);
}
.meta strong { color: var(--color-text); font-weight: 600; }
.error-alert { margin-top: 4px; }
.tool-calls-wrap {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-elevated, #1e2028);
  padding: 4px 12px;
}
.tool-call-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-call-item {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--color-surface, #181a20);
}
.tool-call-item.is-error {
  border-color: #c0392b;
  background: rgba(192, 57, 43, 0.08);
}
.tool-call-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.tool-call-index {
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.tool-call-name {
  font-weight: 600;
  color: var(--color-text);
}
.tool-call-status { margin-left: 2px; }
.tool-call-duration {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: 12px;
}
.tool-call-args {
  margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--color-text-muted);
  word-break: break-all;
}
.tool-call-error {
  margin-top: 4px;
  font-size: 12px;
  color: #ff7875;
}
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 16px;
}
@media (max-width: 960px) {
  .split { grid-template-columns: 1fr; }
}
.col {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-surface-elevated, #1e2028);
  display: flex;
  flex-direction: column;
  min-height: 200px;
}
.col-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  user-select: none;
}
.col-header.static { cursor: default; }
.col-header .title { font-size: 13px; font-weight: 600; }
.col-header .summary {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-left: auto;
}
.col-header :deep(.n-button) { margin-left: auto; }
.col-header .summary + :deep(.n-button) { margin-left: 8px; }
.reasoning-wrap { position: relative; }
.auto-follow-hint {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 1;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--color-primary, #2563eb);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.2);
}
.reasoning {
  margin: 0;
  padding: 12px;
  height: 360px;
  max-height: 60vh;
  overflow: auto;
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}
.article-wrap {
  padding: 12px;
  max-height: 60vh;
  overflow: auto;
}
</style>
