/**
 * ETF 日线同步 service：Tushare fund_daily + fund_adj。
 *
 * 按 trade_date 批量并发拉取（非逐只 ts_code 串行），两阶段：
 *   Phase 1: 并发拉全量 fund_adj → 攒 adjByCodeDate + 预算 latestAdjByCode
 *   Phase 2: 并发拉 fund_daily → 算 qfq → upsert
 *
 * fund_daily / fund_adj 均支持 trade_date 批量入参，
 * 单次上限（5000 / 2000）远大于 ETF 数量（~1610），无需分页。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FundDailyEntity } from '../../entities/raw/fund-daily.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { resolveOpenTradeDates } from '../a-shares/sync/a-shares-sync-utils';
import { collectCompletenessErrors } from '../_shared/dataset-completeness';
import { batchUpsert, runWithRetry } from '../_shared/sync-helpers';
import type { EtfSyncErrorItem, EtfSyncResult, FundDailyRow, FundAdjRow, EtfSyncOnProgress } from './etf.types';

const FUND_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount';
const FUND_ADJ_FIELDS = 'ts_code,trade_date,adj_factor';

/** Tushare 单次返回行数上限——达此值可能被静默截断（按 trade_date 批量返回全市场基金，少数日期可能超限） */
const FUND_DAILY_RETURN_LIMIT = 5000;
const FUND_ADJ_RETURN_LIMIT = 2000;

// ── 文件级纯函数 ────────────────────────────────────────────────────────

/**
 * 从单行 fund_daily + 复权因子 map 构建实体（含 qfq 前复权计算）。
 *
 * qfq 公式：qfq_* = 原始 × (adjFactor / latestAdj)。
 * qfq_pct_chg 由 qfq_close / qfq_pre_close 重算（禁用原始 pct_chg × ratio），
 * 跨除权日才能正确反映前复权序列的当日涨跌。
 */
function buildFundDailyEntity(
  r: FundDailyRow,
  adjByCodeDate: Map<string, Map<string, number>>,
  latestAdjByCode: Map<string, number>,
): Partial<FundDailyEntity> {
  const adj = adjByCodeDate.get(r.ts_code)?.get(r.trade_date);
  const adjFactor = adj ?? 1;
  const latestAdj = latestAdjByCode.get(r.ts_code) ?? 1;

  const entity: Partial<FundDailyEntity> = {
    tsCode: r.ts_code,
    tradeDate: r.trade_date,
    open: r.open != null ? String(r.open) : null,
    high: r.high != null ? String(r.high) : null,
    low: r.low != null ? String(r.low) : null,
    close: r.close != null ? String(r.close) : null,
    preClose: r.pre_close != null ? String(r.pre_close) : null,
    changeVal: r.change != null ? String(r.change) : null,
    pctChg: r.pct_chg != null ? String(r.pct_chg) : null,
    vol: r.vol != null ? String(r.vol) : null,
    amount: r.amount != null ? String(r.amount) : null,
    adjFactor: adj != null ? String(adj) : null,
  };

  // 前复权：qfq_* = 原始 × (adjFactor / latestAdj)（同 A 股 qfq 价格逻辑）。
  // qfq_change_val 随价格同比缩放（close - pre_close 两侧同乘 ratio）。
  // 但 qfq_pct_chg 不能按 ratio 缩放（涨跌幅是比率，量纲非价格）——
  // 参考 a-shares-sync-dirty-ranges.ts：由 qfq_close/qfq_pre_close 重算，
  // 跨除权日会与原始 pct_chg 不同（正确反映前复权序列的当日涨跌）。
  if (adj != null && latestAdj > 0 && adjFactor > 0) {
    const ratio = adjFactor / latestAdj;
    const qfqClose = r.close != null ? r.close * ratio : null;
    const qfqPreClose = r.pre_close != null ? r.pre_close * ratio : null;
    entity.qfqOpen = r.open != null ? String(r.open * ratio) : null;
    entity.qfqHigh = r.high != null ? String(r.high * ratio) : null;
    entity.qfqLow = r.low != null ? String(r.low * ratio) : null;
    entity.qfqClose = qfqClose != null ? String(qfqClose) : null;
    entity.qfqPreClose = qfqPreClose != null ? String(qfqPreClose) : null;
    entity.qfqChangeVal =
      qfqClose != null && qfqPreClose != null ? String(qfqClose - qfqPreClose) : null;
    entity.qfqPctChg =
      qfqClose != null && qfqPreClose != null && qfqPreClose !== 0
        ? String(((qfqClose - qfqPreClose) / qfqPreClose) * 100)
        : null;
  } else {
    // 无复权因子时透传原始值
    entity.qfqOpen = entity.open;
    entity.qfqHigh = entity.high;
    entity.qfqLow = entity.low;
    entity.qfqClose = entity.close;
    entity.qfqPreClose = entity.preClose;
    entity.qfqChangeVal = entity.changeVal;
    entity.qfqPctChg = entity.pctChg;
  }

  return entity;
}

