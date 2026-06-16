/**
 * 美股指数日线只读查询 + 同步触发层 DTO 与行模型。
 *
 * 镜像 ths-index-daily（只读 raw SQL + date-range）与 us-stocks（POST /sync 派 job）。
 * 见 spec 2026-06-16-us-index-subtab-design/02。
 */

/** `GET /api/us-index-daily` query 入参（三参必填，controller 校验）。 */
export interface UsIndexQueryParams {
  index_code?: string;
  start_date?: string;
  end_date?: string;
}

/** `POST /api/us-index-daily/sync` 请求体（写 ml.jobs run_type='us_index_sync'）。 */
export interface UsIndexSyncBody {
  /** [startDate, endDate]，YYYYMMDD；缺省时由 Python 侧用默认全量区间 */
  dateRange?: [string, string];
  /** 限定同步的 index_code 列表；缺省时 worker 默认 ('.NDX',) */
  symbols?: string[];
}

/** getKlines 返回行（KlineChartBar 子集，照 ths-index-daily.service 输出形状）。 */
export interface UsIndexKlineRow {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  MA5: number | null;
  MA30: number | null;
  MA60: number | null;
  MA120: number | null;
  MA240: number | null;
  'KDJ.K': number | null;
  'KDJ.D': number | null;
  'KDJ.J': number | null;
  DIF: number | null;
  DEA: number | null;
  MACD: number | null;
  BBI: number | null;
}
