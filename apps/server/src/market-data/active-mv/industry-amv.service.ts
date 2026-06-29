import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity'
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity'
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity'
import { IndustryAmvDailyEntity } from '../../entities/active-mv/industry-amv-daily.entity'
import { ConceptAmvDailyEntity } from '../../entities/active-mv/concept-amv-daily.entity'
import {
  aggregateAmount,
  buildAmvDailyRows,
  persistAmvDaily,
  resolveIndexDailyWarmupStart,
  STOCK_SUFFIX_RE,
  todayYyyymmdd,
} from './amv-sync-helpers'
import { getSeriesWithRange, type AmvSeriesRange } from './amv-series-query'
import type {
  AmvDailyRow,
  AmvSeriesRow,
  AmvSignalRow,
  AmvSyncResult,
  ThsIndexAmvSyncOptions,
} from './active-mv.types'

/** 同花顺指数类别：'I'=行业指数、'N'=概念/题材板块。 */
type ThsIndexType = 'I' | 'N'

/** 结果表类型（两类同构，泛型约束公共字段）。 */
type AmvDailyEntity = IndustryAmvDailyEntity | ConceptAmvDailyEntity

/** 后缀断言抽样上限（fail-fast 用，不需全量核对） */
const SUFFIX_SAMPLE = 5

/** 类别隔离断言抽样上限（防 I/N 混存回归） */
const TYPE_SAMPLE = 5

/** 价侧 / 指数后缀 */
const INDEX_SUFFIX_RE = /\.TI$/i

/** 类别中文标签（日志/错误透出用） */
function typeLabel(t: ThsIndexType): string {
  return t === 'I' ? 'industry' : 'concept'
}

/**
 * 同花顺指数活跃市值（AMV）服务（行业 type='I' / 概念 type='N' 共用，按 type 参数化）。
 *
 * 双 join：
 *  - 量 join：ths_member_stocks.con_code (.SZ/.SH/.BJ/.NQ) = raw.daily_quote.ts_code，Σ amount × 1000
 *  - 价 join：ths_member_stocks.ts_code (.TI) = index_daily_quotes.ts_code（指数点位）
 * 待同步指数由 resolveIndexCodes 按 type join ths_index_catalog 过滤，行业/概念互不越界。
 * Σ amount 聚合走裸 SQL（DataSource），规避 QueryBuilder .select() 水合坑（见 database-sql 规则）。
 */
@Injectable()
export class ThsIndexAmvService {
  private readonly logger = new Logger(ThsIndexAmvService.name)

  constructor(
    @InjectRepository(ThsMemberStockEntity)
    private readonly memberRepo: Repository<ThsMemberStockEntity>,
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    @InjectRepository(IndexDailyQuoteEntity)
    private readonly indexDailyRepo: Repository<IndexDailyQuoteEntity>,
    @InjectRepository(IndustryAmvDailyEntity)
    private readonly industryAmvRepo: Repository<IndustryAmvDailyEntity>,
    @InjectRepository(ConceptAmvDailyEntity)
    private readonly conceptAmvRepo: Repository<ConceptAmvDailyEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ============== 公开方法：行业（type='I'） ==============

  /** 行业 AMV 增量同步落库（type='I' → industry_amv_daily）。spec §7。 */
  syncIndustry(opts: ThsIndexAmvSyncOptions): Promise<AmvSyncResult> {
    return this.syncByType('I', this.industryAmvRepo, opts)
  }

  /** 单行业 AMV K 线 + 指标 + signal（最近 days 个交易日或区间）。spec §7。 */
  getIndustry(
    tsCode: string,
    days: number,
    range?: AmvSeriesRange,
  ): Promise<AmvSeriesRow[]> {
    return getSeriesWithRange(this.industryAmvRepo, tsCode, days, range)
  }

  /** 某交易日行业信号榜。spec §7。 */
  getIndustrySignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.getSignalsByType(this.industryAmvRepo, tradeDate)
  }

  // ============== 公开方法：概念/板块（type='N'） ==============

  /** 概念 AMV 增量同步落库（type='N' → concept_amv_daily）。spec §7。 */
  syncConcept(opts: ThsIndexAmvSyncOptions): Promise<AmvSyncResult> {
    return this.syncByType('N', this.conceptAmvRepo, opts)
  }

