import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { SymbolColumnDef } from '@/components/symbols/columnTypes'
import type { SymbolsViewColumnPreferences } from '@/api'

// 拦截网络层：load 走 mock getSymbolsView，save 捕获最终 payload 断言 usStocks 不丢字段
const getSymbolsView = vi.fn()
const saveSymbolsView = vi.fn()

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    preferencesApi: {
      getSymbolsView: () => getSymbolsView(),
      saveSymbolsView: (body: SymbolsViewColumnPreferences) => saveSymbolsView(body),
    },
  }
})

import { useSymbolColumnPreferences } from './useSymbolColumnPreferences'

interface Row { a: number }

function makeDefs(): SymbolColumnDef<Row>[] {
  return [
    { key: 'ticker', title: '代码', locked: true, defaultVisible: true, render: () => '' },
    { key: 'close', title: '最新价', defaultVisible: true, sorter: true, render: () => '' },
    { key: 'ma5', title: 'MA5', defaultVisible: false, sorter: true, render: () => '' },
  ]
}

// DataTableColumns 元素类型是联合（含 selection 等非数据列），key 不保证存在；
// 提取数据列的 key 用于断言顺序。
function columnKeyOf(col: unknown): string {
  const key = (col as { key?: unknown }).key
  return typeof key === 'string' ? key : ''
}

const DEFAULT_US = [
  { key: 'ticker', visible: true },
  { key: 'close', visible: true },
  { key: 'ma5', visible: false },
]

const EMPTY_REMOTE: SymbolsViewColumnPreferences = {
  crypto: { table: [], split: [] },
  aShares: { table: [], split: [] },
  usStocks: { table: [], split: [] },
  aSharesIndex: { table: [], split: [] },
  aSharesIndexSw: { table: [], split: [] },
}

