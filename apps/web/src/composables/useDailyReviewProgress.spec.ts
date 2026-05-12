import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useDailyReviewProgress } from './useDailyReviewProgress'
import type { ProgressEvent } from '@/types/daily-review'

// 简化 EventSource mock：只需要 onmessage / onerror / close，不真连
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = 1
  closed = false
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  emit(data: ProgressEvent) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

// 把 composable 挂在一个组件里以触发 setup 上下文（onUnmounted 可用）
function mountComposable() {
  const captured: { value?: ReturnType<typeof useDailyReviewProgress> } = {}
  const Comp = defineComponent({
    setup() {
      captured.value = useDailyReviewProgress('20260512')
      return () => h('div')
    },
  })
  const wrapper = mount(Comp)
  return { wrapper, api: captured.value! }
}

describe('useDailyReviewProgress', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    ;(globalThis as any).EventSource = MockEventSource
    // jsdom 默认有 requestAnimationFrame，但走 setTimeout 路径更可控
    vi.useFakeTimers()
    // 故意把 rAF 替成基于 fake timer 的 setTimeout，便于推进
    ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0) as unknown as number
    ;(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as any).EventSource
  })

  it('多次 reasoning_delta 累积到 reasoning ref', async () => {
    const { wrapper, api } = mountComposable()
    const es = MockEventSource.instances[0]
    es.emit({ type: 'reasoning_delta', text: 'Hello ', ts: 1 })
    es.emit({ type: 'reasoning_delta', text: 'world', ts: 2 })
    es.emit({ type: 'reasoning_delta', text: '!', ts: 3 })
    // 推进 rAF（fake setTimeout）让 pending flush
    vi.runAllTimers()
    await nextTick()
    expect(api.reasoning.value).toBe('Hello world!')
    wrapper.unmount()
  })

  it('stage_done 累计到 stageTimings，字段正确', async () => {
    const { wrapper, api } = mountComposable()
    const es = MockEventSource.instances[0]
    es.emit({ type: 'stage_done', stage: 'validate', durationMs: 1200, ts: 10_000 })
    es.emit({ type: 'stage_done', stage: 'fetch', durationMs: 4500, ts: 14_500 })
    await nextTick()
    expect(api.stageTimings.value).toHaveLength(2)
    expect(api.stageTimings.value[0]).toMatchObject({
      stage: 'validate',
      durationMs: 1200,
    })
    expect(api.stageTimings.value[0].startedAt).toBe(
      new Date(10_000 - 1200).toISOString(),
    )
    expect(api.stageTimings.value[1].stage).toBe('fetch')
    wrapper.unmount()
  })

  it('content_delta 累积到 articleStream，并自动切到 writing 阶段', async () => {
    const { wrapper, api } = mountComposable()
    const es = MockEventSource.instances[0]
    es.emit({ type: 'content_delta', text: '# Title\n', ts: 1 })
    es.emit({ type: 'content_delta', text: 'body', ts: 2 })
    vi.runAllTimers()
    await nextTick()
    expect(api.articleStream.value).toBe('# Title\nbody')
    expect(api.stage.value).toBe('writing')
    wrapper.unmount()
  })

  it('failed 事件设置 error / done 并关闭 EventSource', async () => {
    const { wrapper, api } = mountComposable()
    const es = MockEventSource.instances[0]
    es.emit({ type: 'failed', error: 'DeepSeek 超时', ts: 99 })
    await nextTick()
    expect(api.error.value).toBe('DeepSeek 超时')
    expect(api.done.value).toBe(true)
    expect(es.closed).toBe(true)
    wrapper.unmount()
  })

  it('completed 事件设置 done=true、percent=100、关闭连接', async () => {
    const { wrapper, api } = mountComposable()
    const es = MockEventSource.instances[0]
    es.emit({ type: 'completed', ts: 100 })
    await nextTick()
    expect(api.done.value).toBe(true)
    expect(api.percent.value).toBe(100)
    expect(es.closed).toBe(true)
    wrapper.unmount()
  })

  it('usage 事件填充 tokenUsage', async () => {
    const { wrapper, api } = mountComposable()
    const es = MockEventSource.instances[0]
    es.emit({
      type: 'usage',
      tokens: { prompt: 1000, completion: 200, reasoning: 500, total: 1700 },
      ts: 5,
    })
    await nextTick()
    expect(api.tokenUsage.value).toEqual({
      prompt: 1000,
      completion: 200,
      reasoning: 500,
      total: 1700,
    })
    wrapper.unmount()
  })
})
