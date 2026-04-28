import { reactive, computed, ref, watch } from 'vue'

export interface SimParams {
  winRate: number
  rewardRisk: number
  tradesPerSim: number
  universes: number
  targetReturn: number
  maxDrawdown: number
  tradesPerYear: number
  initialCapital: number
}

export interface RiskLevelResult {
  label: string
  tag: string
  color: string
  singleRisk: number
  medianBalance: number
  maxDrawdown: number
  bustRate: number
  halvedRate: number
  kellyMultiplier: number
}

export interface SimPath {
  pathId: number
  equityCurve: number[]
}

export interface FinalDistribution {
  bins: number[]
  frequencies: number[]
}

export const defaultParams: SimParams = {
  winRate: 45,
  rewardRisk: 2.0,
  tradesPerSim: 100,
  universes: 1000,
  targetReturn: 50,
  maxDrawdown: 20,
  tradesPerYear: 50,
  initialCapital: 100,
}

function simulatePaths(params: SimParams, kellyFraction: number): SimPath[] {
  const paths: SimPath[] = []
  const singleRisk = kellyFraction // 单笔风险比例

  for (let u = 0; u < params.universes; u++) {
    const equity: number[] = [params.initialCapital]
    for (let t = 0; t < params.tradesPerSim; t++) {
      const current = equity[equity.length - 1]
      if (current <= 0) {
        equity.push(0)
        continue
      }
      const isWin = Math.random() < params.winRate / 100
      const riskAmt = current * singleRisk
      const pnl = isWin ? riskAmt * params.rewardRisk : -riskAmt
      equity.push(Math.max(current + pnl, 0))
    }
    paths.push({ pathId: u, equityCurve: equity })
  }
  return paths
}

function computeMetrics(paths: SimPath[], params: SimParams) {
  const finals = paths.map((p) => p.equityCurve[p.equityCurve.length - 1]).sort((a, b) => a - b)
  const median = finals[Math.floor(finals.length / 2)]

  // 最大回撤：取 80th percentile（劣势20%）
  const allDDs: number[] = []
  for (const p of paths) {
    let peak = p.equityCurve[0]
    let maxDD = 0
    for (const val of p.equityCurve) {
      if (val > peak) peak = val
      const dd = peak > 0 ? (peak - val) / peak : 0
      if (dd > maxDD) maxDD = dd
    }
    allDDs.push(maxDD)
  }
  allDDs.sort((a, b) => a - b)
  const dd80 = allDDs[Math.floor(allDDs.length * 0.8)] * 100

  const bustRate = (finals.filter((f) => f < 10).length / finals.length) * 100
  const halvedRate = (finals.filter((f) => f < params.initialCapital * 0.5).length / finals.length) * 100

  return { median, maxDrawdown: dd80, bustRate, halvedRate }
}

function samplePaths(allPaths: SimPath[], count: number): SimPath[] {
  const step = Math.max(1, Math.floor(allPaths.length / count))
  const sampled: SimPath[] = []
  for (let i = 0; i < allPaths.length && sampled.length < count; i += step) {
    sampled.push(allPaths[i])
  }
  return sampled
}

function computeDistribution(paths: SimPath[], initialCapital: number): FinalDistribution {
  const finals = paths.map((p) => p.equityCurve[p.equityCurve.length - 1])
  const min = Math.min(...finals, 0)
  const max = Math.max(...finals, initialCapital * 3)
  const binCount = 40
  const bins: number[] = []
  const frequencies: number[] = []
  const binWidth = (max - min) / binCount

  for (let i = 0; i < binCount; i++) {
    const binStart = min + i * binWidth
    const binEnd = binStart + binWidth
    bins.push(binStart)
    frequencies.push(finals.filter((f) => f >= binStart && f < binEnd).length)
  }

  return { bins, frequencies }
}

export function useKellySimulation() {
  const params = reactive<SimParams>({ ...defaultParams })

  const kellyFull = computed(() => {
    const w = params.winRate / 100
    const r = params.rewardRisk
    if (r <= 0) return 0
    return w - (1 - w) / r
  })

  const riskLevels = ref<RiskLevelResult[]>([])
  const paths = ref<SimPath[]>([])
  const distribution = ref<FinalDistribution>({ bins: [], frequencies: [] })
  const isSimulating = ref(false)

  function runSimulation() {
    const kf = kellyFull.value
    if (kf <= 0) {
      riskLevels.value = []
      paths.value = []
      distribution.value = { bins: [], frequencies: [] }
      return
    }

    isSimulating.value = true

    // 使用 setTimeout 让 UI 有机会渲染 loading 状态
    setTimeout(() => {
      const levels = [
        { label: '标准', tag: '(1/2)', color: '#2080f0', mult: 0.5 },
        { label: '巅峰', tag: '(满)', color: '#18a058', mult: 1.0 },
        { label: '贪婪', tag: '(1.5x)', color: '#f0a020', mult: 1.5 },
        { label: '赌徒', tag: '(2.1x)', color: '#d03050', mult: 2.1 },
      ]

      riskLevels.value = levels.map((lv) => {
        const simPaths = simulatePaths(params, kf * lv.mult)
        const metrics = computeMetrics(simPaths, params)

        return {
          label: lv.label,
          tag: lv.tag,
          color: lv.color,
          singleRisk: Math.min(kf * lv.mult * 100, 100),
          medianBalance: metrics.median,
          maxDrawdown: metrics.maxDrawdown,
          bustRate: metrics.bustRate,
          halvedRate: metrics.halvedRate,
          kellyMultiplier: lv.mult,
        }
      })

      // 用"标准"档的路径生成图表数据
      const standardPaths = simulatePaths(params, kf * 0.5)
      paths.value = samplePaths(standardPaths, 50)
      distribution.value = computeDistribution(standardPaths, params.initialCapital)

      isSimulating.value = false
    }, 10)
  }

  const reverseRisk = computed(() => {
    const w = params.winRate / 100
    const r = params.rewardRisk
    if (w <= 0 || r <= 0 || w * r <= (1 - w)) {
      return { minRiskForReturn: 0, maxRiskForDD: 0, recommendedFull: 0, recommendedHalf: 0 }
    }

    const edge = w * r - (1 - w)
    const targetMultiple = 1 + params.targetReturn / 100
    const minRiskForReturn = Math.log(targetMultiple) / (params.tradesPerYear * edge)

    const expectedLossStreak = 1 / (1 - w)
    const percentileFactor = 2.0
    const maxDD = params.maxDrawdown / 100
    const maxRiskForDD = 1 - Math.pow(1 - maxDD, 1 / (expectedLossStreak * percentileFactor))

    const recFull = Math.max(0, Math.min(minRiskForReturn, maxRiskForDD))

    return {
      minRiskForReturn: minRiskForReturn * 100,
      maxRiskForDD: maxRiskForDD * 100,
      recommendedFull: recFull * 100,
      recommendedHalf: recFull * 50,
    }
  })

  // 参数变化时自动触发，带 300ms debounce
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => ({ ...params }),
    () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        runSimulation()
      }, 300)
    },
    { deep: true }
  )

  // 初始执行
  runSimulation()

  return {
    params,
    kellyFull,
    riskLevels,
    reverseRisk,
    paths,
    distribution,
    isSimulating,
    runSimulation,
  }
}