  /** 单概念 AMV K 线 + 指标 + signal（最近 days 个交易日或区间）。spec §7。 */
  getConcept(
    tsCode: string,
    days: number,
    range?: AmvSeriesRange,
  ): Promise<AmvSeriesRow[]> {
    return getSeriesWithRange(this.conceptAmvRepo, tsCode, days, range)
  }

  /** 某交易日概念信号榜。spec §7。 */
  getConceptSignals(tradeDate: string): Promise<AmvSignalRow[]> {
    return this.getSignalsByType(this.conceptAmvRepo, tradeDate)
  }

  // ============== 共享算法主体（参数化 by type + 目标 repo） ==============

  /**
   * 按 type 同步落库到目标 repo。
   * 不传 tsCodes 时只算该 type 全部指数（type='I' 不再含 N，反之亦然）。
   */
  private async syncByType(
    indexType: ThsIndexType,
    targetRepo: Repository<AmvDailyEntity>,
    opts: ThsIndexAmvSyncOptions,
  ): Promise<AmvSyncResult> {
    const label = typeLabel(indexType)
    const syncMode = opts.syncMode ?? 'incremental'
    const endDate = opts.endDate ?? todayYyyymmdd()
    // 无 0AMV 那种自然日窗口，热身按交易行取，startDate 缺省给一个足够早的下界
    const startDate = opts.startDate ?? '00000000'

    const indexCodes = await this.resolveIndexCodes(indexType, opts.tsCodes)
    if (indexCodes.length === 0) {
      const msg = `no_${label}_index_codes: ths_index_catalog 无 type='${indexType}' 的有成分股指数`
      this.logger.warn(`[${label}-amv] ${msg}（params: ${JSON.stringify(opts)}）`)
      return { synced: 0, errors: [msg] }
    }

    // 后缀断言（fail-fast）：抽样核对量侧 con_code / 价侧 ts_code 后缀
    await this.assertSuffixes(indexType, indexCodes)
    // 类别隔离断言（防回归）：解析出的指数 type 必须全为本路径的 indexType
    await this.assertTypeIsolation(indexType, indexCodes)

    const errors: string[] = []
    const failedItems: NonNullable<AmvSyncResult['failedItems']> = []
    let synced = 0

    for (const idx of indexCodes) {
      try {
        const n = await this.syncOneIndex(
          indexType,
          targetRepo,
          idx,
          startDate,
          endDate,
          syncMode,
          errors,
          failedItems,
        )
        synced += n
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        this.logger.error(`[${label}-amv] 指数 ${idx} 同步失败：${reason}`)
        errors.push(`${label}_amv_error:${idx}:${reason}`)
        failedItems.push({ tsCode: idx, apiName: `${label}_amv_error`, reason })
      }
    }

    const result: AmvSyncResult = { synced }
    if (errors.length > 0) result.errors = errors
    if (failedItems.length > 0) result.failedItems = failedItems
    return result
  }

  /** 某交易日信号榜（按 signal DESC、DIF DESC 排序，走 INDEX(trade_date, signal)）。 */
  private async getSignalsByType(
    targetRepo: Repository<AmvDailyEntity>,
    tradeDate: string,
  ): Promise<AmvSignalRow[]> {
    if (!tradeDate) return []
    const rows = await targetRepo.find({
      where: { tradeDate },
      order: { signal: 'DESC', amvDif: 'DESC' },
    })
    return rows.map((r) => ({
      tsCode: r.tsCode,
      tradeDate: r.tradeDate,
      amvDif: r.amvDif ?? NaN,
      amvMacd: r.amvMacd ?? NaN,
      signal: r.signal as AmvSignalRow['signal'],
      memberCount: r.memberCount ?? undefined,
    }))
  }

  // ============== 内部实现 ==============

