/**
 * 美股指数活跃市值（AMV）只读查询 + 同步触发层 DTO 与行模型。
 *
 * 镜像 us-index-daily（只读 raw SQL + date-range + POST /sync 派 job）。
 * 见 spec 2026-06-16-us-index-amv-design/05-nestjs-and-api.md。
 */

/** `GET /api/us-index-amv` query 入参（index_code 必填，start/end 须 YYYYMMDD，controller 校验）。 */
export interface UsIndexAmvQueryParams {
  index_code?: string;
  start_date?: string;
  end_date?: string;
}

/** `POST /api/us-index-amv/sync` 请求体（写 ml.jobs run_type='us_index_amv_sync'）。 */
export interface UsIndexAmvSyncBody {
  /** [startDate, endDate]，YYYYMMDD；缺省时由 Python dispatcher 兜底全量 */
  dateRange?: [string, string];
  /** 限定同步的成分股 ticker 列表；缺省时 worker 默认全量 .NDX 成分 */
  symbols?: string[];
}

/**
 * getSeries 返回行。
 *
 * 与前端 `active-mv.ts` 的 `AmvSeriesRow`（[active-mv.ts:18-32]）结构同构，前端 `usIndexAmv.ts`
 * 复用该类型；后端这里把可空列声明为 `number | null`（裸 SQL 经 asNullableNumber 水合，
 * 库内可空），前端读时按 number 用，实际落库行 amv_close 恒非空。
 *
 * `tradeDate` 为 `YYYYMMDD`（库内即此格式，不转 YYYY-MM-DD；前端 normalizeDateKey 去横线对齐）。
 */
export interface AmvSeriesRow {
  /** 'YYYYMMDD'（库内即此格式，不转 YYYY-MM-DD） */
  tradeDate: string;
  amvOpen: number | null;
  amvHigh: number | null;
  amvLow: number | null;
  amvClose: number | null;
  amvDif: number | null;
  amvDea: number | null;
  amvMacd: number | null;
  amvZdf: number | null;
  /** 三态信号：多头 +1 / 中性 0 / 空头 -1（NOT NULL） */
  signal: number | null;
  /** 当日有效成分数 */
  memberCount: number | null;
}
