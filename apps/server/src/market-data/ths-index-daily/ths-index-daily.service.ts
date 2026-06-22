import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  calcKdjSeries,
  isCustomKdjParams,
  roundKdjPoint,
} from '../../indicators/kdj';
import { ThsIndexDailyQueryDto } from './dto/query.dto';
import type { ThsIndexDailyKlineRow } from './ths-index-daily.types';

interface RawJoinedRow {
  tradeDate: string | null;
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
  volHand: string | number | null;
  ma5: string | number | null;
  ma30: string | number | null;
  ma60: string | number | null;
  ma120: string | number | null;
  ma240: string | number | null;
  dif: string | number | null;
  dea: string | number | null;
  macd: string | number | null;
  kdjK: string | number | null;
  kdjD: string | number | null;
  kdjJ: string | number | null;
  bbi: string | number | null;
  brick: string | number | null;
  brickDelta: string | number | null;
  brickXg: boolean | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class ThsIndexDailyService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 指数日线查询：quotes LEFT JOIN indicators by (ts_code, trade_date)，
   * 按 trade_date ASC 排序，返回 KlineChartBar 契约（与 a-shares getKlines 字段对齐子集）。
   *
   * 未同步指数 / 区间无数据 → 返回 []，由前端兜底空状态文案。
   */
  async getKlines(dto: ThsIndexDailyQueryDto): Promise<ThsIndexDailyKlineRow[]> {
    const rows = await this.dataSource.query<RawJoinedRow[]>(
      `
        SELECT
          q.trade_date AS "tradeDate",
          q.open       AS open,
          q.high       AS high,
          q.low        AS low,
          q.close      AS close,
          q.vol_hand   AS "volHand",
          i.ma5        AS ma5,
          i.ma30       AS ma30,
          i.ma60       AS ma60,
          i.ma120      AS ma120,
          i.ma240      AS ma240,
          i.dif        AS dif,
          i.dea        AS dea,
          i.macd       AS macd,
          i.kdj_k      AS "kdjK",
          i.kdj_d      AS "kdjD",
          i.kdj_j      AS "kdjJ",
          i.bbi        AS bbi,
          i.brick      AS brick,
          i.brick_delta AS "brickDelta",
          i.brick_xg    AS "brickXg"
        FROM index_daily_quotes q
        LEFT JOIN index_daily_indicators i
          ON i.ts_code = q.ts_code AND i.trade_date = q.trade_date
        WHERE q.category IN ('industry', 'concept')
          AND q.ts_code = $1
          AND q.trade_date >= $2
          AND q.trade_date <= $3
        ORDER BY q.trade_date ASC
      `,
      [dto.ts_code, dto.start_date, dto.end_date],
    );

    return rows.map((r) => {
      const brick = nullableNum(r.brick);
      const brickDelta = nullableNum(r.brickDelta);
      // 落库存「手」，输出转「股」以对齐 KlineChartBar.volume 单位
      const volume = num(r.volHand) * 100;
      return {
        open_time: String(r.tradeDate ?? ''),
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        close: num(r.close),
        volume,
        MA5: nullableNum(r.ma5),
        MA30: nullableNum(r.ma30),
        MA60: nullableNum(r.ma60),
        MA120: nullableNum(r.ma120),
        MA240: nullableNum(r.ma240),
        'KDJ.K': nullableNum(r.kdjK),
        'KDJ.D': nullableNum(r.kdjD),
        'KDJ.J': nullableNum(r.kdjJ),
        DIF: nullableNum(r.dif),
        DEA: nullableNum(r.dea),
        MACD: nullableNum(r.macd),
        BBI: nullableNum(r.bbi),
        brickChart:
          brick == null || brickDelta == null
            ? undefined
            : { brick, delta: brickDelta, xg: r.brickXg === true },
      };
    });
  }

  /**
   * 按自定义 KDJ 参数重新计算同花顺指数 K 线指标。
   *
   * - 复用 getKlines() 的查询结果（已按 trade_date ASC 排列）；
   * - 仅当 kdjParams 为有效自定义参数时，用 calcKdjSeries 重算 KDJ 序列；
   * - 其余字段（MA/MACD/BBI/brickChart 等）保持原值；
   * - 返回字段形状与 getKlines() 完全一致。
   */
  async recalcKlines(
    dto: ThsIndexDailyQueryDto,
    kdjParams?: { n: number; m1: number; m2: number },
  ): Promise<ThsIndexDailyKlineRow[]> {
    const rows = await this.getKlines(dto);

    if (!kdjParams || !isCustomKdjParams(kdjParams)) {
      return rows;
    }

    const kdjSeries = calcKdjSeries(
      rows.map((r) => ({ high: r.high, low: r.low, close: r.close })),
      kdjParams.n,
      kdjParams.m1,
      kdjParams.m2,
    );

    return rows.map((row, index) => {
      const kdj = roundKdjPoint(kdjSeries[index]);
      return {
        ...row,
        'KDJ.K': kdj.k,
        'KDJ.D': kdj.d,
        'KDJ.J': kdj.j,
      };
    });
  }

  /** 数据日期范围 min/max（用于前端同步面板提示） */
  async getDateRange(): Promise<{ min: string | null; max: string | null }> {
    const rows = await this.dataSource.query<Array<{ min: string | null; max: string | null }>>(`
      SELECT
        MIN(trade_date) AS min,
        MAX(trade_date) AS max
      FROM index_daily_quotes
      WHERE category IN ('industry', 'concept')
    `);
    return rows[0] ?? { min: null, max: null };
  }
}
