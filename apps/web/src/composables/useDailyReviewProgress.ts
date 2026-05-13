import { ref, onUnmounted } from 'vue'
import type {
  ProgressEvent,
  Stage,
  StageTiming,
  TokenUsage,
  ToolCallEntry,
} from '@/types/daily-review'

// 每个 stage 对应的进度百分比（fallback：服务端会在 stage 事件里带 percent）
const STAGE_DEFAULT_PERCENT: Record<Stage, number> = {
  validate: 1,
  fetch: 10,
  build: 30,
  investigate: 40,
  reasoning: 55,
  writing: 75,
  finalize: 95,
}

/**
 * 订阅 daily-review SSE 流，提供：
 * - 兼容旧 ProgressBar 的 stage / percent / error / done
 * - 思考面板需要的 reasoning / articleStream / stageTimings / tokenUsage / llmModel
 *
 * reasoning / articleStream 使用 requestAnimationFrame 批量合并 delta 写入，
 * 避免每个 token 都触发响应式更新导致高频抖动。
 */
export function useDailyReviewProgress(tradeDate: string) {
  const stage = ref<Stage>('validate')
  const percent = ref(0)
  const reasoning = ref('')
  const articleStream = ref('')
  const stageTimings = ref<StageTiming[]>([])
  const tokenUsage = ref<TokenUsage | null>(null)
  const llmModel = ref<string | null>(null)
  const toolCalls = ref<ToolCallEntry[]>([])
  const error = ref<string | null>(null)
  const done = ref(false)

  // rAF 批量合并：高频 delta 先攒进 pending，下一帧统一 += 到 ref，
  // 一帧最多触发一次响应式更新，DOM 也只重排一次。
  let pendingReasoning = ''
  let pendingArticle = ''
  let rafId: number | null = null

  const flush = () => {
    if (pendingReasoning) {
      reasoning.value += pendingReasoning
      pendingReasoning = ''
    }
    if (pendingArticle) {
      articleStream.value += pendingArticle
      pendingArticle = ''
    }
    rafId = null
  }

  const schedule = () => {
    if (rafId != null) return
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(flush)
    } else {
      // jsdom / node 环境兜底：用 microtask 同步合并
      rafId = (setTimeout(flush, 0) as unknown) as number
    }
  }

  function handle(e: ProgressEvent) {
    switch (e.type) {
      case 'stage':
        stage.value = e.stage
        percent.value = e.percent
        break
      case 'reasoning_delta':
        pendingReasoning += e.text
        schedule()
        break
      case 'content_delta':
        pendingArticle += e.text
        schedule()
        // writing 阶段时让 percent 自然推进（服务端不发 stage 时的兜底）
        if (stage.value !== 'writing') {
          stage.value = 'writing'
          percent.value = Math.max(percent.value, STAGE_DEFAULT_PERCENT.writing)
        }
        break
      case 'usage':
        tokenUsage.value = e.tokens
        break
      case 'tool_call':
        toolCalls.value.push({
          callIndex: e.callIndex,
          toolName: e.toolName,
          args: e.args,
          durationMs: e.durationMs,
          error: e.error,
          ts: e.ts,
        })
        break
      case 'stage_done':
        stageTimings.value.push({
          stage: e.stage,
          // 由 durationMs 反推 startedAt：UTC 墙钟字符串。
          // 这是前端展示用，不会落库；后端会单独持久化精确版本。
          startedAt: new Date(e.ts - e.durationMs).toISOString(),
          durationMs: e.durationMs,
        })
        break
      case 'completed':
        // 完成时把残留 delta 刷出去，避免最后一帧丢字
        flush()
        percent.value = 100
        done.value = true
        es?.close()
        break
      case 'failed':
        flush()
        error.value = e.error
        done.value = true
        es?.close()
        break
    }
  }

  // 仅在浏览器环境创建 EventSource；测试中由调用方注入 mock
  let es: EventSource | null = null
  if (typeof EventSource !== 'undefined') {
    es = new EventSource(`/api/daily-review/${tradeDate}/stream`, {
      withCredentials: true,
    })
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as ProgressEvent
        handle(data)
      } catch {
        // 单条事件解析失败不影响后续；保持连接
      }
    }
    es.onerror = () => {
      // EventSource 默认会自动重连；只有已经 done 才需要兜底关闭
      if (done.value) {
        es?.close()
        return
      }
      // 真正断开（readyState=CLOSED）才视为失败
      if (es?.readyState === 2) {
        error.value = error.value ?? '连接断开'
        done.value = true
        es.close()
      }
    }
  }

  onUnmounted(() => {
    if (rafId != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
      else clearTimeout(rafId as unknown as ReturnType<typeof setTimeout>)
      rafId = null
    }
    es?.close()
  })

  return {
    stage,
    percent,
    reasoning,
    articleStream,
    stageTimings,
    tokenUsage,
    llmModel,
    toolCalls,
    error,
    done,
    // 测试用：注入事件、强制刷新；运行时无副作用
    __handle: handle,
    __flush: flush,
  }
}
