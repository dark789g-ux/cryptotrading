/**
 * Kelly Sweep 前端纯逻辑单测
 *
 * 覆盖：
 * 1. 组合数预估计算（variantCount × exitCount）
 * 2. 帕累托散点 option 生成（buildSeriesData 分类）
 * 3. 表格列映射 / 格式化工具函数
 * 4. 字段契约对齐：后端真实字段名 → 前端类型（防止字段名再次漂移）
 * 5. sort 串构造白名单校验（白名单镜像自后端 KELLY_SORT_FIELD_MAP，两处须同步）
 */
import { describe, it, expect } from 'vitest'
import type { KellyScatterPoint, KellyTopkRow, KellyRowDetail } from '@/api/modules/quant/kellySweep'
import {
  makeDefaultPhaseLockGrid,
  estimatePhaseLockGridSize,
  quantizePhaseLockFactor,
} from '@/stores/kellySweep'

/**
 * 镜像后端 KELLY_SORT_FIELD_MAP 的 key 集合。
 * 后端路径：apps/server/src/modules/quant/kelly-sweep/kelly-sweep.service.ts
 * 两处须保持同步；若后端新增/删除排序列，此处跟着改，否则单测失败提醒漂移。
 */
const BACKEND_SORT_KEYS = new Set([
  'kelly_valid', 'kelly_train', 'kelly_ci_low', 'kelly_ci_high',
  'n_valid', 'n_train',
  'win_rate_valid', 'win_rate_train',
  'payoff_b_valid', 'payoff_b_train',
  'profit_factor_valid', 'profit_factor_train',
  'variant_id', 'exit_id', 'same_day_rule', 'created_at',
])

// ---------- 1. 组合数预估逻辑 ----------
// 来源：KellySweepConfigForm.vue — comb / variantCount / exitCount
// 入场候选 15 个（sweep.py:62），出场族大小（sweep.py:90-106）

const EXIT_FAMILY_SIZES: Record<string, number> = {
  fixed_n: 5,
  tp_sl: 36,
  trailing: 6,
  atr_stop: 6,
}

const ENTRY_CANDIDATES = 15

function comb(n: number, k: number): number {
  if (k > n) return 0
  if (k === 0) return 1
  let result = 1
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1)
  }
  return Math.round(result)
}

function variantCount(maxEntryFilters: number): number {
  let total = 0
  for (let k = 0; k <= maxEntryFilters; k++) {
    total += comb(ENTRY_CANDIDATES, k)
  }
  return total
}

function exitCount(families: string[]): number {
  return families.reduce((sum, f) => sum + (EXIT_FAMILY_SIZES[f] ?? 0), 0)
}

describe('组合数预估 — variantCount', () => {
  it('max_entry_filters=0 → 只有 base 变体 1 种', () => {
    expect(variantCount(0)).toBe(1)
  })

  it('max_entry_filters=1 → 1 + C(15,1) = 16', () => {
    expect(variantCount(1)).toBe(1 + 15)
  })

  it('max_entry_filters=2 → 1 + 15 + C(15,2) = 1+15+105 = 121', () => {
    expect(variantCount(2)).toBe(1 + 15 + 105)
  })
})

describe('组合数预估 — exitCount', () => {
  it('全部出场族 fixed_n+tp_sl+trailing+atr_stop = 5+36+6+6 = 53', () => {
    expect(exitCount(['fixed_n', 'tp_sl', 'trailing', 'atr_stop'])).toBe(53)
  })

  it('只选 fixed_n → 5', () => {
    expect(exitCount(['fixed_n'])).toBe(5)
  })

  it('空出场族 → 0', () => {
    expect(exitCount([])).toBe(0)
  })
})

describe('组合数预估 — 阈值警告', () => {
  const COMBO_WARN_THRESHOLD = 5000

  it('max_entry_filters=1 全出场：16×53=848 < 5000，不警告', () => {
    const combo = variantCount(1) * exitCount(['fixed_n', 'tp_sl', 'trailing', 'atr_stop'])
    expect(combo).toBe(848)
    expect(combo > COMBO_WARN_THRESHOLD).toBe(false)
  })

  it('max_entry_filters=2 全出场：121×53=6413 > 5000，应警告', () => {
    const combo = variantCount(2) * exitCount(['fixed_n', 'tp_sl', 'trailing', 'atr_stop'])
    expect(combo).toBe(6413)
    expect(combo > COMBO_WARN_THRESHOLD).toBe(true)
  })
})

