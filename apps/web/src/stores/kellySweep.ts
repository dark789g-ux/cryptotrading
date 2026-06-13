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
  type BandLockGrid,
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

/**
 * band_lock 候选集默认值工厂（每次返回新对象，避免共享引用被 mutate）。
 *
 * 默认 = 退化成现状（spec 05§3.1 默认候选集 → build_band_lock_grid() == DEFAULT_EXIT_GRID
 * 的 band_lock 3 个 cfg）：max_hold ∈ {null,10,20}，4 新参数取核默认 0.999/0.999/true/true。
 * 用户勾选「波段跟踪止损」出场族时，以此初始化 config.band_lock_grid。
 */
export function makeDefaultBandLockGrid(): BandLockGrid {
  return {
    max_hold_list: [null, 10, 20],
    stop_ratio_list: [0.999],
    floor_ratio_list: [0.999],
    floor_enabled_list: [true],
    ma5_require_down_list: [true],
  }
}

// ── band_lock 网格规模预估（前端单一源，与后端 build_band_lock_grid 同口径） ──────
/** 量化千分位网格（NNNN = Math.round(ratio*1000)，band_lock_scheme.py RATIO_GRID=1000） */
const BAND_LOCK_RATIO_GRID = 1000

/**
 * ratio 量化到千分位（round-half-up；ratio 恒正 → Math.round 与 Python floor(x+0.5) 逐位一致，
 * band_lock_scheme.py:_round_half_up_nnnn）。供编辑器输入归一与网格预估去重共用。
 */
export function quantizeBandLockRatio(r: number): number {
  return Math.round(r * BAND_LOCK_RATIO_GRID) / BAND_LOCK_RATIO_GRID
}

/** 标量保序去重（max_hold / bool 维度） */
function dedupScalar<T>(list: T[]): T[] {
  return Array.from(new Set(list))
}

/** ratio 维度按量化值保序去重，与 Python _dedup_keep_order 同口径 */
function dedupQuantizedRatios(list: number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const r of list) {
    const q = quantizeBandLockRatio(r)
    if (!seen.has(q)) {
      seen.add(q)
      out.push(q)
    }
  }
  return out
}

/**
 * 预估 band_lock 出场族会生成多少个 cfg（纯函数，无副作用）。
 *
 * 纯 TS 复刻后端 build_band_lock_grid（sweep.py）的笛卡尔积 + 坍缩去重：
 *   1. 各候选集先量化去重（ratio 量化千分位，与 Python round-half-up 逐位一致）。
 *   2. 笛卡尔积 max_hold × stop_ratio × floor_enabled × ma5_require_down，每组合再展开 floor_ratio。
 *   3. 坍缩去重：floor_enabled=false 时 floor_ratio 不展开（占位默认 null），
 *      指纹 = (mh, sr, fe, md, fe ? fr : null)（band_lock_scheme + sweep.py）。
 *
 * 任一维度空 → 返回 0（与后端笛卡尔积为空 / build_exit_grid 校验失败一致）。
 *
 * BandLockGridEditor（实时「将生成 N 个」）与 KellySweepConfigForm（组合数预估的出场数）共用，
 * 保证前端预估单一源、与后端 build_band_lock_grid 同口径。
 */
export function estimateBandLockGridSize(grid: BandLockGrid): number {
  const maxHolds = dedupScalar(grid.max_hold_list)
  const stops = dedupQuantizedRatios(grid.stop_ratio_list)
  const floors = dedupQuantizedRatios(grid.floor_ratio_list)
  const floorEnableds = dedupScalar(grid.floor_enabled_list)
  const ma5s = dedupScalar(grid.ma5_require_down_list)

  // 任一维度空 → 后端会因笛卡尔积为空 / build_exit_grid 校验失败而无配置；按 0 计
  if (
    maxHolds.length === 0 || stops.length === 0 || floorEnableds.length === 0 ||
    ma5s.length === 0 || floors.length === 0
  ) {
    return 0
  }

  // 笛卡尔积 + 坍缩去重：指纹 (mh, sr, fe, md, fe ? fr : null)
  const seen = new Set<string>()
  for (const mh of maxHolds) {
    for (const sr of stops) {
      for (const fe of floorEnableds) {
        for (const md of ma5s) {
          const frCandidates = fe ? floors : [null]
          for (const fr of frCandidates) {
            seen.add(JSON.stringify([mh, sr, fe, md, fe ? fr : null]))
          }
        }
      }
    }
  }
  return seen.size
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
    scatterError.value = null
    topkError.value = null
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
