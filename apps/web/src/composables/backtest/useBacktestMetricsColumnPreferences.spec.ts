import { describe, expect, it, vi } from 'vitest'
import type { SymbolColumnDef } from '@/components/symbols/columnTypes'
import { useBacktestMetricsColumnPreferences } from './useBacktestMetricsColumnPreferences'

vi.mock('@/composables/symbols/useTableColumnPreferences', () => ({
  useTableColumnPreferences: vi.fn((_tableId: string, defs: unknown, _viewMode: string) => {
    const resolvedDefs = (Array.isArray(defs) ? defs : (defs as { value: unknown }).value) as SymbolColumnDef<unknown>[]
    const scopePreferences = { value: resolvedDefs.map((d) => ({ key: d.key, visible: d.locked ? true : d.defaultVisible !== false })) }
    const tableColumns = { value: resolvedDefs.filter((d) => d.locked || d.defaultVisible !== false).map((d) => ({ key: d.key, title: d.title })) }
    return {
      saving: { value: false },
      scopePreferences,
      tableColumns,
      reset: vi.fn(),
      save: vi.fn(),
      load: vi.fn(),
    }
  }),
}))

interface Row {
  a: number
}

function makeDefs(): SymbolColumnDef<Row>[] {
  return [
    { key: 'symbol', title: '标的', locked: true, defaultVisible: true, render: () => '' },
    { key: 'ma5', title: 'MA5', defaultVisible: true, sorter: true, render: () => '' },
    { key: 'ma30', title: 'MA30', defaultVisible: true, sorter: true, render: () => '' },
    { key: 'hidden', title: '隐藏', defaultVisible: false, render: () => '' },
  ]
}

describe('useBacktestMetricsColumnPreferences', () => {
  it('透传 useTableColumnPreferences 返回字段', () => {
    const { saving, scopePreferences, tableColumns, reset, save, load } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(saving.value).toBe(false)
    expect(scopePreferences.value).toEqual([
      { key: 'symbol', visible: true },
      { key: 'ma5', visible: true },
      { key: 'ma30', visible: true },
      { key: 'hidden', visible: false },
    ])
    expect(tableColumns.value.map((c: { key: string }) => c.key)).toEqual(['symbol', 'ma5', 'ma30'])
    expect(typeof reset).toBe('function')
    expect(typeof save).toBe('function')
    expect(typeof load).toBe('function')
  })
})
