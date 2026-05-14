import { MacroCalendarService } from './macro-calendar.service';
import type { Repository } from 'typeorm';
import type { MacroEventEntity } from '../../../entities/macro-event/macro-event.entity';

/**
 * 构造带 find spy 的 Repository mock。
 * find 由调用方在每个 case 中 mockResolvedValueOnce / Implementation 提供数据。
 */
function createRepoMock(rows: Partial<MacroEventEntity>[] | Error) {
  const find = jest.fn();
  if (rows instanceof Error) find.mockRejectedValue(rows);
  else find.mockResolvedValue(rows as MacroEventEntity[]);
  const repo = { find } as unknown as Repository<MacroEventEntity>;
  return { repo, find };
}

function row(
  partial: Partial<MacroEventEntity> & { eventDate: string; title: string },
): Partial<MacroEventEntity> {
  return {
    id: `id-${partial.eventDate}-${partial.title}`,
    category: 'data',
    importance: 'high',
    eventTime: null,
    detail: null,
    sourceUrl: null,
    createdAt: new Date('2026-05-13T00:00:00Z'),
    updatedAt: new Date('2026-05-13T00:00:00Z'),
    ...partial,
  };
}

describe('MacroCalendarService', () => {
  const TRADE_DATE = '20260513'; // → 2026-05-13

  describe('正常返回 todayEvents + upcomingEvents', () => {
    it('当日按 eventTime ASC（NULL 排最后），未来 3 日按 eventDate ASC', async () => {
      const rows = [
        // tradeDate - 1（应被排除，落到 [tradeDate-1, tradeDate+3] 区间但既不属今日也不属 upcoming）
        row({ eventDate: '2026-05-12', title: '前一日事件', importance: 'high' }),

        // 当日 4 条（不同 eventTime，含 NULL）
        row({ eventDate: '2026-05-13', title: '收盘后宣讲', eventTime: '15:30:00', importance: 'high' }),
        row({ eventDate: '2026-05-13', title: '盘前央行公开市场', eventTime: '09:00:00', importance: 'high' }),
        row({ eventDate: '2026-05-13', title: '全天会议', eventTime: null, importance: 'mid' }),
        row({ eventDate: '2026-05-13', title: '盘中数据', eventTime: '10:30:00', importance: 'mid' }),

        // 未来 3 日（tradeDate+1 / +2 / +3）
        row({ eventDate: '2026-05-15', title: '社融数据', importance: 'high' }),
        row({ eventDate: '2026-05-14', title: '美 CPI', importance: 'high' }),
        row({ eventDate: '2026-05-16', title: '工业增加值', importance: 'mid' }),
      ];
      const { repo, find } = createRepoMock(rows);
      const svc = new MacroCalendarService(repo);

      const res = await svc.fetchToday(TRADE_DATE);

      // SQL 区间正确
      expect(find).toHaveBeenCalledTimes(1);
      const arg = find.mock.calls[0][0];
      expect(arg.where.eventDate._type).toBe('between');
      expect(arg.where.eventDate._value).toEqual(['2026-05-12', '2026-05-16']);
      expect(arg.order).toEqual({ eventDate: 'ASC', eventTime: 'ASC' });

      // todayEvents：NULL 排最后，其余按时间升序
      expect(res!.todayEvents).toEqual([
        { time: '09:00', event: '盘前央行公开市场', importance: 'high' },
        { time: '10:30', event: '盘中数据', importance: 'mid' },
        { time: '15:30', event: '收盘后宣讲', importance: 'high' },
        { time: '', event: '全天会议', importance: 'mid' },
      ]);

      // upcomingEvents：按 eventDate 升序，不含 tradeDate 本日，不含 tradeDate-1
      expect(res!.upcomingEvents).toEqual([
        { date: '2026-05-14', event: '美 CPI' },
        { date: '2026-05-15', event: '社融数据' },
        { date: '2026-05-16', event: '工业增加值' },
      ]);
    });
  });

  describe('空表返回 null', () => {
    it('find 返回空数组时返回 null 并 warn 标记 macro_calendar_empty', async () => {
      const { repo } = createRepoMock([]);
      const svc = new MacroCalendarService(repo);
      const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      const res = await svc.fetchToday(TRADE_DATE);

      expect(res).toBeNull();
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => m.includes('[macro_calendar_empty]') && m.includes('20260513'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('find 抛错时返回 null 并 warn 标记 macro_calendar_query_failed 含完整 params', async () => {
      const { repo } = createRepoMock(new Error('connection lost'));
      const svc = new MacroCalendarService(repo);
      const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      const res = await svc.fetchToday(TRADE_DATE);

      expect(res).toBeNull();
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        warnCalls.some(
          (m) =>
            m.includes('[macro_calendar_query_failed]') &&
            m.includes('connection lost') &&
            m.includes('20260513') &&
            m.includes('2026-05-12') &&
            m.includes('2026-05-16'),
        ),
      ).toBe(true);
      warnSpy.mockRestore();
    });
  });

  describe('importance 全 low 时回退到不过滤', () => {
    it('过滤后 < 3 时保留全部 low 事件', async () => {
      const rows = [
        row({ eventDate: '2026-05-13', title: '低级当日 A', eventTime: '09:00:00', importance: 'low' }),
        row({ eventDate: '2026-05-13', title: '低级当日 B', eventTime: '10:00:00', importance: 'low' }),
        row({ eventDate: '2026-05-14', title: '低级未来', importance: 'low' }),
      ];
      const { repo } = createRepoMock(rows);
      const svc = new MacroCalendarService(repo);

      const res = await svc.fetchToday(TRADE_DATE);

      // 不过滤情况下应包含全部 low 事件
      expect(res!.todayEvents.map((e) => e.event)).toEqual(['低级当日 A', '低级当日 B']);
      expect(res!.upcomingEvents.map((e) => e.event)).toEqual(['低级未来']);
    });

    it('过滤后 >= 3 时仍按过滤后的高/中级返回', async () => {
      const rows = [
        row({ eventDate: '2026-05-13', title: '高级当日 A', eventTime: '09:00:00', importance: 'high' }),
        row({ eventDate: '2026-05-13', title: '低级当日 B', eventTime: '10:00:00', importance: 'low' }),
        row({ eventDate: '2026-05-14', title: '高级未来 1', importance: 'high' }),
        row({ eventDate: '2026-05-15', title: '中级未来', importance: 'mid' }),
      ];
      const { repo } = createRepoMock(rows);
      const svc = new MacroCalendarService(repo);

      const res = await svc.fetchToday(TRADE_DATE);

      expect(res!.todayEvents.map((e) => e.event)).toEqual(['高级当日 A']);
      expect(res!.upcomingEvents.map((e) => e.event)).toEqual(['高级未来 1', '中级未来']);
    });
  });

  describe('tradeDate YYYYMMDD 转 Date 正确', () => {
    it('20260513 → 区间 [2026-05-12, 2026-05-16]，today=2026-05-13', async () => {
      const { repo, find } = createRepoMock([
        row({ eventDate: '2026-05-13', title: '今', importance: 'high' }),
      ]);
      const svc = new MacroCalendarService(repo);

      await svc.fetchToday('20260513');

      const arg = find.mock.calls[0][0];
      expect(arg.where.eventDate._value).toEqual(['2026-05-12', '2026-05-16']);
    });

    it('跨月边界 20260501 → [2026-04-30, 2026-05-04]', async () => {
      const { repo, find } = createRepoMock([
        row({ eventDate: '2026-05-01', title: '劳动节', importance: 'high' }),
      ]);
      const svc = new MacroCalendarService(repo);

      await svc.fetchToday('20260501');

      const arg = find.mock.calls[0][0];
      expect(arg.where.eventDate._value).toEqual(['2026-04-30', '2026-05-04']);
    });

    it('非 YYYYMMDD 格式直接返回 null 并 warn', async () => {
      const { repo, find } = createRepoMock([]);
      const svc = new MacroCalendarService(repo);
      const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      const res = await svc.fetchToday('2026-05-13'); // 含分隔符，非法

      expect(res).toBeNull();
      expect(find).not.toHaveBeenCalled();
      const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((m) => m.includes('[macro_calendar_invalid_tradeDate]'))).toBe(true);
      warnSpy.mockRestore();
    });
  });
});