// ── Service ──────────────────────────────────────────────────────────────

@Injectable()
export class EtfFundDailyService {
  private readonly logger = new Logger(EtfFundDailyService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tushareClient: TushareClientService,
  ) {}

  /**
   * 同步指定 ETF 列表的日线行情 + 复权因子。
   *
   * 按 trade_date 批量并发（非逐只 ts_code 串行），两阶段：
   *   Phase 1: 并发拉 fund_adj → 攒 adjByCodeDate + 预算 latestAdjByCode
   *   Phase 2: 并发拉 fund_daily → 算 qfq → upsert
   *
   * @param etfCodes ETF ts_code 列表
   * @param startDate 开始日期 YYYYMMDD
   * @param endDate 结束日期 YYYYMMDD
   * @returns 成功行数 + 错误
   */
  async syncFundDaily(
    etfCodes: string[],
    startDate: string,
    endDate: string,
    onProgress?: EtfSyncOnProgress,
    signal?: AbortSignal,
  ): Promise<EtfSyncResult> {
    const dailyRepo = this.dataSource.getRepository(FundDailyEntity);
    const trackedSet = new Set(etfCodes);

    // 查范围内所有开市交易日
    const tradeDates = await resolveOpenTradeDates(this.tushareClient, { startDate, endDate });
    if (tradeDates.length === 0) {
      this.logger.warn(
        `[etf-fund-daily] ${startDate}-${endDate} 范围内无开市交易日`,
      );
      return {
        success: 0,
        errors: [{ apiName: 'no_open_trade_dates', message: `${startDate}-${endDate} 无开市交易日` }],
      };
    }

    // ── Phase 1：并发拉全量 fund_adj，攒 adjByCodeDate，预算 latestAdjByCode ──
    const adjByCodeDate = new Map<string, Map<string, number>>(); // ts_code → (trade_date → adj_factor)
    let phase1Done = 0;

    await Promise.all(
      tradeDates.map(async (td) => {
        if (signal?.aborted) return;
        const rows = (await runWithRetry(
          () => this.tushareClient.query('fund_adj', { trade_date: td }, FUND_ADJ_FIELDS),
          (attempt, err) =>
            this.logger.warn(`[etf-fund-adj] ${td} 重试 ${attempt}: ${err}`),
        )) as unknown as FundAdjRow[];

        if (rows.length >= FUND_ADJ_RETURN_LIMIT) {
          this.logger.warn(
            `[etf-fund-adj] ${td} 返回 ${rows.length} 行达上限 ${FUND_ADJ_RETURN_LIMIT}，可能被静默截断（全市场基金 > 上限）`,
          );
        }

        for (const r of rows ?? []) {
          if (!trackedSet.has(r.ts_code)) continue;
          let inner = adjByCodeDate.get(r.ts_code);
          if (!inner) {
            inner = new Map();
            adjByCodeDate.set(r.ts_code, inner);
          }
          inner.set(r.trade_date, r.adj_factor);
        }

        phase1Done++;
        onProgress?.({
          phase: '同步 ETF 日线（复权因子）',
          percent: (phase1Done / tradeDates.length) * 50,
        });
      }),
    );

    // 预算每只 ETF 的 latestAdj（范围内最大 trade_date 的 factor）
    const latestAdjByCode = new Map<string, number>();
    for (const [code, inner] of adjByCodeDate) {
      let latestDate = '';
      let latestFactor = 1;
      for (const [d, f] of inner) {
        if (d > latestDate) {
          latestDate = d;
          latestFactor = f;
        }
      }
      latestAdjByCode.set(code, latestFactor);
    }

    // ── Phase 2：并发拉 fund_daily + 算 qfq + upsert ──
    const errors: EtfSyncErrorItem[] = [];
    let totalWritten = 0;
    let phase2Done = 0;

    await Promise.all(
      tradeDates.map(async (td) => {
        if (signal?.aborted) return;
        const rows = (await runWithRetry(
          () => this.tushareClient.query('fund_daily', { trade_date: td }, FUND_DAILY_FIELDS),
          (attempt, err) =>
            this.logger.warn(`[etf-fund-daily] ${td} 重试 ${attempt}: ${err}`),
        )) as unknown as FundDailyRow[];

        if (!rows || rows.length === 0) {
          this.logger.warn(`[etf-fund-daily] ${td} 无数据`);
          errors.push({ apiName: 'fund_daily_empty', message: `${td} 全市场无 ETF 日线` });
          phase2Done++;
          onProgress?.({
            phase: '同步 ETF 日线（行情）',
            percent: 50 + (phase2Done / tradeDates.length) * 50,
            message: `${td} (${phase2Done}/${tradeDates.length})`,
          });
          return;
        }

        if (rows.length >= FUND_DAILY_RETURN_LIMIT) {
          this.logger.warn(
            `[etf-fund-daily] ${td} 返回 ${rows.length} 行达上限 ${FUND_DAILY_RETURN_LIMIT}，可能被静默截断（全市场基金 > 上限）`,
          );
        }

        // 过滤非 tracked 基金（fund_daily 返回全市场，含 LOF/封闭式）
        const entities = rows
          .filter((r) => trackedSet.has(r.ts_code))
          .map((r) => buildFundDailyEntity(r, adjByCodeDate, latestAdjByCode));

        if (entities.length === 0) {
          phase2Done++;
          onProgress?.({
            phase: '同步 ETF 日线（行情）',
            percent: 50 + (phase2Done / tradeDates.length) * 50,
            message: `${td} (${phase2Done}/${tradeDates.length})`,
          });
          return;
        }

        // batchUpsert 内部已按 ['tsCode','tradeDate'] 去重，无需外层 deduplicateBy
        totalWritten += await batchUpsert(dailyRepo, entities, ['tsCode', 'tradeDate']);

        phase2Done++;
        onProgress?.({
          phase: '同步 ETF 日线（行情）',
          percent: 50 + (phase2Done / tradeDates.length) * 50,
          message: `${td} (${phase2Done}/${tradeDates.length})`,
        });
      }),
    );

    this.logger.log(
      `[etf-fund-daily] 完成：${tradeDates.length} 个交易日，落库 ${totalWritten} 行`,
    );

    // POST-sync 对账：actual（fund_daily 当日入库行数）vs baseline（raw.etf_symbol.tracked 全表标量）。
    // baseline 不按日期（tracked 集合日常稳定）；actual < baseline → push errors，
    // 避免 fund_daily 静默截断（全市场基金 > 单次 5000 上限）伪装成功。
    const completenessErrors = await collectCompletenessErrors(
      dailyRepo,
      {
        tableName: 'raw.fund_daily',
        dateColumn: 'trade_date',
        baseline: { table: 'raw.etf_symbol', filter: 'tracked = true' },
      },
      tradeDates,
      'fund_daily',
    );
    errors.push(...completenessErrors.map((message) => ({ apiName: 'fund_daily_incomplete', message })));

    return { success: totalWritten, errors };
  }

  /**
   * 获取在指定日期范围内成功抓到日线的 ETF ts_code 集合。
   */
  async getEtfCodesWithDaily(
    etfCodes: string[],
    startDate: string,
    endDate: string,
  ): Promise<Set<string>> {
    if (etfCodes.length === 0) return new Set();
    const dailyRepo = this.dataSource.getRepository(FundDailyEntity);
    const rows = await dailyRepo
      .createQueryBuilder('f')
      .select('f.tsCode', 'tsCode')
      .where('f.tsCode = ANY(:codes)', { codes: etfCodes })
      .andWhere('f.tradeDate >= :startDate', { startDate })
      .andWhere('f.tradeDate <= :endDate', { endDate })
      .groupBy('f.tsCode')
      .getRawMany<{ tsCode: string }>();
    return new Set(rows.map((r) => r.tsCode));
  }
}