  /**
   * 解析待同步的指数代码（按 type 过滤的病根修复）。
   * 来源：ths_member_stocks 里 distinct 出有成分股、且 ths_index_catalog.type 匹配的指数。
   * join ths_index_catalog 是按 type 过滤的唯一权威途径（ths_member_stocks 无 type 列）。
   * 传入 tsCodes 时与该集合取交集（仅同步既有成分股且 type 匹配的指数）。
   */
  private async resolveIndexCodes(
    indexType: ThsIndexType,
    tsCodes?: string[],
  ): Promise<string[]> {
    const raw = await this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(ThsIndexCatalogEntity, 'c', 'c.tsCode = m.tsCode')
      .select('DISTINCT m.tsCode', 'tsCode')
      .where('c.type = :indexType', { indexType })
      .orderBy('m.tsCode', 'ASC')
      .getRawMany<{ tsCode: string }>()
    const all = raw.map((r) => r.tsCode)
    if (tsCodes && tsCodes.length > 0) {
      const want = new Set(tsCodes)
      return all.filter((c) => want.has(c))
    }
    return all
  }

  /**
   * 类别隔离断言（防回归）：解析出的指数代码其 ths_index_catalog.type 必须全为本路径 indexType。
   * 抽样核对，错配则 throw（apiName 标 amv_type_mismatch）。
   */
  private async assertTypeIsolation(
    indexType: ThsIndexType,
    indexCodes: string[],
  ): Promise<void> {
    const sample = indexCodes.slice(0, TYPE_SAMPLE)
    if (sample.length === 0) return
    const rows = await this.catalogRepo
      .createQueryBuilder('c')
      .select('c.tsCode', 'tsCode')
      .addSelect('c.type', 'type')
      .where('c.tsCode IN (:...codes)', { codes: sample })
      .getRawMany<{ tsCode: string; type: string }>()
    const bad = rows.filter((r) => r.type !== indexType)
    if (bad.length > 0) {
      throw new Error(
        `amv_type_mismatch: ${typeLabel(indexType)} 路径解析出非 type='${indexType}' 指数，` +
          `样本=${JSON.stringify(bad)}`,
      )
    }
    // 解析出的指数在 catalog 里查无 type（脏 join），同样视为错配
    if (rows.length < sample.length) {
      const found = new Set(rows.map((r) => r.tsCode))
      const missing = sample.filter((c) => !found.has(c))
      throw new Error(
        `amv_type_mismatch: ${typeLabel(indexType)} 路径有指数在 ths_index_catalog 查无记录，` +
          `样本=${JSON.stringify(missing)}`,
      )
    }
  }

  /**
   * 后缀断言（fail-fast）：抽样核对
   *  - 价侧：member.tsCode / indexDaily.ts_code 同为 .TI
   *  - 量侧：member.conCode 与 daily_quote.ts_code 同为 .SZ/.SH/.BJ/.NQ
   * 不符报错 + 明确日志，不静默产空。两类 type 共用。
   */
  private async assertSuffixes(
    indexType: ThsIndexType,
    indexCodes: string[],
  ): Promise<void> {
    const label = typeLabel(indexType)
    // 价侧：指数代码本身必须 .TI
    const badIdx = indexCodes.filter((c) => !INDEX_SUFFIX_RE.test(c)).slice(0, SUFFIX_SAMPLE)
    if (badIdx.length > 0) {
      throw new Error(
        `${label}_amv_suffix: 价侧指数代码非 .TI 后缀，样本=${JSON.stringify(badIdx)}`,
      )
    }

    // 量侧：抽样几个本 type 指数的成分股 conCode 必须 .SZ/.SH/.BJ/.NQ
    const sampleMembers = await this.memberRepo
      .createQueryBuilder('m')
      .innerJoin(ThsIndexCatalogEntity, 'c', 'c.tsCode = m.tsCode')
      .select('m.conCode', 'conCode')
      .where('c.type = :indexType', { indexType })
      .limit(SUFFIX_SAMPLE * 4)
      .getRawMany<{ conCode: string }>()
    const badCon = sampleMembers
      .map((m) => m.conCode)
      .filter((c) => !STOCK_SUFFIX_RE.test(c))
      .slice(0, SUFFIX_SAMPLE)
    if (badCon.length > 0) {
      throw new Error(
        `${label}_amv_suffix: 量侧成分股 con_code 非 .SZ/.SH/.BJ/.NQ 后缀，样本=${JSON.stringify(badCon)}`,
      )
    }

    // 价侧表后缀也抽样核对（指数日线表 ts_code 必须 .TI）；
    // 迁移后统一表含大盘(.SH/.SZ, category='market')，须按 category 过滤再抽样，否则抓到大盘 throw
    const sampleIdxDaily = await this.indexDailyRepo
      .createQueryBuilder('q')
      .select('q.tsCode', 'tsCode')
      .where('q.category IN (:...cats)', { cats: ['industry', 'concept'] })
      .limit(SUFFIX_SAMPLE)
      .getRawMany<{ tsCode: string }>()
    const badIdxDaily = sampleIdxDaily
      .map((q) => q.tsCode)
      .filter((c) => !INDEX_SUFFIX_RE.test(c))
      .slice(0, SUFFIX_SAMPLE)
    if (badIdxDaily.length > 0) {
      throw new Error(
        `${label}_amv_suffix: 价侧 index_daily_quotes.ts_code 非 .TI 后缀，样本=${JSON.stringify(badIdxDaily)}`,
      )
    }
  }

