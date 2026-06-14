/**
 * portfolio-sim.list-fills-options.ts
 *
 * 纯函数：将前端 fills 查询 opts 转换为 TypeORM findAndCount 的 { where, order }。
 * 设计为纯函数，便于不依赖 DB 的单元测试（仿 signal-stats.list-trades-options）。
 *
 * 排序字段经白名单翻译为实体属性名，禁止裸拼字段名（防注入 + 防 DB 列名水合错位）。
 */
import {
  FindOptionsOrder,
  FindOptionsWhere,
  Between,
  MoreThanOrEqual,
  LessThanOrEqual,
} from 'typeorm';
import { PortfolioSimFillEntity } from '../../entities/strategy/portfolio-sim-fill.entity';

/** fills 列表可接受的过滤/排序选项。 */
export interface ListFillsOptions {
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  status?: string;
  sourceLabel?: string;
  skipReason?: string;
  buyDateStart?: string;
  buyDateEnd?: string;
}

/**
 * 前端排序 key → 实体属性名映射（白名单）。
 * 凡不在此表的 sortField 回落默认排序（buyDate ASC, id ASC）。
 */
export const FILL_SORT_COLUMN_MAP = {
  sourceLabel: 'sourceLabel',
  tsCode: 'tsCode',
  signalDate: 'signalDate',
  buyDate: 'buyDate',
  status: 'status',
  skipReason: 'skipReason',
  rankValue: 'rankValue',
  weightEntry: 'weightEntry',
  alloc: 'alloc',
  exitDate: 'exitDate',
  realizedRetNet: 'realizedRetNet',
  costsPaid: 'costsPaid',
} as const;

/** 成交状态白名单。 */
export const VALID_FILL_STATUS = new Set<string>(['taken', 'skipped']);

/**
 * 跳过原因白名单（来自引擎 SkipReason）。
 * 必须与 portfolio-sim.types.ts 的 SkipReason 联合逐字段对齐——否则前端按新原因筛选时
 * 后端静默丢弃过滤条件（返回全部、无 warn）。升级期补入 Phase 2/3 三新原因。
 */
export const VALID_SKIP_REASONS = new Set<string>([
  'already_held',
  'slots_full',
  'exposure_cap',
  'cash_short',
  'cooldown', // 【Phase 3】连亏熔断冷却期内冻结开仓
  'drawdown_halt', // 【Phase 3】回撤熔断停开仓
  'sized_out', // 【Phase 2】source_kelly 负期望源 alloc≈0
]);

/**
 * 将 (min?, max?) 字符串日期转为 TypeORM range operator（YYYYMMDD 字符串可直接比较）。
 */
export function dateRangeOp(
  min: string | undefined,
  max: string | undefined,
): ReturnType<typeof Between> | ReturnType<typeof MoreThanOrEqual> | ReturnType<typeof LessThanOrEqual> | undefined {
  const hasMin = !!min && min.trim() !== '';
  const hasMax = !!max && max.trim() !== '';
  if (hasMin && hasMax) return Between(min!.trim(), max!.trim());
  if (hasMin) return MoreThanOrEqual(min!.trim());
  if (hasMax) return LessThanOrEqual(max!.trim());
  return undefined;
}

/**
 * 当 sortField 给定但不在白名单时，应让调用方拒绝（service 抛 400），而非静默回落。
 * 此辅助供 service 显式校验：返回 true 表示 sortField 合法（含未提供）。
 */
export function isValidFillSortField(sortField?: string): boolean {
  if (!sortField || sortField.trim() === '') return true;
  return sortField in FILL_SORT_COLUMN_MAP;
}

/**
 * buildFillListOptions：纯函数，输入 runId + 用户选项 → TypeORM findAndCount 参数。
 *
 * 注意：sortField 非法（不在白名单且非空）时此函数仍回落默认排序——但 service 应先用
 * isValidFillSortField 拦截并抛 400（spec 要求“排序白名单拒绝未知列”）。
 */
export function buildFillListOptions(
  runId: string,
  opts: ListFillsOptions = {},
): {
  where: FindOptionsWhere<PortfolioSimFillEntity>;
  order: FindOptionsOrder<PortfolioSimFillEntity>;
} {
  const where: FindOptionsWhere<PortfolioSimFillEntity> = { runId };

  if (opts.status && VALID_FILL_STATUS.has(opts.status)) {
    where.status = opts.status as PortfolioSimFillEntity['status'];
  }

  if (opts.sourceLabel && opts.sourceLabel.trim() !== '') {
    where.sourceLabel = opts.sourceLabel.trim();
  }

  if (opts.skipReason && VALID_SKIP_REASONS.has(opts.skipReason)) {
    where.skipReason = opts.skipReason as PortfolioSimFillEntity['skipReason'];
  }

  const buyOp = dateRangeOp(opts.buyDateStart, opts.buyDateEnd);
  if (buyOp !== undefined) {
    (where as Record<string, unknown>).buyDate = buyOp;
  }

  const col = FILL_SORT_COLUMN_MAP[opts.sortField as keyof typeof FILL_SORT_COLUMN_MAP];
  const dir = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const order = (
    col ? { [col]: dir, id: 'ASC' } : { buyDate: 'ASC', id: 'ASC' }
  ) as FindOptionsOrder<PortfolioSimFillEntity>;

  return { where, order };
}