describe('useSymbolColumnPreferences · usStocks scope', () => {
  beforeEach(() => {
    getSymbolsView.mockReset()
    saveSymbolsView.mockReset()
    saveSymbolsView.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('初始化（默认 viewMode=table）→ scopePreferences 取 table 槽默认列偏好', () => {
    const { scopePreferences } = useSymbolColumnPreferences('usStocks', makeDefs())
    expect(scopePreferences.value).toEqual(DEFAULT_US)
  })

  it('初始化时 splitColumns 与 tableColumns 相同（未 load，默认拷贝）', () => {
    const { tableColumns, splitColumns } = useSymbolColumnPreferences('usStocks', makeDefs())
    expect(splitColumns.value.map(columnKeyOf)).toEqual(
      tableColumns.value.map(columnKeyOf),
    )
  })

  it('viewMode=split 时 scopePreferences 读 split 槽', () => {
    const viewMode = ref<'table' | 'split'>('split')
    const { scopePreferences } = useSymbolColumnPreferences('usStocks', makeDefs(), viewMode)
    // 未 load，split 槽默认与 table 一致
    expect(scopePreferences.value).toEqual(DEFAULT_US)
  })

  it('切换 viewMode → scopePreferences 在 table/split 间切片', async () => {
    getSymbolsView.mockResolvedValue({
      ...EMPTY_REMOTE,
      usStocks: {
        table: [
          { key: 'ticker', visible: true },
          { key: 'close', visible: false },
          { key: 'ma5', visible: true },
        ],
        split: [
          { key: 'ticker', visible: true },
          { key: 'close', visible: true },
          { key: 'ma5', visible: false },
        ],
      },
    })
    const viewMode = ref<'table' | 'split'>('table')
    const { load, scopePreferences } = useSymbolColumnPreferences('usStocks', makeDefs(), viewMode)
    await load()

    expect(scopePreferences.value).toEqual([
      { key: 'ticker', visible: true },
      { key: 'close', visible: false },
      { key: 'ma5', visible: true },
    ])

    viewMode.value = 'split'
    expect(scopePreferences.value).toEqual([
      { key: 'ticker', visible: true },
      { key: 'close', visible: true },
      { key: 'ma5', visible: false },
    ])
  })

  it('load → 新格式 usStocks 两槽位分别归一化保留', async () => {
    getSymbolsView.mockResolvedValue({
      ...EMPTY_REMOTE,
      usStocks: {
        table: [
          { key: 'ticker', visible: true },
          { key: 'close', visible: true },
          { key: 'ma5', visible: true },
        ],
        // split 只显式给了 ticker；close 走 defaultVisible(true) 被 normalize 补全，
        // ma5 defaultVisible(false) 不显示 → splitColumns 只看到 ticker + close
        split: [
          { key: 'ticker', visible: true },
          { key: 'close', visible: true },
        ],
      },
    })
    const { load, tableColumns, splitColumns } = useSymbolColumnPreferences('usStocks', makeDefs())
    await load()
    expect(tableColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close', 'ma5'])
    expect(splitColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close'])
  })

  it('hydrateScope：空 split → 用 table 深拷贝填充（老数据迁移默认）', async () => {
    // 后端 sanitize 会把老扁平数组转成 { table: [...], split: [] }，前端 hydrate 回填 split
    getSymbolsView.mockResolvedValue({
      ...EMPTY_REMOTE,
      usStocks: {
        table: [
          { key: 'ticker', visible: true },
          { key: 'close', visible: false },
        ],
        split: [],
      },
    })
    const viewMode = ref<'table' | 'split'>('table')
    const { load, scopePreferences } = useSymbolColumnPreferences('usStocks', makeDefs(), viewMode)
    await load()

    // 切到 split：空 split 应被 table 深拷贝填充，normalize 补全缺失的 ma5 到末尾
    viewMode.value = 'split'
    expect(scopePreferences.value).toEqual([
      { key: 'ticker', visible: true },
      { key: 'close', visible: false },
      { key: 'ma5', visible: false },
    ])
  })

  it('save → payload 为新结构（scope → { table, split }）', async () => {
    getSymbolsView.mockResolvedValue({ ...EMPTY_REMOTE })
    const { load, save, setColumnVisible } = useSymbolColumnPreferences('usStocks', makeDefs())
    await load()
    setColumnVisible('ma5', true)
    await save()
    expect(saveSymbolsView).toHaveBeenCalledTimes(1)
    const payload = saveSymbolsView.mock.calls[0][0] as SymbolsViewColumnPreferences
    expect(payload).toHaveProperty('crypto')
    expect(payload).toHaveProperty('aShares')
    expect(payload).toHaveProperty('usStocks')
    expect(payload.usStocks).toEqual({
      table: [
        { key: 'ticker', visible: true },
        { key: 'close', visible: true },
        { key: 'ma5', visible: true },
      ],
      // 未改 split，保持默认拷贝
      split: [
        { key: 'ticker', visible: true },
        { key: 'close', visible: true },
        { key: 'ma5', visible: false },
      ],
    })
  })

  it('normalizeScopePreferences 签名不变（backtest/watchlist 兼容回归）', async () => {
    // 确认 3 个导出纯函数仍可直接 import 使用（见 backtest/watchlist composable）
    const { buildColumnsFromPreference, createDefaultScopePreferences, normalizeScopePreferences } =
      await import('./useSymbolColumnPreferences')
    const defs = makeDefs()
    const defaults = createDefaultScopePreferences(defs)
    expect(normalizeScopePreferences(defs, defaults)).toEqual(defaults)
    expect(buildColumnsFromPreference(defs, defaults).length).toBe(2) // ticker + close（ma5 不可见）
  })

  it('defs 响应式变化（如 priceMode 切换重建 columnDefs）→ tableColumns / splitColumns 重算', async () => {
    // 模拟 Panel 中 columnDefs 随 priceMode 变化重建的场景：defs 从 3 列换成 2 列
    const defsRef = ref(makeDefs())
    const { tableColumns, splitColumns } = useSymbolColumnPreferences('usStocks', defsRef, 'table')

    expect(tableColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close']) // ma5 不可见
    expect(splitColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close'])

    // defs 重建：去掉 ma5，新增 volume（defaultVisible 未设 = 默认可见）
    defsRef.value = [
      { key: 'ticker', title: '代码', locked: true, defaultVisible: true, render: () => '' },
      { key: 'close', title: '最新价', defaultVisible: true, sorter: true, render: () => '' },
      { key: 'volume', title: '成交量', render: () => '' },
    ]
    expect(tableColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close', 'volume'])
    expect(splitColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close', 'volume'])
  })
})
