import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * 单个连续覆盖区间段（闭区间，trade_date 格式 YYYYMMDD）。
 *
 * "连续"定义：两个相邻 trade_date 在 raw.trade_cal 交易日序列中位置相邻
 * （即中间无其它 is_open=1 交易日）。
 * 这与 python 侧 coverage_ranges 口径一致：跨春节/长假但无遗漏交易日 → 不断段；
 * 中间真缺交易日 → 断段。
 */
export interface CoverageSegment {
  start: string; // YYYYMMDD
  end: string; // YYYYMMDD
}

/**
 * 已物化 feature_set 的列表项响应 DTO。
 *
 * snake_case 与 DB / 前端契约对齐（同 labels 模式）。
 */
export interface FeatureSetItem {
  feature_set_id: string;
  factor_version: string;
  scheme: string;
  new_listing_min_days: number;
  /** 命名标签人类可读名；label_id=NULL 则回退为 scheme */
  label_name: string;
  /** 标签版本（整数字符串）；label_id=NULL 则为 null */
  label_version: string | null;
  /** feature_matrix 里该 fs 的连续覆盖区间段列表，按 start ASC */
  coverage: CoverageSegment[];
}

/**
 * 把有序 trade_date 列表切割为连续区间段数组。
 *
 * @param tradeDates       已升序排列的交易日列表（YYYYMMDD），即 feature_matrix DISTINCT 值
 * @param tradingCalendar  覆盖 tradeDates 范围内所有 is_open=1 交易日（YYYYMMDD，升序），
 *                         来自 raw.trade_cal WHERE exchange='SSE' AND is_open=1
 *
 * 连续判定：设 d[i] 在 tradingCalendar 中的位置为 p[i]，若 p[i+1] - p[i] === 1
 * 则视为连续（相邻位置，中间无遗漏交易日）；否则断段。
 *
 * tradingCalendar 为空时所有日期在 calendarIndex 里都查不到位置（prevIdx/curIdx
 * 均 undefined）→ isConsecutive 恒 false → 退化为"每日各自断段"（每个 trade_date
 * 单独成段，保守口径）。实际调用方保证查 trade_cal 范围覆盖 tradeDates 最小/最大值
 * 之间，故正常路径不会落到此退化分支。
 *
 * 空 tradeDates → []；单元素 → [{start:d, end:d}]。
 */
export function splitIntoCoverageSegments(
  tradeDates: string[],
  tradingCalendar: string[],
): CoverageSegment[] {
  if (tradeDates.length === 0) return [];

  // 建立 date → index 映射，O(1) 查位置
  const calendarIndex = new Map<string, number>();
  for (let i = 0; i < tradingCalendar.length; i++) {
    calendarIndex.set(tradingCalendar[i], i);
  }

  const segments: CoverageSegment[] = [];
  let segStart = tradeDates[0];

  for (let i = 1; i < tradeDates.length; i++) {
    const prevDate = tradeDates[i - 1];
    const curDate = tradeDates[i];

    const prevIdx = calendarIndex.get(prevDate);
    const curIdx = calendarIndex.get(curDate);

    // 两者在 tradingCalendar 里位置差 > 1 → 中间有遗漏交易日 → 断段
    // 若某一方不在 calendar（数据异常），保守断段
    const isConsecutive =
      prevIdx !== undefined && curIdx !== undefined && curIdx - prevIdx === 1;

    if (!isConsecutive) {
      segments.push({ start: segStart, end: prevDate });
      segStart = curDate;
    }
  }

  // 封闭最后一段
  segments.push({ start: segStart, end: tradeDates[tradeDates.length - 1] });
  return segments;
}

/**
 * `GET /api/quant/feature-sets?materialized=true` 服务层。
 *
 * 仅返回 factors.feature_matrix 里有行的 feature_set，
 * 附 label_name（LEFT JOIN label_definitions；缺则回退 scheme）和覆盖区间段。
 *
 * 使用裸 DataSource.query() 访问 factors schema，
 * 规避 QueryBuilder `.select()` 属性名水合坑（见 .claude/rules/database-sql.md）。
 */
