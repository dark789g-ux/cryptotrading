import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { SymbolColumnDef } from '@/components/symbols/columns/columnTypes'
import type { ScopeViewPreferences } from '@/api'

// 拦截网络层：load 走 mock getTableColumns，save 捕获最终 payload 断言
const getTableColumns = vi.fn()
const saveTableColumns = vi.fn()

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    preferencesApi: {
      getTableColumns: (tableId: string) => getTableColumns(tableId),
      saveTableColumns: (tableId: string, body: ScopeViewPreferences) => saveTableColumns(tableId, body),
    },
  }
})

import { useTableColumnPreferences } from './useTableColumnPreferences'

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

const DEFAULT_TABLE = [
  { key: 'ticker', visible: true },
  { key: 'close', visible: true },
  { key: 'ma5', visible: false },
]

const EMPTY_REMOTE: ScopeViewPreferences = {
  table: [],
  split: [],
}

describe('useTableColumnPreferences', () => {
  beforeEach(() => {
    getTableColumns.mockReset()
    saveTableColumns.mockReset()
    saveTableColumns.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('初始化（默认 viewMode=table）→ scopePreferences 取 table 槽默认列偏好', () => {
    const { scopePreferences } = useTableColumnPreferences('usStocks', makeDefs())
    expect(scopePreferences.value).toEqual(DEFAULT_TABLE)
  })

  it('初始化时 splitColumns 与 tableColumns 相同（未 load，默认拷贝）', () => {
    const { tableColumns, splitColumns } = useTableColumnPreferences('usStocks', makeDefs())
    expect(splitColumns.value.map(columnKeyOf)).toEqual(
      tableColumns.value.map(columnKeyOf),
    )
  })

  it('viewMode=split 时 scopePreferences 读 split 槽', () => {
    const viewMode = ref<'table' | 'split'>('split')
    const { scopePreferences } = useTableColumnPreferences('usStocks', makeDefs(), viewMode)
    // 未 load，split 槽默认与 table 一致
    expect(scopePreferences.value).toEqual(DEFAULT_TABLE)
  })

  it('切换 viewMode → scopePreferences 在 table/split 间切片', async () => {
    getTableColumns.mockResolvedValue({
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
    })
    const viewMode = ref<'table' | 'split'>('table')
    const { load, scopePreferences } = useTableColumnPreferences('usStocks', makeDefs(), viewMode)
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

  it('load → 新格式两槽位分别归一化保留', async () => {
    getTableColumns.mockResolvedValue({
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
    })
    const { load, tableColumns, splitColumns } = useTableColumnPreferences('usStocks', makeDefs())
    await load()
    expect(tableColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close', 'ma5'])
    expect(splitColumns.value.map(columnKeyOf)).toEqual(['ticker', 'close'])
  })

  it('hydrateScope：空 split → 用 table 深拷贝填充（老数据迁移默认）', async () => {
    // 后端 sanitize 会把老扁平数组转成 { table: [...], split: [] }，前端 hydrate 回填 split
    getTableColumns.mockResolvedValue({
      table: [
        { key: 'ticker', visible: true },
        { key: 'close', visible: false },
      ],
      split: [],
    })
    const viewMode = ref<'table' | 'split'>('table')
    const { load, scopePreferences } = useTableColumnPreferences('usStocks', makeDefs(), viewMode)
    await load()

    // 切到 split：空 split 应被 table 深拷贝填充，normalize 补全缺失的 ma5 到末尾
    viewMode.value = 'split'
    expect(scopePreferences.value).toEqual([
      { key: 'ticker', visible: true },
      { key: 'close', visible: false },
      { key: 'ma5', visible: false },
    ])
  })

  it('save → 调用 saveTableColumns 并只传当前表数据', async () => {
    getTableColumns.mockResolvedValue({ ...EMPTY_REMOTE })
    const { load, save, setColumnVisible } = useTableColumnPreferences('usStocks', makeDefs())
    await load()
    setColumnVisible('ma5', true)
    await save()
    expect(saveTableColumns).toHaveBeenCalledTimes(1)
    const [calledTableId, payload] = saveTableColumns.mock.calls[0] as [string, ScopeViewPreferences]
    expect(calledTableId).toBe('usStocks')
    expect(payload).toEqual({
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
      await import('./useTableColumnPreferences')
    const defs = makeDefs()
    const defaults = createDefaultScopePreferences(defs)
    expect(normalizeScopePreferences(defs, defaults)).toEqual(defaults)
    expect(buildColumnsFromPreference(defs, defaults).length).toBe(2) // ticker + close（ma5 不可见）
  })

  it('defs 响应式变化（如 priceMode 切换重建 columnDefs）→ tableColumns / splitColumns 重算', async () => {
    // 模拟 Panel 中 columnDefs 随 priceMode 变化重建的场景：defs 从 3 列换成 2 列
    const defsRef = ref(makeDefs())
    const { tableColumns, splitColumns } = useTableColumnPreferences('usStocks', defsRef, 'table')

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

  it('load 时传入 tableId 到 getTableColumns', async () => {
    getTableColumns.mockResolvedValue({ ...EMPTY_REMOTE })
    const { load } = useTableColumnPreferences('aShares', makeDefs())
    await load()
    expect(getTableColumns).toHaveBeenCalledWith('aShares')
  })

  it('reset 后 scopePreferences 恢复默认', async () => {
    getTableColumns.mockResolvedValue({
      table: [
        { key: 'ticker', visible: true },
        { key: 'close', visible: false },
        { key: 'ma5', visible: true },
      ],
      split: [],
    })
    const { load, scopePreferences, reset } = useTableColumnPreferences('usStocks', makeDefs())
    await load()
    expect(scopePreferences.value).toEqual([
      { key: 'ticker', visible: true },
      { key: 'close', visible: false },
      { key: 'ma5', visible: true },
    ])
    reset()
    expect(scopePreferences.value).toEqual(DEFAULT_TABLE)
  })

  it('moveColumnByKey up/down 正确调整顺序', async () => {
    getTableColumns.mockResolvedValue({ ...EMPTY_REMOTE })
    const { load, scopePreferences, moveColumnByKey } = useTableColumnPreferences('usStocks', makeDefs())
    await load()
    // 初始: ticker, close, ma5
    moveColumnByKey('ma5', 'up')
    expect(scopePreferences.value.map((i) => i.key)).toEqual(['ticker', 'ma5', 'close'])
    moveColumnByKey('ticker', 'down')
    // ticker locked，不能移动
    expect(scopePreferences.value.map((i) => i.key)).toEqual(['ticker', 'ma5', 'close'])
  })
})