  /**
   * 同步单个指数（行业/概念共用）。返回落库行数。
   */
  private async syncOneIndex(
    indexType: ThsIndexType,
    targetRepo: Repository<AmvDailyEntity>,
    idx: string,
    startDate: string,
    endDate: string,
    syncMode: 'incremental' | 'overwrite',
    errors: string[],
    failedItems: NonNullable<AmvSyncResult['failedItems']>,
  ): Promise<number> {
    const label = typeLabel(indexType)
    const emptyApi = `${label}_amv_empty`
    // 该指数当前成分股 conCode 列表（覆盖度基线 expected = 名单总数）
    const members = await this.memberRepo
      .createQueryBuilder('m')
      .select('m.conCode', 'conCode')
      .where('m.tsCode = :idx', { idx })
      .getRawMany<{ conCode: string }>()
    const conCodes = members.map((m) => m.conCode)
    const expectedMembers = conCodes.length
    if (expectedMembers === 0) {
      const msg = `${emptyApi}:${idx}: 该指数无成分股名单`
      this.logger.warn(`[${label}-amv] ${msg}`)
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '无成分股名单' })
      return 0
    }

    // 价：取指数 OHLC，并据此确定热身起始（按交易行多取 WARMUP_ROWS 行）
    const fetchStart = await resolveIndexDailyWarmupStart(idx, startDate, this.indexDailyRepo)
    const priceRows = await this.indexDailyRepo
      .createQueryBuilder('q')
      .select(['q.tradeDate', 'q.open', 'q.high', 'q.low', 'q.close'])
      .where('q.tsCode = :idx', { idx })
      .andWhere('q.tradeDate >= :fetchStart', { fetchStart })
      .andWhere('q.tradeDate <= :endDate', { endDate })
      .orderBy('q.tradeDate', 'ASC')
      .getMany()

    if (priceRows.length === 0) {
      const msg = `${emptyApi}:${idx}: index_daily_quotes 当窗口无行情`
      this.logger.warn(
        `[${label}-amv] ${msg}（fetchStart=${fetchStart} endDate=${endDate}）`,
      )
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '指数无行情' })
      return 0
    }

    // 量：裸 SQL 聚合成分股 Σamount + member_count（规避 QueryBuilder 水合坑）
    const amtMap = await aggregateAmount(this.dataSource, conCodes, fetchStart, endDate)

    // 双路径空数据 warn（data-integrity 规则）
    if (amtMap.size === 0) {
      this.logger.warn(
        `[${label}-amv] amount=empty (items.length===0)：指数 ${idx} 成分股 ` +
          `${expectedMembers} 只在 ${fetchStart}~${endDate} 无任何成交额` +
          `（apiName=daily_quote_sum, conCodes=${expectedMembers}）`,
      )
    }

    // 量价对齐 + 套公式 + 裁热身段
    const rows: AmvDailyRow[] = buildAmvDailyRows(
      priceRows, amtMap, startDate, expectedMembers, idx, this.logger, label,
    )

    if (rows.length === 0) {
      const msg = `${emptyApi}:${idx}: 裁热身/过滤异常后无可落库行`
      this.logger.warn(`[${label}-amv] ${msg}`)
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '无有效指标行' })
      return 0
    }

    return persistAmvDaily(targetRepo, idx, rows, syncMode, this.logger, label)
  }
}
