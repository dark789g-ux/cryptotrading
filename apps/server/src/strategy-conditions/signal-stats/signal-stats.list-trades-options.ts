/**
 * signal-stats.list-trades-options.ts
 *
 * 纯函数：将前端 opts（已解析数值）转换为 TypeORM findAndCount 所需的
 * { where, order } 对象，供 service.listTrades 使用。
 *
 * 设计为纯函数，便于不依赖 DB 的单元测试。
 */
import {
  FindOptionsOrder,
  FindOptionsWhere,
  Between,
  MoreThanOrEqual,
  LessThanOrEqual,
  ILike,
} from 'typeorm';
import { SignalTestTradeEntity } from '../../entities/strategy/signal-test-trade.entity';

// ── 类型定义 ─────────────────────────────────────────────────────────────────

/** listTrades 可接受的过滤/排序选项（数值字段已解析为 number） */
export interface ListTradesOptions {
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  tsCode?: string;
  exitReason?: string;
  retMin?: number;
  retMax?: number;
  holdDaysMin?: number;
  holdDaysMax?: number;
}

// ── 白名单 ────────────────────────────────────────────────────────────────────

/**
 * 前端排序 key → 实体属性名映射（白名单）。
 * 禁止裸拼字段名；凡不在此表中的 sortField 回落默认排序。
 */
export const SORT_COLUMN_MAP = {
  tsCode: 'tsCode',
  signalDate: 'signalDate',
  buyDate: 'buyDate',
  exitDate: 'exitDate',
  buyPrice: 'buyPrice',
  exitPrice: 'exitPrice',
  ret: 'ret',
  holdDays: 'holdDays',
  exitReason: 'exitReason',
} as const;

/** 出场原因精确匹配白名单（来自实体定义，禁止外部任意值直接写入 where） */
export const VALID_EXIT_REASONS = new Set<string>([
  'max_hold',
  'signal',
  'delist',
  'stop',
  'ma5_exit',
  'phase_lock_stop',
  'phase_lock_ma5',
]);

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 将 (min?, max?) 转换为 TypeORM range operator。
 * - 两边均有 → Between(min, max)
 * - 仅 min → MoreThanOrEqual(min)
 * - 仅 max → LessThanOrEqual(max)
 * - 均无  → undefined（不设该字段过滤）
 *
 * 注意：ret 列是 numeric，TypeORM 比较时 Postgres 会把 JS number 隐式转为 numeric，
 * 无需显式转换（经官方文档 + 实践确认）。
 */
export function rangeOp(
  min: number | undefined,
  max: number | undefined,
): ReturnType<typeof Between> | ReturnType<typeof MoreThanOrEqual> | ReturnType<typeof LessThanOrEqual> | undefined {
  const hasMin = min !== undefined && !isNaN(min);
  const hasMax = max !== undefined && !isNaN(max);
  if (hasMin && hasMax) return Between(min!, max!);
  if (hasMin) return MoreThanOrEqual(min!);
  if (hasMax) return LessThanOrEqual(max!);
  return undefined;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * buildTradeListOptions：纯函数，输入 runId + 用户选项，返回 TypeORM findAndCount 参数。
 *
 * @param runId  run 主键
 * @param opts   前端已解析的查询选项（数值字段为 number|undefined）
 * @returns      { where, order }，可直接展开到 findAndCount 第一参数
 */
export function buildTradeListOptions(
  runId: string,
  opts: ListTradesOptions = {},
): {
  where: FindOptionsWhere<SignalTestTradeEntity>;
  order: FindOptionsOrder<SignalTestTradeEntity>;
} {
  // ── where ────────────────────────────────────────────────────────────────

  const where: FindOptionsWhere<SignalTestTradeEntity> = { runId };

  if (opts.tsCode && opts.tsCode.trim()) {
    where.tsCode = ILike(`%${opts.tsCode.trim()}%`);
  }

  if (opts.exitReason && VALID_EXIT_REASONS.has(opts.exitReason)) {
    // 已通过白名单校验，安全写入
    where.exitReason = opts.exitReason as SignalTestTradeEntity['exitReason'];
  }

  const retOp = rangeOp(opts.retMin, opts.retMax);
  if (retOp !== undefined) {
    // ret 列 numeric → TypeORM 以 string 存储，但 Between/MGTE/LTE 的数值参数
    // Postgres 会隐式转换；此处按 any 注入以跳过 TS 类型收窄
    (where as Record<string, unknown>).ret = retOp;
  }

  const holdOp = rangeOp(opts.holdDaysMin, opts.holdDaysMax);
  if (holdOp !== undefined) {
    (where as Record<string, unknown>).holdDays = holdOp;
  }

  // ── order ────────────────────────────────────────────────────────────────

  const col = SORT_COLUMN_MAP[opts.sortField as keyof typeof SORT_COLUMN_MAP];
  const dir = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

  const order = (
    col
      ? { [col]: dir, id: 'ASC' }
      : { signalDate: 'ASC', tsCode: 'ASC', id: 'ASC' }
  ) as FindOptionsOrder<SignalTestTradeEntity>;

  return { where, order };
}
