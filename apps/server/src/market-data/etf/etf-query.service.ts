/**
 * ETF 查询 service：latest / kline / pcf 查询 API。
 *
 * 仿 index-daily 模式：原生 SQL + 排序字段白名单 + 远程分页。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  EtfLatestRow,
  EtfLatestResult,
  EtfKlineRow,
  EtfPcfDetailRow,
} from './etf.types';

// ── DTO ────────────────────────────────────────────────────────────────────

export class QueryEtfLatestDto {
  q?: string;
  fundType?: string;
  manager?: string;
  publishIopv?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export class QueryEtfKlineDto {
  tsCode: string;
  startDate?: string;
  endDate?: string;
}

export class QueryEtfPcfDto {
  tsCode: string;
  tradeDate: string;
}

// ── 排序字段白名单 ────────────────────────────────────────────────────────

const SORT_COL_MAP: Record<string, string> = {
  tsCode: '"tsCode"',
  name: '"name"',
  exchange: '"exchange"',
  fundType: '"fundType"',
  close: '"close"',
  // 与 index-daily 约定一致：pct_change → "pctChange"（前端 EtfLatestRow.pctChange）
  pct_change: '"pctChange"',
  ma5: '"ma5"',
  // 项目指标表无 ma20 列（仅 ma5/30/60/120/240），列展示用 MA30，与个股/指数口径一致
  ma30: '"ma30"',
  dif: '"dif"',
  dea: '"dea"',
  macd: '"macd"',
  kdj_k: '"kdjK"',
  kdj_d: '"kdjD"',
  kdj_j: '"kdjJ"',
  obv5d: '"obv5d"',
  obv10d: '"obv10d"',
  obv20d: '"obv20d"',
  component_count: '"componentCount"',
  creation_unit: '"creationUnit"',
  max_cash_ratio: '"maxCashRatio"',
  trade_date: '"tradeDate"',
};

@Injectable()
export class EtfQueryService {
  private readonly logger = new Logger(EtfQueryService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * ETF 列表（远程分页/排序/搜索 + 筛选）。
   */
  async getLatest(dto: QueryEtfLatestDto): Promise<EtfLatestResult> {
    const q = (dto.q ?? '').trim();
    const fundType = dto.fundType;
    const manager = dto.manager;
    const publishIopv = dto.publishIopv;
    const sortCol = SORT_COL_MAP[dto.sort ?? ''] ?? '"pctChange"';
    const sortOrder = dto.order === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Number(dto.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(dto.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (q) {
      conditions.push(`(s.name ILIKE $${params.length + 1} OR s.ts_code ILIKE $${params.length + 1})`);
      params.push(`%${q}%`);
    }
    if (fundType) {
      conditions.push(`s.fund_type = $${params.length + 1}`);
      params.push(fundType);
    }
    if (manager) {
      conditions.push(`s.manager = $${params.length + 1}`);
      params.push(manager);
    }
    if (publishIopv === 'true') {
      conditions.push(`s.publish_iopv = TRUE`);
    } else if (publishIopv === 'false') {
      conditions.push(`s.publish_iopv = FALSE`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 计数
    const countSql = `SELECT COUNT(*) AS cnt FROM raw.etf_symbol s ${where}`;
    const countResult = await this.dataSource.query(countSql, params);
    const total = Number(countResult[0]?.cnt ?? 0);

    // 查询：ETF 目录 LEFT JOIN 最新日线 + 指标 + PCF 头信息
    const dataSql = `
      SELECT
        s.ts_code                 AS "tsCode",
        s.name                    AS "name",
        s.exchange                AS "exchange",
        s.fund_type               AS "fundType",
        s.manager                 AS "manager",
        COALESCE(s.index_code, pcf.index_code) AS "indexCode",
        s.publish_iopv            AS "publishIopv",
        fd.trade_date             AS "tradeDate",
        fd.close::numeric         AS "close",
        fd.pct_chg::numeric       AS "pctChange",
        fi.ma5                    AS "ma5",
        fi.ma30                   AS "ma30",
        fi.ma60                   AS "ma60",
        fi.dif                    AS "dif",
        fi.dea                    AS "dea",
        fi.macd                   AS "macd",
        fi.kdj_k                  AS "kdjK",
        fi.kdj_d                  AS "kdjD",
        fi.kdj_j                  AS "kdjJ",
        fi.obv5d                  AS "obv5d",
        fi.obv10d                 AS "obv10d",
        fi.obv20d                 AS "obv20d",
        pcf.creation_unit::text   AS "creationUnit",
        pcf.max_cash_ratio::text  AS "maxCashRatio",
        comp.cnt::int             AS "componentCount"
      FROM raw.etf_symbol s
      LEFT JOIN LATERAL (
        SELECT trade_date, close, pct_chg
        FROM raw.fund_daily f
        WHERE f.ts_code = s.ts_code
        ORDER BY f.trade_date DESC
        LIMIT 1
      ) fd ON true
      LEFT JOIN LATERAL (
        SELECT ma5, ma30, ma60, dif, dea, macd, kdj_k, kdj_d, kdj_j, obv5d, obv10d, obv20d
        FROM raw.fund_daily_indicator i
        WHERE i.ts_code = s.ts_code AND i.trade_date = fd.trade_date
        LIMIT 1
      ) fi ON true
      LEFT JOIN LATERAL (
        SELECT trade_date, index_code, creation_unit, max_cash_ratio
        FROM raw.etf_pcf p
        WHERE p.ts_code = s.ts_code
          AND p.con_code = ''
        ORDER BY p.trade_date DESC
        LIMIT 1
      ) pcf ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM raw.etf_pcf c
        WHERE c.ts_code = s.ts_code
          AND c.trade_date = pcf.trade_date
          AND c.con_code != ''
      ) comp ON true
      ${where}
      ORDER BY ${sortCol} ${sortOrder} NULLS LAST
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const rows = await this.dataSource.query(dataSql, params) as EtfLatestRow[];
    return { rows, total };
  }

  /**
   * 单只 ETF K 线 + 指标。
   */
  async getKlines(dto: QueryEtfKlineDto): Promise<EtfKlineRow[]> {
    const params: unknown[] = [dto.tsCode];

    let dateFilter = '';
    if (dto.startDate) {
      dateFilter += ` AND f.trade_date >= $${params.length + 1}`;
      params.push(dto.startDate);
    }
    if (dto.endDate) {
      dateFilter += ` AND f.trade_date <= $${params.length + 1}`;
      params.push(dto.endDate);
    }

    const sql = `
      SELECT
        f.trade_date                                              AS open_time,
        f.open::numeric::float8                                    AS open,
        f.high::numeric::float8                                    AS high,
        f.low::numeric::float8                                     AS low,
        f.close::numeric::float8                                   AS close,
        f.pre_close::numeric::float8                               AS pre_close,
        f.pct_chg::numeric::float8                                 AS pct_chg,
        (f.vol::numeric::float8 * 100)::float8                     AS volume,
        i.ma5                                                     AS "MA5",
        i.ma30                                                    AS "MA30",
        i.ma60                                                    AS "MA60",
        i.ma120                                                   AS "MA120",
        i.ma240                                                   AS "MA240",
        i.dif                                                     AS "DIF",
        i.dea                                                     AS "DEA",
        i.macd                                                    AS "MACD",
        i.kdj_k                                                   AS "KDJ.K",
        i.kdj_d                                                   AS "KDJ.D",
        i.kdj_j                                                   AS "KDJ.J",
        i.bbi                                                     AS "BBI",
        i.atr_14                                                  AS "ATR14",
        i.roc10                                                   AS "ROC10",
        i.roc20                                                   AS "ROC20",
        i.roc60                                                   AS "ROC60",
        i.brick                                                   AS brick,
        i.brick_delta                                             AS brick_delta,
        i.brick_xg                                                AS brick_xg,
        amv.amv_close                                             AS "0AMV",
        amv.amv_dif                                               AS "0AMV.DIF",
        amv.amv_dea                                               AS "0AMV.DEA",
        amv.amv_macd                                              AS "0AMV.MACD"
      FROM raw.fund_daily f
      LEFT JOIN raw.fund_daily_indicator i
        ON i.ts_code = f.ts_code AND i.trade_date = f.trade_date
      LEFT JOIN raw.fund_amv_daily amv
        ON amv.ts_code = f.ts_code AND amv.trade_date = f.trade_date
      WHERE f.ts_code = $1${dateFilter}
      ORDER BY f.trade_date ASC
    `;

    return this.dataSource.query(sql, params) as Promise<EtfKlineRow[]>;
  }

  /**
   * 单只 ETF 某日 PCF 成分股明细。
   */
  async getPcf(dto: QueryEtfPcfDto): Promise<EtfPcfDetailRow[]> {
    const sql = `
      SELECT
        p.ts_code              AS "tsCode",
        p.trade_date           AS "tradeDate",
        p.con_code             AS "conCode",
        p.con_name             AS "conName",
        p.quantity::text       AS "quantity",
        p.subst_flag           AS "substFlag",
        p.premium_rate::text   AS "premiumRate",
        p.discount_rate::text  AS "discountRate"
      FROM raw.etf_pcf p
      WHERE p.ts_code = $1
        AND p.trade_date = $2
        AND p.con_code != ''
      ORDER BY p.quantity::numeric DESC NULLS LAST
    `;
    return this.dataSource.query(sql, [dto.tsCode, dto.tradeDate]) as Promise<EtfPcfDetailRow[]>;
  }

  /**
   * 基金类型枚举（distinct fund_type，供前端筛选 radio 动态生成）。
   */
  async getFundTypes(): Promise<string[]> {
    const rows = await this.dataSource.query<{ fund_type: string }[]>(
      `SELECT DISTINCT fund_type FROM raw.etf_symbol
       WHERE fund_type IS NOT NULL AND fund_type <> ''
       ORDER BY fund_type`,
    );
    return rows.map((r) => r.fund_type);
  }
}
