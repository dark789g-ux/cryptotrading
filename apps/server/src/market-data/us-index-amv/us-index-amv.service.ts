import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QuantJobsService } from '../../modules/quant/services/quant-jobs.service';
import type { ValidatedCreateJob } from '../../modules/quant/dto/create-job.dto';
import { asNullableNumber } from '../us-index-daily/utils/us-index-format.util';
import type { AmvSeriesRow, UsIndexAmvSyncBody } from './us-index-amv.types';

const YYYYMMDD_RE = /^\d{8}$/;

/** 裸 SQL 别名水合的原始行（SELECT 别名 → camelCase，数值列经 asNullableNumber 转换前的形态）。 */
interface RawAmvRow {
  tradeDate: string | null;
  amvOpen: string | number | null;
  amvHigh: string | number | null;
  amvLow: string | number | null;
  amvClose: string | number | null;
  amvDif: string | number | null;
  amvDea: string | number | null;
  amvMacd: string | number | null;
  amvZdf: string | number | null;
  signal: string | number | null;
  memberCount: string | number | null;
}

@Injectable()
export class UsIndexAmvService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly quantJobs: QuantJobsService,
  ) {}

  /**
   * 美股指数 AMV 序列查询：读 raw.us_index_amv_daily，按 trade_date ASC 返回 AmvSeriesRow[]。
   *
   * 未同步指数 / 区间无数据 → 返回 []，由前端兜底空状态。
   * 走裸 `dataSource.query`，**用 SELECT 别名水合**（"tradeDate"/"amvOpen".../"memberCount"），
   * 不走 QueryBuilder `.select()`（规避 .claude/rules/database-sql.md 的实体属性名水合坑）。
   * 数值列经 asNullableNumber 转 number/null；tradeDate 出参 YYYYMMDD（库内即此，不转横线）。
   */
  async getSeries(
    indexCode: string,
    startDate: string,
    endDate: string,
  ): Promise<AmvSeriesRow[]> {
    const rows = await this.dataSource.query<RawAmvRow[]>(
      `
        SELECT
          trade_date   AS "tradeDate",
          amv_open     AS "amvOpen",
          amv_high     AS "amvHigh",
          amv_low      AS "amvLow",
          amv_close    AS "amvClose",
          amv_dif      AS "amvDif",
          amv_dea      AS "amvDea",
          amv_macd     AS "amvMacd",
          amv_zdf      AS "amvZdf",
          signal       AS signal,
          member_count AS "memberCount"
        FROM raw.us_index_amv_daily
        WHERE index_code = $1
          AND trade_date >= $2
          AND trade_date <= $3
        ORDER BY trade_date ASC
      `,
      [indexCode, startDate, endDate],
    );

    return rows.map((r) => ({
      tradeDate: String(r.tradeDate ?? ''),
      amvOpen: asNullableNumber(r.amvOpen),
      amvHigh: asNullableNumber(r.amvHigh),
      amvLow: asNullableNumber(r.amvLow),
      amvClose: asNullableNumber(r.amvClose),
      amvDif: asNullableNumber(r.amvDif),
      amvDea: asNullableNumber(r.amvDea),
      amvMacd: asNullableNumber(r.amvMacd),
      amvZdf: asNullableNumber(r.amvZdf),
      signal: asNullableNumber(r.signal),
      memberCount: asNullableNumber(r.memberCount),
    }));
  }

  /** 指定指数的 AMV 数据日期范围 start/end（YYYYMMDD），空表返回 {start:null,end:null}。 */
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
        FROM raw.us_index_amv_daily
        WHERE index_code = $1
      `,
      [indexCode],
    );
    return rows[0] ?? { start: null, end: null };
  }

  /**
   * 派 us_index_amv_sync 作业（写一行 ml.jobs，复用 QuantJobsService.create）。
   *
   * us_index_amv_sync 不属 LABEL_REF / FEATURE_SET run_type，create() 直接落 pending，
   * 不展开 labelRef / 不校验 feature_set。
   *
   * ⚠️ params.date_range 存**冒号字符串** `'YYYYMMDD:YYYYMMDD'`（非数组！Python dispatcher
   * 严格要求冒号串），body 无 dateRange 则不设 date_range 键（worker 兜底全量）。
   */
  async sync(
    body: UsIndexAmvSyncBody,
    createdBy: string | null,
  ): Promise<{ jobId: string }> {
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
      runType: 'us_index_amv_sync',
      params,
      priority: 100,
      maxAttempts: 1,
    };
    const job = await this.quantJobs.create(dto, createdBy);
    return { jobId: job.id };
  }
}
