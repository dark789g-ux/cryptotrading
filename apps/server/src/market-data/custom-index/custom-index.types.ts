import type { IndexDailyKlineRow } from '../index-daily/index-daily.types';
import type { AmvSeriesRow } from '../active-mv/active-mv.types';
import type {
  CustomIndexStatus,
  CustomIndexType,
  CustomIndexWeightMethod,
} from '../../entities/custom-index/custom-index-definition.entity';

/** GET /api/custom-indices/latest 单行（camelCase wire） */
export interface CustomIndexLatestRow {
  id: string;
  tsCode: string;
  name: string;
  category: 'custom';
  tradeDate: string | null;
  close: number | null;
  pctChange: number | null;
  vol: number | null;
  amount: number | null;
  count: number | null;
  status: CustomIndexStatus;
  computeProgress: number | null;
  indexType: CustomIndexType;
  weightMethod: CustomIndexWeightMethod;
  baseDate: string;
  basePoint: number;
  actualStartDate: string | null;
  netAmount: number | null;
  netAmount5d: number | null;
  netAmount10d: number | null;
  netAmount20d: number | null;
  buyLgAmount: number | null;
  buyMdAmount: number | null;
  buySmAmount: number | null;
}

export interface CustomIndexLatestResult {
  rows: CustomIndexLatestRow[];
  total: number;
}

export interface CustomIndexMemberRow {
  conCode: string;
  name: string | null;
  weight: number;
}

export interface CustomIndexDetail {
  id: string;
  tsCode: string;
  name: string;
  description: string | null;
  indexType: CustomIndexType;
  baseDate: string;
  basePoint: number;
  weightMethod: CustomIndexWeightMethod;
  status: CustomIndexStatus;
  computeProgress: number | null;
  computeStage: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  members: CustomIndexMemberRow[];
}

export type CustomIndexKlineRow = IndexDailyKlineRow;

/** GET /api/custom-indices/:id/amv 与 active-mv AmvSeriesRow 同构 */
export type CustomIndexAmvRow = AmvSeriesRow;

export interface MemberInput {
  con_code: string;
  weight?: number;
}

export const MIN_CUSTOM_INDEX_MEMBERS = 2;
export const MAX_CUSTOM_INDEX_MEMBERS = 500;
export const WEIGHT_SUM_TOLERANCE = 1e-6;

/** 校验 custom 权重总和 ≈ 1 */
export function assertWeightSum(weights: number[]): void {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(`权重总和须为 1 ± ${WEIGHT_SUM_TOLERANCE}，实际 ${sum}`);
  }
}

/** 生成 ts_code：CUST.{8位小写hex}.U */
export function generateCustomIndexTsCode(): string {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toLowerCase();
  return `CUST.${hex}.U`;
}

/** 比较两组成分权重是否相同（忽略顺序） */
export function membersEqual(
  a: Array<{ conCode: string; weight: string | number }>,
  b: Array<{ conCode: string; weight: string | number }>,
): boolean {
  if (a.length !== b.length) return false;
  const norm = (rows: typeof a) =>
    rows
      .map((r) => `${r.conCode}:${Number(r.weight).toFixed(10)}`)
      .sort()
      .join('|');
  return norm(a) === norm(b);
}
