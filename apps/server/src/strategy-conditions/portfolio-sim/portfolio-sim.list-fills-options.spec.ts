/**
 * portfolio-sim.list-fills-options.spec.ts
 *
 * fills 列表选项纯函数单测：排序白名单、状态/原因白名单、买入日 range、默认排序。
 */
import {
  buildFillListOptions,
  isValidFillSortField,
  dateRangeOp,
  FILL_SORT_COLUMN_MAP,
  VALID_SKIP_REASONS,
} from './portfolio-sim.list-fills-options';
import { Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';

describe('isValidFillSortField', () => {
  it('未提供 / 空串 → 合法（回落默认）', () => {
    expect(isValidFillSortField(undefined)).toBe(true);
    expect(isValidFillSortField('')).toBe(true);
  });

  it('白名单内 → 合法', () => {
    for (const key of Object.keys(FILL_SORT_COLUMN_MAP)) {
      expect(isValidFillSortField(key)).toBe(true);
    }
  });

  it('未知列 → 非法', () => {
    expect(isValidFillSortField('drop_table')).toBe(false);
    expect(isValidFillSortField('id')).toBe(false); // id 不在白名单
  });
});

describe('dateRangeOp', () => {
  it('两端 → Between', () => {
    const op = dateRangeOp('20240101', '20240131');
    expect(op).toEqual(Between('20240101', '20240131'));
  });
  it('仅起 → MoreThanOrEqual', () => {
    expect(dateRangeOp('20240101', undefined)).toEqual(MoreThanOrEqual('20240101'));
  });
  it('仅止 → LessThanOrEqual', () => {
    expect(dateRangeOp(undefined, '20240131')).toEqual(LessThanOrEqual('20240131'));
  });
  it('均无 → undefined', () => {
    expect(dateRangeOp(undefined, undefined)).toBeUndefined();
    expect(dateRangeOp('', '')).toBeUndefined();
  });
});

describe('buildFillListOptions', () => {
  it('默认（无 opts）→ where 仅 runId，order 默认 buyDate ASC', () => {
    const { where, order } = buildFillListOptions('run-1');
    expect(where).toEqual({ runId: 'run-1' });
    expect(order).toEqual({ buyDate: 'ASC', id: 'ASC' });
  });

  it('status 白名单内写入；非法忽略', () => {
    expect(buildFillListOptions('r', { status: 'taken' }).where).toMatchObject({
      status: 'taken',
    });
    expect(buildFillListOptions('r', { status: 'bogus' }).where).toEqual({ runId: 'r' });
  });

  it('skipReason 白名单内写入；非法忽略', () => {
    expect(buildFillListOptions('r', { skipReason: 'cash_short' }).where).toMatchObject({
      skipReason: 'cash_short',
    });
    expect(buildFillListOptions('r', { skipReason: 'nope' }).where).toEqual({ runId: 'r' });
  });

  it('Phase 2/3 新增 skipReason（cooldown / drawdown_halt / sized_out）按原因筛选命中', () => {
    for (const reason of ['cooldown', 'drawdown_halt', 'sized_out']) {
      expect(buildFillListOptions('r', { skipReason: reason }).where).toMatchObject({
        skipReason: reason,
      });
    }
  });

  it('VALID_SKIP_REASONS 含全部 4 旧 + 3 新原因（与引擎 SkipReason 对齐）', () => {
    for (const reason of [
      'already_held',
      'slots_full',
      'exposure_cap',
      'cash_short',
      'cooldown',
      'drawdown_halt',
      'sized_out',
    ]) {
      expect(VALID_SKIP_REASONS.has(reason)).toBe(true);
    }
  });

  it('sourceLabel 精确写入（trim）', () => {
    expect(buildFillListOptions('r', { sourceLabel: ' 策略A ' }).where).toMatchObject({
      sourceLabel: '策略A',
    });
  });

  it('buyDate range → where.buyDate Between', () => {
    const { where } = buildFillListOptions('r', {
      buyDateStart: '20240101',
      buyDateEnd: '20240201',
    });
    expect((where as Record<string, unknown>).buyDate).toEqual(
      Between('20240101', '20240201'),
    );
  });

  it('合法 sortField → 翻译为实体属性名 + 方向 + id 兜底', () => {
    const { order } = buildFillListOptions('r', {
      sortField: 'realizedRetNet',
      sortOrder: 'desc',
    });
    expect(order).toEqual({ realizedRetNet: 'DESC', id: 'ASC' });
  });

  it('未知 sortField → 回落默认排序（防裸拼）', () => {
    const { order } = buildFillListOptions('r', { sortField: 'evil; DROP' });
    expect(order).toEqual({ buyDate: 'ASC', id: 'ASC' });
  });
});
