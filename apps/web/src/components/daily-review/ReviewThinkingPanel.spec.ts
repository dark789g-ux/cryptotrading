import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ReviewThinkingPanel from './ReviewThinkingPanel.vue'
import { useAuth } from '@/composables/hooks/useAuth'
import type { StageTiming, TokenUsage } from '@/types/daily-review'

// 用一个最小 EventSource，避免组件在 live 模式下创建真连接
class NoopEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = 1
  constructor(_url: string) {}
  close() { this.readyState = 2 }
}

function setUser(role: 'admin' | 'user' | null) {
  const auth = useAuth()
  if (role == null) {
    // 强制清空
    ;(auth.user as any).value = null
  } else {
    ;(auth.user as any).value = {
      id: 'u1',
      name: 'tester',
      role,
    }
  }
}

const REPLAY_TIMINGS: StageTiming[] = [
  { stage: 'validate', startedAt: '2026-05-12T00:00:00.000Z', durationMs: 1000 },
  { stage: 'fetch', startedAt: '2026-05-12T00:00:01.000Z', durationMs: 4000 },
  { stage: 'reasoning', startedAt: '2026-05-12T00:00:05.000Z', durationMs: 38_000 },
]
const REPLAY_TOKENS: TokenUsage = {
  prompt: 4200, completion: 2400, reasoning: 3100, total: 9700,
}

describe('ReviewThinkingPanel', () => {
  beforeEach(() => {
    ;(globalThis as any).EventSource = NoopEventSource
  })
  afterEach(() => {
    delete (globalThis as any).EventSource
    setUser(null)
  })

  it('admin 在 replay 模式下展示元信息条与思考过程入口', () => {
    setUser('admin')
    const wrapper = mount(ReviewThinkingPanel, {
      props: {
        tradeDate: '20260512',
        mode: 'replay',
        replayData: {
          reasoningContent: 'thinking...',
          articleMd: '# hello',
          stageTimings: REPLAY_TIMINGS,
          tokenUsage: REPLAY_TOKENS,
          llmModel: 'deepseek-reasoner',
          status: 'completed',
          errorMessage: null,
        },
      },
    })
    const text = wrapper.text()
    expect(text).toContain('AI 思考过程')
    expect(text).toContain('deepseek-reasoner')
    // token 元信息
    expect(text).toContain('4.2k')
    expect(text).toContain('3.1k')
  })

  it('非 admin 用户：隐藏 reasoning 与元信息块', () => {
    setUser('user')
    const wrapper = mount(ReviewThinkingPanel, {
      props: {
        tradeDate: '20260512',
        mode: 'replay',
        replayData: {
          reasoningContent: 'secret',
          articleMd: '# hello',
          stageTimings: REPLAY_TIMINGS,
          tokenUsage: REPLAY_TOKENS,
          llmModel: 'deepseek-reasoner',
          status: 'completed',
          errorMessage: null,
        },
      },
    })
    const text = wrapper.text()
    expect(text).not.toContain('AI 思考过程')
    expect(text).not.toContain('deepseek-reasoner')
    expect(text).not.toContain('secret')
    // 但正文还在
    expect(text).toContain('正文预览')
  })

  it('失败状态显示 errorMessage', () => {
    setUser('admin')
    const wrapper = mount(ReviewThinkingPanel, {
      props: {
        tradeDate: '20260512',
        mode: 'replay',
        replayData: {
          reasoningContent: '推理一半挂了',
          articleMd: null,
          stageTimings: REPLAY_TIMINGS.slice(0, 2),
          tokenUsage: null,
          llmModel: 'deepseek-reasoner',
          status: 'failed',
          errorMessage: 'DeepSeek 上游 504',
        },
      },
    })
    expect(wrapper.text()).toContain('DeepSeek 上游 504')
  })

  it('live → replay 模式切换保留 stageTimings 来源切换正确', async () => {
    setUser('admin')
    // 先 live：stageTimings 应来自 composable（空）
    const wrapper = mount(ReviewThinkingPanel, {
      props: { tradeDate: '20260512', mode: 'live' },
    })
    await flushPromises()
    // live 默认还没有 timing 数据：元信息条至少不应崩溃；切到 replay
    await wrapper.setProps({
      mode: 'replay',
      replayData: {
        reasoningContent: 'done',
        articleMd: '# ok',
        stageTimings: REPLAY_TIMINGS,
        tokenUsage: REPLAY_TOKENS,
        llmModel: 'deepseek-reasoner',
        status: 'completed',
        errorMessage: null,
      },
    })
    await flushPromises()
    const text = wrapper.text()
    // 三段 timing 都应渲染对应耗时（1s / 4s / 38s）
    expect(text).toContain('1s')
    expect(text).toContain('4s')
    expect(text).toContain('38s')
  })
})
