import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
import { QueryLatestDto, IndexLatestSortField } from './dto/latest.dto';
import { QueryKlineDto } from './dto/kline.dto';
import { buildLatestSql } from './index-daily-latest.sql';
import type {
  IndexDailyKlineRow,
  IndexLatestResult,
  IndexLatestRow,
} from './index-daily.types';

/**
 * sort 字段白名单:前端字段 → 子查询别名(database-sql.md:禁直接拼前端字段名)。
 * 外层 ORDER BY 用别名(双引号),子查询内已用 AS "xxx" 命名。
 */
const SORT_COL_MAP: Record<IndexLatestSortField, string> = {
  pct_change: '"pctChange"',
  vol: '"vol"',
  amount: 'amount',
  total_mv_wan: '"totalMvWan"',
  tradeDate: '"tradeDate"',
  pe: 'pe',
  pb: 'pb',
  count: 'count',
  net_amount: '"netAmount"',
  buy_lg_amount: '"buyLgAmount"',
  buy_md_amount: '"buyMdAmount"',
  buy_sm_amount: '"buySmAmount"',
  net_amount_5d: '"netAmount5d"',
  net_amount_10d: '"netAmount10d"',
  net_amount_20d: '"netAmount20d"',
  obv5d: '"obv5d"',
  obv10d: '"obv10d"',
  obv20d: '"obv20d"',
};

/** 排序依赖 LATERAL 滚动资金流时须全量算完再排序,不可先分页。 */
const LATERAL_SORT_FIELDS: IndexLatestSortField[] = [
  'net_amount_5d',
  'net_amount_10d',
  'net_amount_20d',
];

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
  count: string | number | null;
  netAmount: string | number | null;
  buyLgAmount: string | number | null;
  buyMdAmount: string | number | null;
  buySmAmount: string | number | null;
  netAmount5d: string | number | null;
  netAmount10d: string | number | null;
  netAmount20d: string | number | null;
  obv5d: string | number | null;
  obv10d: string | number | null;
  obv20d: string | number | null;
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
 * 统一 A 股指数日线查询(大盘 + 行业 + 概念 + 申万,全 category)。
 * spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md【后端>接口清单】
 *
 * SQL 拼装按 category 裁剪(sw 只 JOIN money_flow_industries + ind_roll,余类推),
 * 等价性与裁剪规则见 index-daily-latest.sql.ts。用 DataSource raw SQL 规避
 * QueryBuilder .select() 水合坑(database-sql.md)。
 */
@Injectable()
export class IndexDailyService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SwIndexCatalogEntity)
    private readonly swCatalogRepo: Repository<SwIndexCatalogEntity>,
  ) {}

  /**
   * 行情表最新行情:每个指数取最新一行(DISTINCT ON ts_code),支持类型筛选/模糊搜索/排序/分页。
   *
   * name 来源:同花顺走 ths_index_catalog(c.name),申万走 sw_index_catalog(s.name)。
   * level 仅对 type='sw' 生效:先查 sw_index_catalog 拿该层 tsCode 集合,
   * 再用 ANY($tsCodes) 收敛(避免 JOIN sw_index_catalog 后 DISTINCT ON 与分页交互复杂)。
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
    const sortUsesLateral = LATERAL_SORT_FIELDS.includes(sortField);

    // 申万按 level 过滤:name 也在此表,一并取回避免 JOIN。
    // GET 查询参数 level 是字符串,需显式转 number 再校验(原 `=== 1` 会漏字符串)。
    const isSw = category === 'sw';
    const levelNum = dto.level == null ? null : Number(dto.level);
    const swLevel: number | null =
      isSw && (levelNum === 1 || levelNum === 2 || levelNum === 3) ? levelNum : null;
    let swTsCodes: string[] | null = null;
    let swNoMatch = false;
    if (isSw) {
      const swRows = await this.swCatalogRepo.find({
        where: swLevel == null ? {} : { level: swLevel as 1 | 2 | 3 },
        select: ['tsCode', 'name'],
      });
      swTsCodes = swRows.map((r) => r.tsCode);
      // level 过滤下命中 0 个目录项 → 直接返回空(避免 ANY('{}') 退化成「全表」陷阱)
      if (swLevel != null && swTsCodes.length === 0) {
        return { rows: [], total: 0 };
      }
      swNoMatch = swTsCodes.length === 0;
    }

    const built = buildLatestSql({
      category,
      isSw,
      swTsCodes,
      swNoMatch,
      q,
      pageSize,
      offset,
      sortUsesLateral,
      orderExpr,
    });

    const totalRows = await this.dataSource.query<Array<{ total: string }>>(
      built.countSql,
      built.countParams,
    );
    const total = Number(totalRows[0]?.total ?? 0);

    const rows = await this.dataSource.query<LatestRawRow[]>(built.rowsSql, built.rowsParams);

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
      count: nullableNum(r.count),
      netAmount: nullableNum(r.netAmount),
      netAmount5d: nullableNum(r.netAmount5d),
      netAmount10d: nullableNum(r.netAmount10d),
      netAmount20d: nullableNum(r.netAmount20d),
      obv5d: nullableNum(r.obv5d),
      obv10d: nullableNum(r.obv10d),
      obv20d: nullableNum(r.obv20d),
      buyLgAmount: nullableNum(r.buyLgAmount),
      buyMdAmount: nullableNum(r.buyMdAmount),
      buySmAmount: nullableNum(r.buySmAmount),
    }));

    return { rows: mapped, total };
  }

  /**
   * K 线:查 index_daily_quotes LEFT JOIN indicators(全 category)。
   * open_time=YYYYMMDD 字面串契约,volume=volHand*100 转「股」(与 KlineChartBar 对齐)。
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