@Injectable()
export class QuantFeatureSetsService {
  private readonly logger = new Logger(QuantFeatureSetsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 列出有 feature_matrix 数据的 feature_set，每个附 label_name 和 coverage。
   *
   * SQL 说明：
   *  - `EXISTS (SELECT 1 FROM factors.feature_matrix ...)` 过滤仅有数据的 fs
   *  - `LEFT JOIN factors.label_definitions` 取 label name；NULL 则回退 scheme
   *  - 单独再查 coverage（feature_matrix DISTINCT trade_date per fs）
   *  - 再查 trade_cal 交易日序列用于精确判断连续性
   */
  async listMaterialized(): Promise<FeatureSetItem[]> {
    // Step 1: 查有物化数据的 feature_set，LEFT JOIN label_definitions 取 label_name
    const fsRows: Array<{
      feature_set_id: string;
      factor_version: string;
      scheme: string;
      new_listing_min_days: string | number;
      label_id: string | null;
      label_version: string | number | null;
      label_name: string | null;
    }> = await this.dataSource.query(`
      SELECT
        fs.feature_set_id,
        fs.factor_version,
        fs.scheme,
        fs.new_listing_min_days,
        fs.label_id,
        fs.label_version,
        ld.name AS label_name
      FROM factors.feature_sets fs
      LEFT JOIN factors.label_definitions ld
        ON fs.label_id = ld.label_id
        AND fs.label_version::text = ld.label_version
      WHERE EXISTS (
        SELECT 1 FROM factors.feature_matrix fm
        WHERE fm.feature_set_id = fs.feature_set_id
      )
      ORDER BY fs.created_at DESC
    `);

    if (fsRows.length === 0) {
      this.logger.warn('listMaterialized: no feature_sets with materialized feature_matrix rows');
      return [];
    }

    // Step 2: 批量查各 feature_set 的 coverage（DISTINCT trade_date）
    const fsIds = fsRows.map((r) => r.feature_set_id);

    const coverageRows: Array<{
      feature_set_id: string;
      trade_date: string;
    }> = await this.dataSource.query(
      `
      SELECT feature_set_id, trade_date
      FROM factors.feature_matrix
      WHERE feature_set_id = ANY($1::text[])
      GROUP BY feature_set_id, trade_date
      ORDER BY feature_set_id, trade_date ASC
    `,
      [fsIds],
    );

    // Step 3: 收集所有 trade_date，查 trade_cal 交易日序列
    const allDates = coverageRows.map((r) => r.trade_date);
    let tradingCalendar: string[] = [];

    if (allDates.length > 0) {
      const minDate = allDates.reduce((a, b) => (a < b ? a : b));
      const maxDate = allDates.reduce((a, b) => (a > b ? a : b));

      const calRows: Array<{ cal_date: string }> = await this.dataSource.query(
        `
        SELECT cal_date
        FROM raw.trade_cal
        WHERE exchange = 'SSE'
          AND is_open = 1
          AND cal_date BETWEEN $1 AND $2
        ORDER BY cal_date ASC
      `,
        [minDate, maxDate],
      );

      tradingCalendar = calRows.map((r) => r.cal_date);
    }

    // Step 4: 按 feature_set_id 分组 trade_date → 切段
    const coverageMap = new Map<string, string[]>();
    for (const row of coverageRows) {
      const list = coverageMap.get(row.feature_set_id) ?? [];
      list.push(row.trade_date);
      coverageMap.set(row.feature_set_id, list);
    }

    // Step 5: 组装响应
    return fsRows.map((fs) => {
      const dates = coverageMap.get(fs.feature_set_id) ?? [];
      const segments = splitIntoCoverageSegments(dates, tradingCalendar);

      // label_name 缺（label_id=NULL）→ 回退 scheme
      const labelName = fs.label_name ?? fs.scheme;
      // label_version 为整数列，PG 返回 string | number；统一转字符串展示
      const labelVersionStr =
        fs.label_id != null && fs.label_version != null ? String(fs.label_version) : null;

      return {
        feature_set_id: fs.feature_set_id,
        factor_version: fs.factor_version,
        scheme: fs.scheme,
        new_listing_min_days: Number(fs.new_listing_min_days),
        label_name: labelName,
        label_version: labelVersionStr,
        coverage: segments,
      };
    });
  }

  /**
   * 查询单个 feature_set 的连续覆盖区间段。
   *
   * 供 QuantJobsService（S7 任务）在建 train/optuna/seed_avg job 时
   * 校验 date_range 不超出 R_F 边界且无空洞。
   *
   * 连续性判断使用 raw.trade_cal 交易日序列（exchange='SSE'），与 python 侧口径一致。
   */
  async coverage(featureSetId: string): Promise<CoverageSegment[]> {
    const rows: Array<{ trade_date: string }> = await this.dataSource.query(
      `
      SELECT DISTINCT trade_date
      FROM factors.feature_matrix
      WHERE feature_set_id = $1
      ORDER BY trade_date ASC
    `,
      [featureSetId],
    );

    if (rows.length === 0) {
      this.logger.warn(
        `coverage: feature_set_id=${featureSetId} has no rows in feature_matrix`,
      );
      return [];
    }

    const tradeDates = rows.map((r) => r.trade_date);
    const minDate = tradeDates[0];
    const maxDate = tradeDates[tradeDates.length - 1];

    // 查 trade_cal 交易日序列，用于精确判断连续性（口径与 python 侧一致）
    const calRows: Array<{ cal_date: string }> = await this.dataSource.query(
      `
      SELECT cal_date
      FROM raw.trade_cal
      WHERE exchange = 'SSE'
        AND is_open = 1
        AND cal_date BETWEEN $1 AND $2
      ORDER BY cal_date ASC
    `,
      [minDate, maxDate],
    );

    const tradingCalendar = calRows.map((r) => r.cal_date);
    return splitIntoCoverageSegments(tradeDates, tradingCalendar);
  }
}
