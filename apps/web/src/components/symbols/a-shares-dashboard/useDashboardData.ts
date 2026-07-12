import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { moneyFlowApi, type MoneyFlowIndustryRow, type MoneyFlowSectorRow } from '@/api/modules/market/moneyFlow'
import type { BubbleInputNode } from './bubbleLayout'

export type DashboardDimension = 'concept' | 'sw1' | 'sw2' | 'sw3' | 'thsIndustry'

/**
 * A 股资金流向看板数据层 composable。
 * 按维度拉取板块/行业资金流数据，转换为 BubbleInputNode[]，
 * 并汇总 KPI（净流入/净流出/净额）。
 */
export function useDashboardData() {
  const dimension = ref<DashboardDimension>('concept')
  const tradeDate = ref<string | null>(null)
  const nodes = ref<BubbleInputNode[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * 气泡云每侧显示上限：null = 全部，正数 = 正/负侧各取头部 N 个。
   * 单边行情下纯 |value| 全局排序会掏空某一侧（实测概念 Top30 = 0 正/30 负），
   * 看板失去流入 vs 流出对比意义，故按侧截断。
   * 默认 10 —— 头部集中度高（每侧前 10 覆盖该侧约 1/4 资金额），合计最多
   * 20 球，视觉清爽利于快速捕捉行情。用户可切 20/30/全部看更多。
   */
  const topN = ref<number | null>(10)

  // ----- KPI（基于全量 nodes 求和，不受 topN 截断影响）-----
  const inflowTotal = computed<number>(() =>
    nodes.value.filter(n => n.value > 0).reduce((s, n) => s + n.value, 0),
  )
  const outflowTotal = computed<number>(() =>
    Math.abs(nodes.value.filter(n => n.value < 0).reduce((s, n) => s + n.value, 0)),
  )
  const netTotal = computed<number>(() =>
    nodes.value.reduce((s, n) => s + n.value, 0),
  )

  // ----- 渲染用节点（正负双侧各取 Top N，仅喂给气泡图）-----
  // 单边行情下纯 |value| 全局 Top-N 会掏空某一侧（实测概念 Top30 = 0 正/30 负），
  // 看板失去「流入 vs 流出」对比意义。故按正/负各取头部 topN 个，
  // 保证两侧都有主力球（除非当日该侧确无数据）。
  // 不污染原数组（拷贝排序）；侧内排序与 bubbleLayout.ts 一致（大球居中）。
  const displayNodes = computed<BubbleInputNode[]>(() => {
    if (topN.value === null) return nodes.value
    const limit = topN.value
    const positives = nodes.value
      .filter(n => n.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)
    const negatives = nodes.value
      .filter(n => n.value < 0)
      .sort((a, b) => a.value - b.value) // 负值：越小越前（净流出最大者居首）
      .slice(0, limit)
    return [...positives, ...negatives]
  })

  // 全量板块总数（toolbar 右侧「共 N 个」提示用，让用户知晓长尾被省略）
  const totalNodesCount = computed(() => nodes.value.length)

  // 竞态守卫：每次 fetchData 递增，异步返回时校验是否仍是最新请求，
  // 过期的直接丢弃，避免快速切换维度时旧请求覆盖新数据。
  let requestId = 0

  // ----- 数据拉取 -----
  async function fetchData() {
    const currentId = ++requestId
    loading.value = true
    error.value = null
    nodes.value = []

    try {
      // 1. 获取最新交易日
      const latest = await moneyFlowApi.getLatestDates()
      if (currentId !== requestId) return // 已被后续切换取代

      // 按维度取对应日期
      let date: string | null = null
      switch (dimension.value) {
        case 'concept':
          date = latest.sector
          break
        case 'sw1':
        case 'sw2':
        case 'sw3':
          date = latest.swIndustry
          break
        case 'thsIndustry':
          date = latest.thsIndustry
          break
      }

      if (!date) {
        error.value = '该维度暂无最新交易日数据'
        tradeDate.value = null
        return
      }

      tradeDate.value = date

      // 2. 按维度拉取数据（统一成一个 fetcher，单一赋值点便于竞态守卫）
      const dim = dimension.value
      const swLevel = dim === 'sw1' ? 1 : dim === 'sw2' ? 2 : dim === 'sw3' ? 3 : undefined

      const rawRows =
        dim === 'concept'
          ? await moneyFlowApi.querySectors({ trade_date: date })
          : dim === 'thsIndustry'
            ? await moneyFlowApi.queryThsIndustries({ trade_date: date })
            : await moneyFlowApi.queryIndustries({ trade_date: date, sw_level: swLevel })

      if (currentId !== requestId) return // 异步等待期间维度已切换，丢弃过期结果

      // sector 与 industry 行字段名不同，按维度取 name 字段；
      // value===0 的行（含 netAmount 为 null 经 Number() 兜底）保留无害：
      // 布局层会丢弃 0 值节点，KPI 求和 0 不影响结果。
      nodes.value = rawRows
        .map(r => {
          const name = dim === 'concept' ? r.sector : r.industry
          return {
            id: r.tsCode,
            name,
            value: Number(r.netAmount) || 0,
            pctChange: r.pctChange != null ? Number(r.pctChange) : null,
          }
        })
        .filter(n => n.name)
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '数据加载失败，请稍后重试'
      nodes.value = []
    } finally {
      loading.value = false
    }
  }

  function setDimension(dim: DashboardDimension) {
    dimension.value = dim
  }

  async function reload() {
    await fetchData()
  }

  // dimension 变化时自动重新加载
  watch(dimension, () => {
    void reload()
  })

  return {
    dimension: dimension as Ref<DashboardDimension>,
    setDimension,
    tradeDate,
    nodes,
    loading,
    error,
    inflowTotal,
    outflowTotal,
    netTotal,
    reload,
    // ---- 气泡云 Top-N 截断控制 ----
    topN: topN as Ref<number | null>,
    displayNodes: displayNodes as ComputedRef<BubbleInputNode[]>,
    totalNodesCount,
  }
}
