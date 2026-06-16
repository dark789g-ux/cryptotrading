/**
 * UsStocksTabsContainer unit test (spec 04 §1).
 *
 *  - switching subTab to 'index' calls indexPanelRef.resize() (resize orchestration).
 *
 * Child panels (UsStocksPanel, UsIndexPanel) are stubbed; the UsIndexPanel stub
 * exposes a resize spy so we can assert the ref forwarding.
 */
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

import UsStocksTabsContainer from '../UsStocksTabsContainer.vue'

const resizeSpy = vi.fn()

const UsStocksPanelStub = defineComponent({
  name: 'UsStocksPanel',
  setup: () => () => h('div', { class: 'stocks-stub' }),
})

const UsIndexPanelStub = defineComponent({
  name: 'UsIndexPanel',
  setup(_, { expose }) {
    expose({ resize: resizeSpy })
    return () => h('div', { class: 'index-stub' })
  },
})

describe('UsStocksTabsContainer resize orchestration', () => {
  it('switching subTab to index calls indexPanelRef.resize()', async () => {
    resizeSpy.mockReset()

    const wrapper = mount(UsStocksTabsContainer, {
      global: {
        stubs: {
          UsStocksPanel: UsStocksPanelStub,
          UsIndexPanel: UsIndexPanelStub,
        },
      },
    })

    // default subTab is 'stocks' -> no resize yet
    expect(resizeSpy).not.toHaveBeenCalled()

    // flip to index pane; watch(subTab) -> nextTick -> resize
    ;(wrapper.vm as unknown as { subTab: 'stocks' | 'index' }).subTab = 'index'
    await nextTick()
    await nextTick()

    expect(resizeSpy).toHaveBeenCalledTimes(1)
  })
})
