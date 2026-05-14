import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { MacroEventEntity } from '../../../entities/macro-event/macro-event.entity';
import type { MacroCalendarPayload } from '../../types/daily-review.types';

/**
 * MacroCalendarService（spec § 4.2 / § 4.3 / § 7 T3）
 *
 * 从 macro_events 表读取「今日 + 未来三日」宏观事件，供 Stage0 snapshot.macroCalendar 使用。
 *
 * 关键约束（CLAUDE.md）：
 * - tradeDate 为 Tushare 标准 YYYYMMDD，禁止 `new Date(tradeDate)` 直接解析，
 *   必须先拼分隔符：`new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`)`。
 * - 第三方/DB 返回空必须 logger.warn 含完整 SQL params（区分「表为空」与「该日无事件」）。
 * - PG `time` 列在 TypeORM 中以字符串 'HH:MM:SS' 返回，截前 5 字符为 'HH:MM'。
 * - PG `date` 列在 TypeORM 中以字符串 'YYYY-MM-DD' 返回（不是 Date）；SQL 比较直接用字符串即可。
 */
@Injectable()
export class MacroCalendarService {
  private readonly logger = new Logger(MacroCalendarService.name);

  constructor(
    @InjectRepository(MacroEventEntity)
    private readonly repo: Repository<MacroEventEntity>,
  ) {}

  /**
   * @param tradeDate Tushare 标准 YYYYMMDD（如 '20260513'）
   * @returns 查询失败或表内无任何当日 + 未来三日事件时返回 null，让 SnapshotBuilder 跳过
   */
  async fetchToday(tradeDate: string): Promise<MacroCalendarPayload | null> {
    if (!/^\d{8}$/.test(tradeDate)) {
      this.logger.warn(`[macro_calendar_invalid_tradeDate] tradeDate=${tradeDate} 非 YYYYMMDD 格式，返回 null`);
      return null;
    }

    // 按 CLAUDE.md 规范转 Date：用于安全派生 [tradeDate-1, tradeDate+3] 区间
    const baseDate = this.parseTradeDate(tradeDate);
    const startDateStr = this.shiftDate(baseDate, -1); // tradeDate - 1
    const endDateStr = this.shiftDate(baseDate, 3); // tradeDate + 3
    const todayDateStr = this.toIsoDate(baseDate); // tradeDate
    const upcomingStartStr = this.shiftDate(baseDate, 1); // tradeDate + 1

    let rows: MacroEventEntity[];
    try {
      // 一次性查询 [tradeDate-1, tradeDate+3] 区间内全部事件，避免两次 round trip
      rows = await this.repo.find({
        where: { eventDate: Between(startDateStr, endDateStr) },
        order: { eventDate: 'ASC', eventTime: 'ASC' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[macro_calendar_query_failed] params=${JSON.stringify({
          start: startDateStr,
          end: endDateStr,
          tradeDate,
        })} err=${message}`,
      );
      return null;
    }

    if (!rows || rows.length === 0) {
      this.logger.warn(
        `[macro_calendar_empty] macro_events 表内 [${startDateStr}, ${endDateStr}] 区间无任何事件 ` +
          `params=${JSON.stringify({ tradeDate, start: startDateStr, end: endDateStr })}`,
      );
      return null;
    }

    // 当日 / 未来三日 (tradeDate, tradeDate+3] 分桶
    const todayRaw = rows.filter((r) => r.eventDate === todayDateStr);
    const upcomingRaw = rows.filter(
      (r) => r.eventDate >= upcomingStartStr && r.eventDate <= endDateStr,
    );

    // importance ≠ 'low' 过滤；过滤后总数 < 3 时回退到不过滤
    const filteredToday = todayRaw.filter((r) => r.importance !== 'low');
    const filteredUpcoming = upcomingRaw.filter((r) => r.importance !== 'low');
    const useFiltered = filteredToday.length + filteredUpcoming.length >= 3;
    const todaySource = useFiltered ? filteredToday : todayRaw;
    const upcomingSource = useFiltered ? filteredUpcoming : upcomingRaw;

    // todayEvents 内部已按 eventTime ASC 排序（IsNull-last 通过 sort 显式保证；
    // PG ORDER BY 默认 NULLS LAST in ASC，但保险起见这里再 stable sort 一次）
    const todaySorted = [...todaySource].sort((a, b) => this.compareTime(a.eventTime, b.eventTime));

    const todayEvents = todaySorted.map((r) => ({
      time: this.formatTime(r.eventTime),
      event: r.title,
      importance: r.importance,
    }));

    // 显式按 eventDate ASC 排序（SQL ORDER BY 已做一次，这里再保险一遍——
    // 同时让单测在 mock 不模拟 SQL 排序的情况下也能稳定通过）
    const upcomingSorted = [...upcomingSource].sort((a, b) => a.eventDate.localeCompare(b.eventDate));

    const upcomingEvents = upcomingSorted.map((r) => ({
      date: r.eventDate, // TypeORM `date` 列已是 'YYYY-MM-DD' 字符串
      event: r.title,
    }));

    return { todayEvents, upcomingEvents };
  }

  /** YYYYMMDD → Date（UTC 当日 00:00:00） */
  private parseTradeDate(s: string): Date {
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  }

  /** Date 偏移 days 天后输出 'YYYY-MM-DD'（UTC） */
  private shiftDate(base: Date, days: number): string {
    const next = new Date(base.getTime() + days * 86400000);
    return this.toIsoDate(next);
  }

  /** Date → 'YYYY-MM-DD'（UTC） */
  private toIsoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** PG time 列 'HH:MM:SS' → 'HH:MM'；NULL → '' */
  private formatTime(t: string | null): string {
    if (!t) return '';
    // 兼容 'HH:MM:SS' / 'HH:MM:SS.ffffff' / 'HH:MM' 三种形态
    return t.length >= 5 ? t.slice(0, 5) : t;
  }

  /** eventTime NULL 排最后；非空按字典序（'HH:MM:SS' 本身字典序即时间序） */
  private compareTime(a: string | null, b: string | null): number {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return a.localeCompare(b);
  }
}