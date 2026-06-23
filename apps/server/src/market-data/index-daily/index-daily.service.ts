import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
import { QueryLatestDto, IndexLatestSortField } from './dto/latest.dto';
import { QueryKlineDto } from './dto/kline.dto';
import type {
  IndexDailyKlineRow,
  IndexLatestResult,
  IndexLatestRow,
} from './index-daily.types';

/**
 * sort 字段白名单：前端字段 → 子查询别名（database-sql.md：禁直接拼前端字段名）。
 * 外层 ORDER BY 用别名（双引号），子查询内已用 AS "xxx" 命名。
 */
const SORT_COL_MAP: Record<IndexLatestSortField, string> = {
  pct_change: '"pctChange"',
  vol: '"vol"',
  amount: 'amount',
  total_mv_wan: '"totalMvWan"',
  tradeDate: '"tradeDate"',
  pe: 'pe',
  pb: 'pb',
};

interface LatestRawRow {
  tsCode: string;
  name: string | null;
  category: string;
  tradeDate: string | null;
  close: string | number | null;
  pctChange: string | number | null;
  vol: string | number | null;
  amount: string | number | null;
  totalMvWan: string | null;
  pe: string | number | null;
  pb: string | number | null;
}

interface KlineRawRow {
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

/**
 * 统一 A 股指数日线查询（大盘 + 行业 + 概念，全 category）。
 * spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md【后端>接口清单】
 *
 * 与 ThsIndexDailyService 的区别：本 service 查全 category（行情表/K线给「A 股指数」tab）；
 * 旧 /ths-index-daily 路径薄封装仅 industry/concept（防大盘泄漏 money-flow）。
 * 用 DataSource raw SQL 规避 QueryBuilder .select() 水合坑（database-sql.md）。
 */
@Injectable()
export class IndexDailyService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SwIndexCatalogEntity)
    private readonly swCatalogRepo: Repository<SwIndexCatalogEntity>,
  ) {}

  /**
   * 行情表最新行情：每个指数取最新一行（DISTINCT ON ts_code），支持类型筛选/模糊搜索/排序/分页。
   *
   * name 来源：同花顺走 ths_index_catalog（c.name），申万走 sw_index_catalog（s.name），
   * COALESCE(c.name, s.name) 统一取。申万 tsCode 不在 ths_index_catalog，须靠 s 兜底。
   * level 仅对 type='sw' 生效：先查 sw_index_catalog 拿该层 tsCode + name 集合，
   * 再用 ANY($tsCodes) 收敛（避免 JOIN sw_index_catalog 后 DISTINCT ON ts_code 与分页交互复杂）。
   */
  async getLatest(dto: QueryLatestDto): Promise<IndexLatestResult> {
    const category = dto.type ?? null;
    const q = dto.q && dto.q.trim() ? dto.q.trim() : null;
    const sortField: IndexLatestSortField = dto.sort ?? 'pct_change';
    const order = dto.order === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Number(dto.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(dto.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;
    const sortCol = SORT_COL_MAP[sortField] ?? SORT_COL_MAP.pct_change;
    const orderExpr = `${sortCol} ${order} NULLS LAST`;

    // 申万按 level 过滤：name 也在此表，一并取回避免 JOIN。
    const isSw = category === 'sw';
    const swLevel: number | null =
      isSw && (dto.level === 1 || dto.level === 2 || dto.level === 3)
        ? dto.level
        : null;
    let swTsCodes: string[] | null = null;
    if (isSw) {
      const swRows = await this.swCatalogRepo.find({
        where: swLevel == null ? {} : { level: swLevel as 1 | 2 | 3 },
        select: ['tsCode', 'name'],
      });
      swTsCodes = swRows.map((r) => r.tsCode);
      // level 过滤下命中 0 个目录项 → 直接返回空（避免 ANY('{}') 退化成「全表」陷阱）
      if (swLevel != null && swTsCodes.length === 0) {
        return { rows: [], total: 0 };
      }
    }

    // 动态拼 WHERE：$1=category、$2=q 始终在前；sw 分支在末尾追加 ts_code 收敛（占位符位置随查询变）。
    // name 搜索：sw 走 s.name、其它走 c.name（申万 tsCode 不在 ths_index_catalog）。
    const swNameCol = isSw ? 's.name' : 'c.name';
    // sw 无目录项命中（仅 type='sw' 且 catalog 为空）→ 用 AND FALSE 短路返回 0 行
    const swNoMatch = isSw && (!swTsCodes || swTsCodes.length === 0);
    const nameClause = `($2::text IS NULL OR ${swNameCol} ILIKE '%' || $2 || '%')`;
    const categoryClause = `($1::text IS NULL OR q.category = $1)`;
    // tsCodes 收敛片段：count 查询放 $3，rows 查询放 $5（$3/$4 留给 LIMIT/OFFSET）
    const tsClauseFor = (pos: number) =>
      isSw && swTsCodes && swTsCodes.length > 0
        ? ` AND q.ts_code = ANY($${pos}::text[])`
        : swNoMatch
          ? ' AND FALSE'
          : '';
    const whereCore = `${categoryClause} AND ${nameClause}`;

    const totalRows = await this.dataSource.query<Array<{ total: string }>>(
      `SELECT COUNT(DISTINCT q.ts_code)::text AS total
         FROM index_daily_quotes q
         LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code
         LEFT JOIN sw_index_catalog s ON s.ts_code = q.ts_code
        WHERE ${whereCore}${tsClauseFor(3)}`,
      [category, q, ...(isSw && swTsCodes && swTsCodes.length > 0 ? [swTsCodes] : [])],
    );
    const total = Number(totalRows[0]?.total ?? 0);

    const rowsParams: unknown[] = isSw && swTsCodes && swTsCodes.length > 0
      ? [category, q, pageSize, offset, swTsCodes]
      : [category, q, pageSize, offset];

    const rows = await this.dataSource.query<LatestRawRow[]>(
      `SELECT * FROM (
         SELECT DISTINCT ON (q.ts_code)
           q.ts_code AS "tsCode", COALESCE(c.name, s.name) AS name, q.category,
           q.trade_date AS "tradeDate", q.close,
           q.pct_change AS "pctChange", q.vol_hand AS "vol",
           q.amount, q.total_mv_wan AS "totalMvWan",
           q.pe, q.pb
         FROM index_daily_quotes q
         LEFT JOIN ths_index_catalog c ON c.ts_code = q.ts_code
         LEFT JOIN sw_index_catalog s ON s.ts_code = q.ts_code
         WHERE ${whereCore}${tsClauseFor(5)}
         ORDER BY q.ts_code, q.trade_date DESC
       ) latest
       ORDER BY ${orderExpr}
       LIMIT $3 OFFSET $4`,
      rowsParams,
    );

    const mapped: IndexLatestRow[] = rows.map((r) => ({
      tsCode: r.tsCode,
      name: r.name ?? r.tsCode,
      category: r.category as IndexLatestRow['category'],
      tradeDate: String(r.tradeDate ?? ''),
      close: num(r.close),
      pctChange: nullableNum(r.pctChange),
      vol: nullableNum(r.vol),
      amount: nullableNum(r.amount),
      totalMvWan: r.totalMvWan,
      pe: nullableNum(r.pe),
      pb: nullableNum(r.pb),
    }));

    return { rows: mapped, total };
  }

  /**
   * K 线：查 index_daily_quotes LEFT JOIN indicators（全 category）。
   * open_time=YYYYMMDD 字面串契约，volume=volHand*100 转「股」（与 KlineChartBar 对齐）。
   */
  async getKlines(dto: QueryKlineDto): Promise<IndexDailyKlineRow[]> {
    const rows = await this.dataSource.query<KlineRawRow[]>(
      `SELECT
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
        WHERE q.ts_code = $1
          AND q.trade_date >= $2
          AND q.trade_date <= $3
        ORDER BY q.trade_date ASC`,
      [dto.ts_code, dto.start_date, dto.end_date],
    );

    return rows.map((r) => {
      const brick = nullableNum(r.brick);
      const brickDelta = nullableNum(r.brickDelta);
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
}
