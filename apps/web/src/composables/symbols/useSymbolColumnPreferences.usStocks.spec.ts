import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const EMPTY_REMOTE: SymbolsViewColumnPreferences = { crypto: [], aShares: [], usStocks: [] }

describe('useSymbolColumnPreferences · usStocks scope', () => {
  beforeEach(() => {
    getSymbolsView.mockReset()
    saveSymbolsView.mockReset()
    saveSymbolsView.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('初始化时 usStocks scope 取默认列偏好（locked + defaultVisible）', () => {
    const { scopePreferences } = useSymbolColumnPreferences('usStocks', makeDefs())
    expect(scopePreferences.value).toEqual([
      { key: 'ticker', visible: true },
      { key: 'close', visible: true },
      { key: 'ma5', visible: false },
    ])
  })

  it('load → 远端 usStocks 字段被归一化并保留', async () => {
    getSymbolsView.mockResolvedValue({
      ...EMPTY_REMOTE,
      usStocks: [
        { key: 'ticker', visible: true },
        { key: 'close', visible: false },
        { key: 'ma5', visible: true },
      ],
    })
    const { load, scopePreferences } = useSymbolColumnPreferences('usStocks', makeDefs())
    await load()
    expect(scopePreferences.value).toEqual([
      { key: 'ticker', visible: true }, // locked 强制可见
      { key: 'close', visible: false },
      { key: 'ma5', visible: true },
    ])
  })

  it('save → payload 含 usStocks 键（round-trip 不丢字段）', async () => {
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
    expect(payload.usStocks).toEqual([
      { key: 'ticker', visible: true },
      { key: 'close', visible: true },
      { key: 'ma5', visible: true },
    ])
  })
})
