import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ReviewThinkingPanel from './ReviewThinkingPanel.vue'
import { useAuth } from '@/composables/hooks/useAuth'
import type { StageTiming, TokenUsage, ToolCallEntry } from '@/types/daily-review'

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

const REPLAY_TOOL_CALLS: ToolCallEntry[] = [
  {
    callIndex: 1,
    toolName: 'search_news',
    args: { query: '北方稀土涨停 5月12日', recencyDays: 3 },
    durationMs: 1234,
    ts: 1715472000000,
  },
  {
    callIndex: 2,
    toolName: 'lookup_concept',
    args: { conceptName: '稀土永磁' },
    durationMs: 567,
    ts: 1715472001234,
  },
  {
    callIndex: 3,
    toolName: 'fetch_top_list',
    args: { mode: 'daily', tradeDate: '20260512' },
    durationMs: 2100,
    error: 'Tushare 502',
    ts: 1715472002000,
  },
]

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

  it('admin 用户：传入 tool_call replay 数据后，工具列表可展开渲染', async () => {
    setUser('admin')
    const wrapper = mount(ReviewThinkingPanel, {
      props: {
        tradeDate: '20260512',
        mode: 'replay',
        replayData: {
          reasoningContent: 'r',
          articleMd: '# a',
          stageTimings: REPLAY_TIMINGS,
          tokenUsage: REPLAY_TOKENS,
          llmModel: 'deepseek-reasoner',
          toolCalls: REPLAY_TOOL_CALLS,
          status: 'completed',
          errorMessage: null,
        },
      },
    })
    const section = wrapper.find('[data-testid="tool-calls-section"]')
    expect(section.exists()).toBe(true)
    // 折叠区标题反映条数（默认折叠也可见标题）
    expect(wrapper.text()).toContain('AI 工具调用（3 次）')
    // 默认折叠：内部条目不渲染
    expect(wrapper.text()).not.toContain('search_news')

    // 点击折叠项标题展开 —— n-collapse 通过点击 header 切换
    const header = section.find('.n-collapse-item__header-main')
    expect(header.exists()).toBe(true)
    await header.trigger('click')
    await flushPromises()
    const text = wrapper.text()
    // 工具名与失败信息都应出现
    expect(text).toContain('search_news')
    expect(text).toContain('lookup_concept')
    expect(text).toContain('fetch_top_list')
    expect(text).toContain('Tushare 502')
  })

  it('非 admin 用户：即使有 toolCalls 也不渲染工具调用列表', () => {
    setUser('user')
    const wrapper = mount(ReviewThinkingPanel, {
      props: {
        tradeDate: '20260512',
        mode: 'replay',
        replayData: {
          reasoningContent: 'r',
          articleMd: '# a',
          stageTimings: REPLAY_TIMINGS,
          tokenUsage: REPLAY_TOKENS,
          llmModel: 'deepseek-reasoner',
          toolCalls: REPLAY_TOOL_CALLS,
          status: 'completed',
          errorMessage: null,
        },
      },
    })
    expect(wrapper.find('[data-testid="tool-calls-section"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('AI 工具调用')
    expect(wrapper.text()).not.toContain('search_news')
  })

  it('admin 用户：当 toolCalls 为空时不渲染工具调用区', () => {
    setUser('admin')
    const wrapper = mount(ReviewThinkingPanel, {
      props: {
        tradeDate: '20260512',
        mode: 'replay',
        replayData: {
          reasoningContent: 'r',
          articleMd: '# a',
          stageTimings: REPLAY_TIMINGS,
          tokenUsage: REPLAY_TOKENS,
          llmModel: 'deepseek-reasoner',
          toolCalls: [],
          status: 'completed',
          errorMessage: null,
        },
      },
    })
    expect(wrapper.find('[data-testid="tool-calls-section"]').exists()).toBe(false)
  })

  it('阶段时间线渲染 investigate 阶段文案', () => {
    setUser('admin')
    const wrapper = mount(ReviewThinkingPanel, {
      props: {
        tradeDate: '20260512',
        mode: 'replay',
        replayData: {
          reasoningContent: 'r',
          articleMd: '# a',
          stageTimings: [
            ...REPLAY_TIMINGS,
            { stage: 'investigate', startedAt: '2026-05-12T00:00:43.000Z', durationMs: 12_000 },
          ],
          tokenUsage: REPLAY_TOKENS,
          llmModel: 'deepseek-reasoner',
          status: 'completed',
          errorMessage: null,
        },
      },
    })
    const text = wrapper.text()
    expect(text).toContain('AI 追查证据')
    // investigate 阶段耗时显示
    expect(text).toContain('12s')
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
