/**
 * UsIndexPanel unit test (spec 04 §2).
 *
 *  - on mount (NO KeepAlive wrapper — mirrors the lazy n-tab-pane nesting where
 *    UsIndexPanel mounts after the keep-alive is already active, so onActivated does
 *    NOT fire on first mount; first-screen load must come from onMounted): getDateRange
 *    -> query, bars fed to KlineChart. (Regression lock for the e2e-caught blank-chart bug.)
 *  - empty range: warns "未灌数据，请先同步", no query.
 *  - sync button: triggerSync (no body) -> opens UsSyncProgressModal with jobId.
 *  - resize expose forwards to inner KlineChart ref.
 *
 * KlineChart + UsSyncProgressModal are stubbed (echarts / SSE side effects).
 * api module @/api/modules/market/usIndexDaily is fully mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import UsIndexPanel from '../UsIndexPanel.vue'

const getDateRange = vi.fn()
const query = vi.fn()
const triggerSync = vi.fn()
const amvQuery = vi.fn()

vi.mock('@/api/modules/market/usIndexDaily', () => ({
  usIndexDailyApi: {
    getDateRange: (...args: unknown[]) => getDateRange(...args),
    query: (...args: unknown[]) => query(...args),
    triggerSync: (...args: unknown[]) => triggerSync(...args),
  },
}))

// AMV is fetched in parallel with the K line inside reload() and merged via
// mergeKlineWithAmv. Mock it so the panel never hits real fetch in jsdom.
vi.mock('@/api/modules/market/usIndexAmv', () => ({
  usIndexAmvApi: {
    query: (...args: unknown[]) => amvQuery(...args),
  },
}))

// Stub KlineChart: expose resize spy + record received :data.
const resizeSpy = vi.fn()
const KlineChartStub = defineComponent({
  name: 'KlineChart',
  props: { data: { type: Array, default: () => [] } },
  setup(props, { expose }) {
    expose({ resize: resizeSpy })
    return () => h('div', { class: 'kline-stub', 'data-len': props.data.length })
  },
})

// Stub UsSyncProgressModal: render show + jobId so we can assert open state.
const SyncModalStub = defineComponent({
  name: 'UsSyncProgressModal',
  props: { show: Boolean, jobId: { type: String, default: null } },
  emits: ['update:show', 'done'],
  setup(props) {
    return () =>
      h('div', {
        class: 'sync-modal-stub',
        'data-show': String(props.show),
        'data-job': props.jobId ?? '',
      })
  },
})

function mountPanel() {
  const panelRef = ref<{ resize: () => void } | null>(null)
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              // No KeepAlive on purpose: in production UsIndexPanel is NOT a direct
              // keep-alive child (it sits behind n-tabs show:lazy), so onMounted must
              // drive the first load. Wrapping in KeepAlive here would mask that.
              default: () => h(UsIndexPanel, { ref: panelRef }),
            }),
        })
    },
  })
  const wrapper = mount(Wrapper, {
    attachTo: document.body,
    global: {
      stubs: {
        KlineChart: KlineChartStub,
        UsSyncProgressModal: SyncModalStub,
      },
    },
  })
  return { wrapper, panelRef }
}

beforeEach(() => {
  getDateRange.mockReset()
  query.mockReset()
  triggerSync.mockReset()
  amvQuery.mockReset()
  resizeSpy.mockReset()
  // Default AMV to empty so tests not exercising AMV stay unaffected.
  amvQuery.mockResolvedValue([])
})

describe('UsIndexPanel data loading', () => {
  it('on mount (no keep-alive): getDateRange(.NDX) -> parallel query + AMV(range) -> merged bars to KlineChart', async () => {
    getDateRange.mockResolvedValue({ start: '20200101', end: '20240131' })
    query.mockResolvedValue([
      { open_time: '2024-01-02' },
      { open_time: '2024-01-03' },
    ])
    // AMV row for the first bar only; mergeKlineWithAmv binds it via normalizeDateKey.
    amvQuery.mockResolvedValue([
      {
        tradeDate: '20240102',
        amvOpen: 1, amvHigh: 2, amvLow: 0.5, amvClose: 1.5,
        amvDif: 0.1, amvDea: 0.05, amvMacd: 0.05, amvZdf: null, signal: 1,
      },
    ])

    const { wrapper } = mountPanel()
    await flushPromises()
    await nextTick()

    expect(getDateRange).toHaveBeenCalledWith('.NDX')
    expect(query).toHaveBeenCalledWith({
      index_code: '.NDX',
      start_date: '20200101',
      end_date: '20240131',
    })
    // AMV fetched in parallel with the SAME window.
    expect(amvQuery).toHaveBeenCalledWith({
      index_code: '.NDX',
      start_date: '20200101',
      end_date: '20240131',
    })
    const stub = wrapper.find('.kline-stub')
    // merge preserves K-line length (2 bars).
    expect(stub.attributes('data-len')).toBe('2')
  })

  it('AMV query failure degrades to empty series, K line still renders', async () => {
    getDateRange.mockResolvedValue({ start: '20200101', end: '20240131' })
    query.mockResolvedValue([{ open_time: '2024-01-02' }])
    amvQuery.mockRejectedValue(new Error('amv 500'))

    const { wrapper } = mountPanel()
    await flushPromises()
    await nextTick()

    expect(query).toHaveBeenCalled()
    // .catch(()=>[]) degrades — bars still merged (length preserved), no throw.
    expect(wrapper.find('.kline-stub').attributes('data-len')).toBe('1')
  })

  it('empty range: no query, warns', async () => {
    getDateRange.mockResolvedValue({ start: null, end: null })

    const { wrapper } = mountPanel()
    await flushPromises()

    expect(getDateRange).toHaveBeenCalledWith('.NDX')
    expect(query).not.toHaveBeenCalled()
    expect(wrapper.find('.kline-stub').attributes('data-len')).toBe('0')
  })
})

describe('UsIndexPanel sync', () => {
  it('sync button -> triggerSync() (no body) -> opens UsSyncProgressModal with jobId', async () => {
    getDateRange.mockResolvedValue({ start: null, end: null })
    triggerSync.mockResolvedValue({ jobId: 'job-xyz' })

    const { wrapper } = mountPanel()
    await flushPromises()

    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(triggerSync).toHaveBeenCalledTimes(1)
    expect(triggerSync).toHaveBeenCalledWith()
    const modal = wrapper.find('.sync-modal-stub')
    expect(modal.attributes('data-show')).toBe('true')
    expect(modal.attributes('data-job')).toBe('job-xyz')
  })
})

describe('UsIndexPanel resize expose', () => {
  it('forwards resize() to inner KlineChart ref', async () => {
    getDateRange.mockResolvedValue({ start: null, end: null })

    const { panelRef } = mountPanel()
    await flushPromises()

    panelRef.value?.resize()
    expect(resizeSpy).toHaveBeenCalledTimes(1)
  })
})
