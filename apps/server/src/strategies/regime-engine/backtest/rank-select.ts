import { ASHARE_FIELD_COL_MAP } from '../../../strategy-conditions/strategy-conditions.types';

export const RANK_FIELDS = [
  'turnover_rate',
  'pct_chg',
  'amount',
  'pos_120',
  'circ_mv',
  'amv_macd',
  'none',
] as const;

export type RankField = (typeof RANK_FIELDS)[number];
export type RankDir = 'asc' | 'desc';

export const RANK_FIELD_WHITELIST = new Set<string>(RANK_FIELDS);

const DEFAULT_DIR: Record<Exclude<RankField, 'none'>, RankDir> = {
  turnover_rate: 'desc',
  pct_chg: 'desc',
  amount: 'desc',
  pos_120: 'asc',
  circ_mv: 'asc',
  amv_macd: 'desc',
};

export function defaultRankDir(field: string): RankDir | null {
  if (field === 'none') return null;
  return DEFAULT_DIR[field as Exclude<RankField, 'none'>] ?? null;
}

/** SQL 表达式；none → null（不 SELECT） */
export function rankValueSqlExpr(rankField: string): string | null {
  if (rankField === 'none') return null;
  const col = ASHARE_FIELD_COL_MAP[rankField];
  if (!col) throw new Error(`rankField not in ASHARE_FIELD_COL_MAP: ${rankField}`);
  return col;
}

export interface RankCandidateIn {
  tsCode: string;
  rankValue: number | null;
}

export interface RankCandidateOut extends RankCandidateIn {
  rank: number;
}

export function assignRanks(
  items: RankCandidateIn[],
  dir: RankDir,
  opts?: { mode?: 'none' | 'value' },
): RankCandidateOut[] {
  const mode = opts?.mode ?? 'value';
  const sorted = [...items].sort((a, b) => {
    if (mode === 'none') return a.tsCode.localeCompare(b.tsCode);
    const aMiss = a.rankValue == null || Number.isNaN(a.rankValue);
    const bMiss = b.rankValue == null || Number.isNaN(b.rankValue);
    if (aMiss && bMiss) return a.tsCode.localeCompare(b.tsCode);
    if (aMiss) return 1;
    if (bMiss) return -1;
    const cmp = a.rankValue! - b.rankValue!;
    if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    return a.tsCode.localeCompare(b.tsCode);
  });
  return sorted.map((x, i) => ({ ...x, rank: i + 1 }));
}
