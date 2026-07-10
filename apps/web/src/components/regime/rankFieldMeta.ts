export const RANK_FIELD_OPTIONS = [
  { value: 'turnover_rate', label: '换手率', defaultDir: 'desc' as const },
  { value: 'pct_chg', label: '涨跌幅', defaultDir: 'desc' as const },
  { value: 'amount', label: '成交额', defaultDir: 'desc' as const },
  { value: 'pos_120', label: '120日位置', defaultDir: 'asc' as const },
  { value: 'circ_mv', label: '流通市值', defaultDir: 'asc' as const },
  { value: 'amv_macd', label: '个股AMV-MACD', defaultDir: 'desc' as const },
  { value: 'none', label: '不排序(代码升序)', defaultDir: null },
]

export const RANK_DIR_OPTIONS = [
  { value: 'asc', label: '升序' },
  { value: 'desc', label: '降序' },
]

export const RANK_FIELD_VALUES = new Set(RANK_FIELD_OPTIONS.map((o) => o.value))

export function labelForRankField(field: string | null | undefined): string {
  return RANK_FIELD_OPTIONS.find((o) => o.value === field)?.label ?? field ?? '—'
}

export function defaultDirForRankField(field: string): 'asc' | 'desc' | null {
  return RANK_FIELD_OPTIONS.find((o) => o.value === field)?.defaultDir ?? null
}
