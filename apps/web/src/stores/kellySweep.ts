/**
 * Kelly Sweep Pinia store
 *
 * 管理：
 * - 当前配置（config）
 * - 当前 jobId（进度走 ProgressLine.vue 的 SSE，不另起轮询）
 * - 当前 job 结果数据（summary + scatter + topk）
 * - 历史列表（历史下拉）
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  kellySweepApi,
  type SweepParams,
  type SweepGroup,
  type KellySweepSummary,
  type KellyScatterPoint,
  type KellyTopkRow,
  type KellyHistoryPage,
  type KellyRowDetail,
} from '@/api/modules/quant/kellySweep'

/** 默认配置（SweepParams 完整结构，供表单初始化） */
export const DEFAULT_SWEEP_PARAMS: SweepParams = {
  base_trigger: { field: 'kdj_j', op: 'lt', value: 0 },
  universe: 'all',
  train_range: ['20230101', '20241231'],
  valid_range: ['20250101', '20260101'],
  max_window: 20,
  max_entry_filters: 1,
  min_samples: 300,
  bootstrap_iters: 1000,
  rs_lookback: 5,
  top_k: 30,
  same_day_rule: 'sl_first',
  rs_benchmark: ['hs300', 'zz500'],
  exit_families: ['fixed_n', 'tp_sl', 'trailing', 'atr_stop'],
}

export const useKellySweepStore = defineStore('kellySweep', () => {
  // --- 当前配置 ---
  const config = ref<SweepParams>({ ...DEFAULT_SWEEP_PARAMS, base_trigger: { ...DEFAULT_SWEEP_PARAMS.base_trigger } })

  // --- 当前 job ---
  const currentJobId = ref<string | null>(null)

  // --- 当前结果 ---
  const summary = ref<KellySweepSummary | null>(null)
  const scatterWithRs = ref<KellyScatterPoint[]>([])
  const scatterNoRs = ref<KellyScatterPoint[]>([])
  const topkWithRs = ref<KellyTopkRow[]>([])
  const topkNoRs = ref<KellyTopkRow[]>([])
  const topkTotalWithRs = ref(0)
  const topkTotalNoRs = ref(0)

  // --- 历史列表 ---
  const historyPage = ref<KellyHistoryPage | null>(null)
  const historyLoading = ref(false)

  // --- 加载状态 ---
  const summaryLoading = ref(false)
  const summaryError = ref<string | null>(null)
  const scatterLoading = ref(false)
  const scatterError = ref<string | null>(null)
  const topkLoading = ref(false)
  const topkError = ref<string | null>(null)
  const historyError = ref<string | null>(null)

  /** 设置当前 jobId，清空旧结果 */
  function setCurrentJob(jobId: string | null) {
    currentJobId.value = jobId
    summary.value = null
    scatterWithRs.value = []
    scatterNoRs.value = []
    topkWithRs.value = []
    topkNoRs.value = []
    topkTotalWithRs.value = 0
    topkTotalNoRs.value = 0
    summaryError.value = null
  }

  /** 加载结果摘要 */
  async function loadSummary(jobId: string) {
    summaryLoading.value = true
    summaryError.value = null
    try {
      summary.value = await kellySweepApi.getSummary(jobId)
    } catch (e) {
      summaryError.value = e instanceof Error ? e.message : '加载摘要失败'
    } finally {
      summaryLoading.value = false
    }
  }

  /** 加载散点数据（两组） */
  async function loadScatter(jobId: string) {
    scatterLoading.value = true
    scatterError.value = null
    try {
      const [withRs, noRs] = await Promise.all([
        kellySweepApi.getScatter(jobId, 'with_rs'),
        kellySweepApi.getScatter(jobId, 'no_rs'),
      ])
      scatterWithRs.value = withRs
      scatterNoRs.value = noRs
    } catch (e) {
      console.warn('[KellySweepStore] loadScatter failed', e)
      scatterError.value = e instanceof Error ? e.message : '加载散点失败'
    } finally {
      scatterLoading.value = false
    }
  }

  /** 加载 top-K 排行（两组，第一页） */
  async function loadTopk(jobId: string, group?: SweepGroup) {
    topkLoading.value = true
    topkError.value = null
    try {
      if (!group || group === 'with_rs') {
        const res = await kellySweepApi.getTopk(jobId, { group: 'with_rs', page: 1, pageSize: 50 })
        topkWithRs.value = res.rows
        topkTotalWithRs.value = res.total
      }
      if (!group || group === 'no_rs') {
        const res = await kellySweepApi.getTopk(jobId, { group: 'no_rs', page: 1, pageSize: 50 })
        topkNoRs.value = res.rows
        topkTotalNoRs.value = res.total
      }
    } catch (e) {
      console.warn('[KellySweepStore] loadTopk failed', e)
      topkError.value = e instanceof Error ? e.message : '加载 top-K 失败'
    } finally {
      topkLoading.value = false
    }
  }

  /** 加载结果完整数据（summary + scatter + topk），job 完成后调用 */
  async function loadResults(jobId: string) {
    await loadSummary(jobId)
    await Promise.all([loadScatter(jobId), loadTopk(jobId)])
  }

  /** 获取单行详情（不缓存，直接返回） */
  function getRowDetail(jobId: string, rowId: string): Promise<KellyRowDetail> {
    return kellySweepApi.getRowDetail(jobId, rowId)
  }

  /** 加载历史 job 列表 */
  async function loadHistory(params: { page?: number } = {}) {
    historyLoading.value = true
    historyError.value = null
    try {
      historyPage.value = await kellySweepApi.getHistory(params)
    } catch (e) {
      console.warn('[KellySweepStore] loadHistory failed', e)
      historyError.value = e instanceof Error ? e.message : '加载历史失败'
    } finally {
      historyLoading.value = false
    }
  }

  return {
    config,
    currentJobId,
    summary,
    scatterWithRs,
    scatterNoRs,
    topkWithRs,
    topkNoRs,
    topkTotalWithRs,
    topkTotalNoRs,
    historyPage,
    historyLoading,
    summaryLoading,
    summaryError,
    scatterLoading,
    scatterError,
    topkLoading,
    topkError,
    historyError,
    setCurrentJob,
    loadSummary,
    loadScatter,
    loadTopk,
    loadResults,
    getRowDetail,
    loadHistory,
  }
})
