import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { calcKdjSeries, isCustomKdjParams, roundKdjPoint } from '../../indicators/kdj';
import { QuantJobsService } from '../../modules/quant/services/quant-jobs.service';
import type { ValidatedCreateJob } from '../../modules/quant/dto/create-job.dto';
import {
  asNullableNumber,
  asNumber,
  formatTradeDateLabel,
} from './utils/us-index-format.util';
import type { UsIndexKlineRow, UsIndexSyncBody } from './us-index-daily.types';

const YYYYMMDD_RE = /^\d{8}$/;

interface RawJoinedRow {
  tradeDate: string | null;
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
  volume: string | number | null;
  ma5: string | number | null;
  ma30: string | number | null;
  ma60: string | number | null;
  ma120: string | number | null;
  ma240: string | number | null;
  bbi: string | number | null;
  kdjK: string | number | null;
  kdjD: string | number | null;
  kdjJ: string | number | null;
  dif: string | number | null;
  dea: string | number | null;
  macd: string | number | null;
}

@Injectable()
export class UsIndexDailyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly quantJobs: QuantJobsService,
  ) {}

  /**
   * 美股指数日线查询：quotes LEFT JOIN indicators by (index_code, trade_date)，
   * 按 trade_date ASC 排序，返回 KlineChartBar 契约子集。
   *
   * 未同步指数 / 区间无数据 → 返回 []，由前端兜底空状态文案。
   * 走 raw `dataSource.query`（不走 QueryBuilder `.select()`），列名与 raw.us_index_* DDL 字面一致。
   */
  async getKlines(
    indexCode: string,
    startDate: string,
    endDate: string,
  ): Promise<UsIndexKlineRow[]> {
    const rows = await this.dataSource.query<RawJoinedRow[]>(
      `
        SELECT
          q.trade_date AS "tradeDate",
          q.open       AS open,
          q.high       AS high,
          q.low        AS low,
          q.close      AS close,
          q.volume     AS volume,
          i.ma5        AS ma5,
          i.ma30       AS ma30,
          i.ma60       AS ma60,
          i.ma120      AS ma120,
          i.ma240      AS ma240,
          i.bbi        AS bbi,
          i.kdj_k      AS "kdjK",
          i.kdj_d      AS "kdjD",
          i.kdj_j      AS "kdjJ",
          i.dif        AS dif,
          i.dea        AS dea,
          i.macd       AS macd
        FROM raw.us_index_daily q
        LEFT JOIN raw.us_index_indicator i
          ON i.index_code = q.index_code AND i.trade_date = q.trade_date
        WHERE q.index_code = $1
          AND q.trade_date >= $2
          AND q.trade_date <= $3
        ORDER BY q.trade_date ASC
      `,
      [indexCode, startDate, endDate],
    );

    return rows.map((r) => ({
      open_time: formatTradeDateLabel(String(r.tradeDate ?? '')),
      open: asNumber(r.open),
      high: asNumber(r.high),
      low: asNumber(r.low),
      close: asNumber(r.close),
      volume: asNumber(r.volume),
      MA5: asNullableNumber(r.ma5),
      MA30: asNullableNumber(r.ma30),
      MA60: asNullableNumber(r.ma60),
      MA120: asNullableNumber(r.ma120),
      MA240: asNullableNumber(r.ma240),
      'KDJ.K': asNullableNumber(r.kdjK),
      'KDJ.D': asNullableNumber(r.kdjD),
      'KDJ.J': asNullableNumber(r.kdjJ),
      DIF: asNullableNumber(r.dif),
      DEA: asNullableNumber(r.dea),
      MACD: asNullableNumber(r.macd),
      BBI: asNullableNumber(r.bbi),
    }));
  }

  /**
   * 按自定义 KDJ 参数重新计算美股指数 K 线指标。
   *
   * - 复用 getKlines() 的查询结果（已按 trade_date ASC 排列）；
   * - 仅当 kdjParams 为有效自定义参数时，用 calcKdjSeries 重算 KDJ 序列；
   * - 其余字段（MA/MACD/BBI 等）保持原值；
   * - 返回字段形状与 getKlines() 完全一致。
   */
  async recalcKlines(
    indexCode: string,
    query: { startDate: string; endDate: string },
    kdjParams?: { n: number; m1: number; m2: number },
  ): Promise<UsIndexKlineRow[]> {
    const rows = await this.getKlines(indexCode, query.startDate, query.endDate);

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

  /** 指定指数的数据日期范围 start/end（YYYYMMDD），空表返回 {start:null,end:null}。 */
  async getDateRange(
    indexCode: string,
  ): Promise<{ start: string | null; end: string | null }> {
    const rows = await this.dataSource.query<
      Array<{ start: string | null; end: string | null }>
    >(
      `
        SELECT
          MIN(trade_date) AS start,
          MAX(trade_date) AS end
        FROM raw.us_index_daily
        WHERE index_code = $1
      `,
      [indexCode],
    );
    return rows[0] ?? { start: null, end: null };
  }

  /**
   * 派 us_index_sync 作业（写一行 ml.jobs，复用 QuantJobsService.create）。
   *
   * us_index_sync 不属 LABEL_REF / FEATURE_SET run_type，create() 不展开 labelRef / 不校验
   * feature_set，直接落 pending。
   *
   * ⚠️ params.date_range 存**冒号字符串** `'YYYYMMDD:YYYYMMDD'`（非数组！Python `_runner_us_sync`
   * 严格要求冒号串），body 无 dateRange 则不设 date_range 键（worker 兜底全量）。
   */
  async sync(body: UsIndexSyncBody, createdBy: string | null): Promise<{ jobId: string }> {
    const params: Record<string, unknown> = {};

    if (body?.dateRange !== undefined) {
      const range = body.dateRange;
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !YYYYMMDD_RE.test(range[0]) ||
        !YYYYMMDD_RE.test(range[1])
      ) {
        throw new BadRequestException('dateRange 必须是 [YYYYMMDD, YYYYMMDD] 二元组');
      }
      if (range[0] > range[1]) {
        throw new BadRequestException(`dateRange 起始 ${range[0]} 不得晚于结束 ${range[1]}`);
      }
      params.date_range = `${range[0]}:${range[1]}`;
    }

    if (body?.symbols !== undefined) {
      if (
        !Array.isArray(body.symbols) ||
        body.symbols.some((s) => typeof s !== 'string' || s === '')
      ) {
        throw new BadRequestException('symbols 必须是非空字符串数组');
      }
      params.symbols = body.symbols;
    }

    const dto: ValidatedCreateJob = {
      runType: 'us_index_sync',
      params,
      priority: 100,
      maxAttempts: 1,
    };
    const job = await this.quantJobs.create(dto, createdBy);
    return { jobId: job.id };
  }
}
