/**
 * ASharesTabsContainer 回归测试：跨 tab「成分股」过滤。
 *
 * 真 bug：「股票」与「A 股指数」两个 n-tab-pane 用默认 display-directive='if'，
 * 用户停在「A 股指数」子 tab 时股票 pane 被 v-if 卸载 → stocksPanelRef 为 null →
 * 点「成分股」事件链虽全程触发，但 handleSwitchToStocks 读不到面板实例，过滤不生效。
 *
 * 关键修复：把 display-directive='show' 写在「股票」<n-tab-pane> 上（不是 <n-tabs>，
 * 后者无此 prop、纯透传无效），使股票 pane 常驻挂载（v-show）。
 *
 * 本测试用真实 naive-ui n-tabs 渲染、stub 两个重量级子面板，验证：
 *  1) 切到「A 股指数」tab 后，股票 pane 仍挂载在 DOM（旧行为会被卸载）。
 *  2) 此时触发 switch-to-stocks → 股票面板 applyIndexFilter 被调用、tab 切回 stocks。
 */
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ASharesTabsContainer from './ASharesTabsContainer.vue'

const applyIndexFilter = vi.fn().mockResolvedValue(undefined)

const StocksStub = defineComponent({
  name: 'ASharesPanel',
  setup(_, { expose }) {
    expose({ applyIndexFilter })
    return () => h('div', { class: 'stocks-stub' }, 'stocks-panel')
  },
})

const IndexStub = defineComponent({
  name: 'ASharesIndexPanel',
  emits: ['switch-to-stocks'],
  setup(_, { expose, emit }) {
    expose({ resize: vi.fn() })
    return () =>
      h(
        'button',
        {
          class: 'jump-members',
          onClick: () =>
            emit('switch-to-stocks', {
              tsCode: 'CUST.7ade3e40.U',
              name: '啊吊袜带',
              category: 'custom',
              customIndexId: '53e197af-838f-4b50-88dc-2aca2040ee0d',
            }),
        },
        'jump',
      )
  },
})

function mountContainer() {
  return mount(ASharesTabsContainer, {
    global: {
      stubs: { ASharesPanel: StocksStub, ASharesIndexPanel: IndexStub },
    },
  })
}

describe('ASharesTabsContainer 成分股跨 tab 过滤', () => {
  it('停在「A 股指数」tab 时股票 pane 仍挂载，switch-to-stocks 能下发过滤', async () => {
    applyIndexFilter.mockClear()
    const w = mountContainer()

    // 默认 subTab=stocks：股票 pane 挂载
    expect(w.find('.stocks-stub').exists()).toBe(true)

    // 切到「A 股指数」tab（v-model:value 透传到 subTab）
    const tabs = w.findComponent({ name: 'Tabs' })
    tabs.vm.$emit('update:value', 'index')
    await nextTick()

    // 核心回归：股票 pane 不因切到 index 而被卸载（display-directive='show' → v-show）
    expect(w.find('.stocks-stub').exists()).toBe(true)
    // index pane 此时已挂载，按钮可点
    const jump = w.find('.jump-members')
    expect(jump.exists()).toBe(true)

    // 触发「成分股」事件链
    await jump.trigger('click')
    await nextTick()

    // 股票面板实例可达 → 过滤被下发；tab 切回 stocks
    expect(applyIndexFilter).toHaveBeenCalledTimes(1)
    expect(applyIndexFilter).toHaveBeenCalledWith(
      'CUST.7ade3e40.U',
      '啊吊袜带',
      { category: 'custom', customIndexId: '53e197af-838f-4b50-88dc-2aca2040ee0d' },
    )
  })
})