// ---------- 2. 帕累托散点数据分类 ----------
// 来源：KellyParetoScatter.vue — buildSeriesData

type SeriesCategory = 'frontier' | 'normal' | 'gray'

function categorizePoint(p: KellyScatterPoint): SeriesCategory {
  if (p.below_floor || p.kelly_valid === null) return 'gray'
  if (p.is_frontier) return 'frontier'
  return 'normal'
}

function buildSeriesData(pts: KellyScatterPoint[]) {
  const frontier: KellyScatterPoint[] = []
  const normal: KellyScatterPoint[] = []
  const gray: KellyScatterPoint[] = []
  for (const p of pts) {
    const cat = categorizePoint(p)
    if (cat === 'frontier') frontier.push(p)
    else if (cat === 'normal') normal.push(p)
    else gray.push(p)
  }
  return { frontier, normal, gray }
}

const SAMPLE_POINTS: KellyScatterPoint[] = [
  { id: '1', n_valid: 100, kelly_valid: 0.3, is_frontier: true, below_floor: false, variant_id: 'v1', exit_id: 'e1' },
  { id: '2', n_valid: 200, kelly_valid: 0.25, is_frontier: false, below_floor: false, variant_id: 'v2', exit_id: 'e2' },
  { id: '3', n_valid: 50, kelly_valid: null, is_frontier: false, below_floor: false, variant_id: 'v3', exit_id: 'e3' },
  { id: '4', n_valid: 80, kelly_valid: 0.1, is_frontier: false, below_floor: true, variant_id: 'v4', exit_id: 'e4' },
  { id: '5', n_valid: 300, kelly_valid: 0.35, is_frontier: true, below_floor: false, variant_id: 'v5', exit_id: 'e5' },
]

describe('帕累托散点分类', () => {
  it('is_frontier=true, below_floor=false, kelly_valid 有值 → frontier', () => {
    expect(categorizePoint(SAMPLE_POINTS[0])).toBe('frontier')
  })

  it('is_frontier=false, below_floor=false, kelly_valid 有值 → normal', () => {
    expect(categorizePoint(SAMPLE_POINTS[1])).toBe('normal')
  })

  it('kelly_valid=null → gray（不论其他字段）', () => {
    expect(categorizePoint(SAMPLE_POINTS[2])).toBe('gray')
  })

  it('below_floor=true → gray', () => {
    expect(categorizePoint(SAMPLE_POINTS[3])).toBe('gray')
  })

  it('buildSeriesData 分类数量正确', () => {
    const { frontier, normal, gray } = buildSeriesData(SAMPLE_POINTS)
    expect(frontier.length).toBe(2)
    expect(normal.length).toBe(1)
    expect(gray.length).toBe(2)
  })
})

// ---------- 3. 表格格式化工具 ----------
// 来源：KellySweepTopkTable.vue

function fmtNum(v: number | null, digits = 3): string {
  if (v === null || v === undefined) return '—'
  return v.toFixed(digits)
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toFixed(1)}%`
}

describe('表格格式化工具', () => {
  it('fmtNum null → —', () => {
    expect(fmtNum(null)).toBe('—')
  })

  it('fmtNum 0.383 → "0.383"', () => {
    expect(fmtNum(0.383)).toBe('0.383')
  })

  it('fmtNum 1.5 digits=2 → "1.50"', () => {
    expect(fmtNum(1.5, 2)).toBe('1.50')
  })

  it('fmtPct null → —', () => {
    expect(fmtPct(null)).toBe('—')
  })

  it('fmtPct 0.627 → "62.7%"', () => {
    expect(fmtPct(0.627)).toBe('62.7%')
  })

  it('fmtPct 0 → "0.0%"', () => {
    expect(fmtPct(0)).toBe('0.0%')
  })
})

// ---------- 4. 日期格式转换 ----------
// 来源：KellySweepConfigForm.vue — tsToYYYYMMDD（使用本地 TZ，A 股 trade_date 规范）

function tsToYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function yyyymmddToTs(s: string): number {
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(4, 6)) - 1
  const dayNum = Number(s.slice(6, 8))
  return new Date(y, m, dayNum).getTime()
}

describe('日期格式转换（本地 TZ，trade_date 规范）', () => {
  it('yyyymmddToTs → tsToYYYYMMDD 往返一致', () => {
    const input = '20230101'
    expect(tsToYYYYMMDD(yyyymmddToTs(input))).toBe(input)
  })

  it('20241231 往返一致', () => {
    const input = '20241231'
    expect(tsToYYYYMMDD(yyyymmddToTs(input))).toBe(input)
  })

  it('20260609 往返一致', () => {
    const input = '20260609'
    expect(tsToYYYYMMDD(yyyymmddToTs(input))).toBe(input)
  })
})

// ---------- 5. 字段契约对齐：KellyTopkRow（后端真实字段名） ----------
// 防止字段名再次漂移；mock 数据用后端 TopkRow 接口真实字段名构造

describe('字段契约：KellyTopkRow 与后端 TopkRow 对齐', () => {
  /** 模拟后端 getTopk 返回的单行（以后端 TopkRow 真实字段为准） */
  const mockTopkRow: KellyTopkRow = {
    id: '42',
    variant_id: 'kdj_j<0',
    exit_id: 'fixed_n(n=5)',
    n_valid: 180,
    kelly_valid: 0.1755,
    kelly_ci_low: 0.09,
    kelly_ci_high: 0.24,
    win_rate_valid: 0.627,
    payoff_b_valid: 1.32,
    profit_factor_valid: 2.1,
    below_floor: false,
    is_frontier: true,
    same_day_rule: 'sl_first',
  }

  it('KellyTopkRow 包含后端 TopkRow 的全部字段（CI、胜率、盈亏比用正确后端字段名）', () => {
    // CI 字段
    expect(mockTopkRow.kelly_ci_low).toBe(0.09)
    expect(mockTopkRow.kelly_ci_high).toBe(0.24)
    // 胜率：后端字段名 win_rate_valid，不是 win_rate
    expect(mockTopkRow.win_rate_valid).toBe(0.627)
    // 盈亏比：后端字段名 payoff_b_valid，不是 payoff_ratio
    expect(mockTopkRow.payoff_b_valid).toBe(1.32)
    // 其他字段
    expect(mockTopkRow.kelly_valid).toBe(0.1755)
    expect(mockTopkRow.n_valid).toBe(180)
    expect(mockTopkRow.is_frontier).toBe(true)
    expect(mockTopkRow.below_floor).toBe(false)
    expect(mockTopkRow.same_day_rule).toBe('sl_first')
  })

  it('KellyTopkRow 不含已删除的旧字段（ci_lo/ci_hi/win_rate/payoff_ratio）', () => {
    const row = mockTopkRow as unknown as Record<string, unknown>
    expect(row['ci_lo']).toBeUndefined()
    expect(row['ci_hi']).toBeUndefined()
    expect(row['win_rate']).toBeUndefined()
    expect(row['payoff_ratio']).toBeUndefined()
  })

  it('TopkTable CI 列渲染逻辑：用 kelly_ci_low/kelly_ci_high', () => {
    // 模拟 KellySweepTopkTable.vue CI 列 render 函数逻辑
    function renderCI(row: KellyTopkRow): string {
      if (row.kelly_ci_low === null || row.kelly_ci_high === null) return '—'
      return `[${row.kelly_ci_low.toFixed(3)}, ${row.kelly_ci_high.toFixed(3)}]`
    }
    expect(renderCI(mockTopkRow)).toBe('[0.090, 0.240]')

    const nullRow: KellyTopkRow = { ...mockTopkRow, kelly_ci_low: null, kelly_ci_high: null }
    expect(renderCI(nullRow)).toBe('—')
  })

  it('TopkTable 胜率列渲染：用 win_rate_valid', () => {
    function renderWinRate(row: KellyTopkRow): string {
      if (row.win_rate_valid === null || row.win_rate_valid === undefined) return '—'
      return `${(row.win_rate_valid * 100).toFixed(1)}%`
    }
    expect(renderWinRate(mockTopkRow)).toBe('62.7%')
    expect(renderWinRate({ ...mockTopkRow, win_rate_valid: null })).toBe('—')
  })

  it('TopkTable 盈亏比列渲染：用 payoff_b_valid', () => {
    function renderPayoff(row: KellyTopkRow): string {
      if (row.payoff_b_valid === null || row.payoff_b_valid === undefined) return '—'
      return row.payoff_b_valid.toFixed(2)
    }
    expect(renderPayoff(mockTopkRow)).toBe('1.32')
    expect(renderPayoff({ ...mockTopkRow, payoff_b_valid: null })).toBe('—')
  })
})

// ---------- 6. 字段契约：KellyRowDetail（后端 getRow 返回实体 camelCase） ----------

describe('字段契约：KellyRowDetail 与后端实体 camelCase 字段对齐', () => {
  const mockDetail: KellyRowDetail = {
    id: '42',
    jobId: 'abc-123',
    windowGroup: 'with_rs',
    variantId: 'kdj_j<0',
    variantFilters: [[['kdj_j', 'lt', 0]]],
    exitId: 'fixed_n(n=5)',
    exitCfg: { type: 'fixed_n', n: 5 },
    nTrain: 450,
    kellyTrain: 0.18,
    winRateTrain: 0.61,
    payoffBTrain: 1.25,
    profitFactorTrain: 1.9,
    nValid: 180,
    kellyValid: 0.1755,
    winRateValid: 0.627,
    payoffBValid: 1.32,
    profitFactorValid: 2.1,
    belowFloor: false,
    kellyCiLow: 0.09,
    kellyCiHigh: 0.24,
    isFrontier: true,
    isTopk: true,
    sameDayRule: 'sl_first',
    createdAt: '2026-06-09T00:00:00Z',
  }

  it('KellyRowDetail 包含实体 camelCase 字段（训练集）', () => {
    expect(mockDetail.nTrain).toBe(450)
    expect(mockDetail.kellyTrain).toBe(0.18)
    expect(mockDetail.winRateTrain).toBe(0.61)
    expect(mockDetail.payoffBTrain).toBe(1.25)
    expect(mockDetail.profitFactorTrain).toBe(1.9)
  })

  it('KellyRowDetail 包含实体 camelCase 字段（验证集）', () => {
    expect(mockDetail.nValid).toBe(180)
    expect(mockDetail.kellyValid).toBe(0.1755)
    expect(mockDetail.winRateValid).toBe(0.627)
    expect(mockDetail.payoffBValid).toBe(1.32)
    expect(mockDetail.profitFactorValid).toBe(2.1)
    expect(mockDetail.kellyCiLow).toBe(0.09)
    expect(mockDetail.kellyCiHigh).toBe(0.24)
  })

  it('KellyRowDetail 包含实体 camelCase 标记字段', () => {
    expect(mockDetail.isFrontier).toBe(true)
    expect(mockDetail.isTopk).toBe(true)
    expect(mockDetail.belowFloor).toBe(false)
    expect(mockDetail.windowGroup).toBe('with_rs')
    expect(mockDetail.exitId).toBe('fixed_n(n=5)')
  })

  it('KellyRowDetail 不含旧错误字段', () => {
    const d = mockDetail as unknown as Record<string, unknown>
    expect(d['win_rate']).toBeUndefined()
    expect(d['payoff_ratio']).toBeUndefined()
    expect(d['ci_lo']).toBeUndefined()
    expect(d['ci_hi']).toBeUndefined()
    expect(d['group']).toBeUndefined()
    expect(d['exit_config']).toBeUndefined()
  })
})

// ---------- 7. sort 串构造白名单校验 ----------

describe('sort 串构造：KellySweepTopkTable 可排序列 key 命中后端白名单', () => {
  /**
   * KellySweepTopkTable.vue 中 sorter:true 的列 key 列表（与组件保持同步）。
   * onSorterChange 函数构造 `${columnKey}:${dir}` 传入 getTopk sort 参数，
   * 后端 resolveSort 解析前半部分匹配 KELLY_SORT_FIELD_MAP。
   */
  const SORTABLE_COLUMN_KEYS = ['n_valid', 'kelly_valid', 'win_rate_valid', 'payoff_b_valid']

  it('全部可排序列 key 命中后端 KELLY_SORT_FIELD_MAP', () => {
    for (const key of SORTABLE_COLUMN_KEYS) {
      expect(BACKEND_SORT_KEYS.has(key)).toBe(true)
    }
  })

  it('sort 串格式：onSorterChange 构造 "field:ASC" 或 "field:DESC"', () => {
    // 模拟 KellySweepTopkTable.vue onSorterChange 逻辑
    function buildSortStr(columnKey: string, order: 'ascend' | 'descend'): string {
      const dir = order === 'ascend' ? 'ASC' : 'DESC'
      return `${columnKey}:${dir}`
    }
    expect(buildSortStr('kelly_valid', 'descend')).toBe('kelly_valid:DESC')
    expect(buildSortStr('n_valid', 'ascend')).toBe('n_valid:ASC')
    expect(buildSortStr('win_rate_valid', 'descend')).toBe('win_rate_valid:DESC')
    expect(buildSortStr('payoff_b_valid', 'ascend')).toBe('payoff_b_valid:ASC')
  })

  it('旧错误 key win_rate/payoff_ratio 不在白名单（已修复）', () => {
    expect(BACKEND_SORT_KEYS.has('win_rate')).toBe(false)
    expect(BACKEND_SORT_KEYS.has('payoff_ratio')).toBe(false)
  })
})

// ---------- 8. phase_lock 网格预估（presence-driven，镜像 band_lock） ----------
// 来源：stores/kellySweep.ts — estimatePhaseLockGridSize / makeDefaultPhaseLockGrid
// 与后端 build_phase_lock_grid（D4）同口径：lookback × init_factor × lock_factor 笛卡尔积 + 量化去重

describe('phase_lock 网格预估 — estimatePhaseLockGridSize', () => {
  it('默认候选集 4(lookback)×4(init)×3(lock) = 48 组', () => {
    expect(estimatePhaseLockGridSize(makeDefaultPhaseLockGrid())).toBe(48)
  })

  it('单值三维 → 1 组', () => {
    expect(estimatePhaseLockGridSize({
      lookback_list: [10],
      init_factor_list: [0.99],
      lock_factor_list: [0.999],
    })).toBe(1)
  })

  it('任一维度空 → 0（与后端笛卡尔积为空一致）', () => {
    expect(estimatePhaseLockGridSize({
      lookback_list: [],
      init_factor_list: [0.99],
      lock_factor_list: [0.999],
    })).toBe(0)
    expect(estimatePhaseLockGridSize({
      lookback_list: [10],
      init_factor_list: [],
      lock_factor_list: [0.999],
    })).toBe(0)
    expect(estimatePhaseLockGridSize({
      lookback_list: [10],
      init_factor_list: [0.99],
      lock_factor_list: [],
    })).toBe(0)
  })

  it('factor 维度量化后去重：0.9991/0.9992 量化到 0.999 视为同值', () => {
    expect(estimatePhaseLockGridSize({
      lookback_list: [10],
      init_factor_list: [0.9991, 0.9992, 0.999],
      lock_factor_list: [0.999],
    })).toBe(1)
  })

  it('lookback 整数去重：重复值不重复计入', () => {
    expect(estimatePhaseLockGridSize({
      lookback_list: [10, 10, 20],
      init_factor_list: [0.99],
      lock_factor_list: [0.999],
    })).toBe(2)
  })

  it('2×3×2 = 12 组（各维度去重后乘积）', () => {
    expect(estimatePhaseLockGridSize({
      lookback_list: [5, 10],
      init_factor_list: [0.97, 0.98, 0.99],
      lock_factor_list: [0.99, 1.005],
    })).toBe(12)
  })
})

describe('phase_lock 量化 — quantizePhaseLockFactor（千分位 round-half-up）', () => {
  it('0.9991 → 0.999', () => {
    expect(quantizePhaseLockFactor(0.9991)).toBe(0.999)
  })

  it('0.9995 → 1.0（round-half-up，ratio 恒正）', () => {
    expect(quantizePhaseLockFactor(0.9995)).toBe(1.0)
  })

  it('1.005 原样（已是千分位）', () => {
    expect(quantizePhaseLockFactor(1.005)).toBe(1.005)
  })
})
