import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'
import { IndexMemberEntity } from '../../entities/raw/index-member.entity'
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity'
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity'
import { SwAmvDailyEntity } from '../../entities/active-mv/sw-amv-daily.entity'
import {
  aggregateAmount,
  buildAmvDailyRows,
  persistAmvDaily,
  resolveIndexDailyWarmupStart,
  STOCK_SUFFIX_RE,
  todayYyyymmdd,
} from './amv-sync-helpers'
import { getSeriesWithRange, type AmvSeriesRange } from './amv-series-query'
import { SW_INDEX_SUFFIX_RE } from './amv-query-params'
import type {
  AmvDailyRow,
  AmvSeriesRow,
  AmvSyncResult,
  SwIndexAmvSyncOptions,
} from './active-mv.types'

const SUFFIX_SAMPLE = 5

/**
 * 申万行业指数（.SI）活跃市值（AMV）服务。
 * 成分股来自 raw.index_member（l1/l2/l3_code 匹配），价来自 index_daily_quotes category='sw'。
 */
@Injectable()
export class SwAmvService {
  private readonly logger = new Logger(SwAmvService.name)

  constructor(
    @InjectRepository(IndexMemberEntity)
    private readonly memberRepo: Repository<IndexMemberEntity>,
    @InjectRepository(SwIndexCatalogEntity)
    private readonly catalogRepo: Repository<SwIndexCatalogEntity>,
    @InjectRepository(IndexDailyQuoteEntity)
    private readonly indexDailyRepo: Repository<IndexDailyQuoteEntity>,
    @InjectRepository(SwAmvDailyEntity)
    private readonly swAmvRepo: Repository<SwAmvDailyEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async syncSw(opts: SwIndexAmvSyncOptions): Promise<AmvSyncResult> {
    const syncMode = opts.syncMode ?? 'incremental'
    const endDate = opts.endDate ?? todayYyyymmdd()
    const startDate = opts.startDate ?? '00000000'

    const indexCodes = await this.resolveIndexCodes(opts.tsCodes)
    if (indexCodes.length === 0) {
      const msg = 'no_sw_index_codes: sw_index_catalog 无 .SI 指数'
      this.logger.warn(`[sw-amv] ${msg}（params: ${JSON.stringify(opts)}）`)
      return { synced: 0, errors: [msg] }
    }

    await this.assertSuffixes(indexCodes)

    const errors: string[] = []
    const failedItems: NonNullable<AmvSyncResult['failedItems']> = []
    let synced = 0

    for (const idx of indexCodes) {
      try {
        const n = await this.syncOneSwIndex(
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
        this.logger.error(`[sw-amv] 指数 ${idx} 同步失败：${reason}`)
        errors.push(`sw_amv_error:${idx}:${reason}`)
        failedItems.push({ tsCode: idx, apiName: 'sw_amv_error', reason })
      }
    }

    const result: AmvSyncResult = { synced }
    if (errors.length > 0) result.errors = errors
    if (failedItems.length > 0) result.failedItems = failedItems
    return result
  }

  getSw(
    tsCode: string,
    days: number,
    range?: AmvSeriesRange,
  ): Promise<AmvSeriesRow[]> {
    return getSeriesWithRange(this.swAmvRepo, tsCode, days, range)
  }

  private async resolveIndexCodes(tsCodes?: string[]): Promise<string[]> {
    const rows = await this.catalogRepo.find({
      select: ['tsCode'],
      order: { tsCode: 'ASC' },
    })
    const all = rows.map((r) => r.tsCode).filter((c) => SW_INDEX_SUFFIX_RE.test(c))
    if (tsCodes && tsCodes.length > 0) {
      const want = new Set(tsCodes)
      return all.filter((c) => want.has(c))
    }
    return all
  }

  private async assertSuffixes(indexCodes: string[]): Promise<void> {
    const badIdx = indexCodes.filter((c) => !SW_INDEX_SUFFIX_RE.test(c)).slice(0, SUFFIX_SAMPLE)
    if (badIdx.length > 0) {
      throw new Error(`sw_amv_suffix: 指数代码非 .SI 后缀，样本=${JSON.stringify(badIdx)}`)
    }

    const sampleMembers = await this.memberRepo
      .createQueryBuilder('m')
      .select('DISTINCT m.tsCode', 'tsCode')
      .where("m.isNew = 'Y'")
      .limit(SUFFIX_SAMPLE * 4)
      .getRawMany<{ tsCode: string }>()
    const badCon = sampleMembers
      .map((m) => m.tsCode)
      .filter((c) => !STOCK_SUFFIX_RE.test(c))
      .slice(0, SUFFIX_SAMPLE)
    if (badCon.length > 0) {
      throw new Error(
        `sw_amv_suffix: 量侧成分股 ts_code 非 .SZ/.SH/.BJ/.NQ 后缀，样本=${JSON.stringify(badCon)}`,
      )
    }
  }

  private async syncOneSwIndex(
    idx: string,
    startDate: string,
    endDate: string,
    syncMode: 'incremental' | 'overwrite',
    errors: string[],
    failedItems: NonNullable<AmvSyncResult['failedItems']>,
  ): Promise<number> {
    const emptyApi = 'sw_amv_empty'

    const members = await this.memberRepo
      .createQueryBuilder('m')
      .select('DISTINCT m.tsCode', 'tsCode')
      .where("m.isNew = 'Y'")
      .andWhere('(m.l1Code = :idx OR m.l2Code = :idx OR m.l3Code = :idx)', { idx })
      .getRawMany<{ tsCode: string }>()
    const conCodes = members.map((m) => m.tsCode)
    const expectedMembers = conCodes.length
    if (expectedMembers === 0) {
      const msg = `${emptyApi}:${idx}: 该指数无成分股名单`
      this.logger.warn(`[sw-amv] ${msg}`)
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '无成分股名单' })
      return 0
    }

    const fetchStart = await resolveIndexDailyWarmupStart(idx, startDate, this.indexDailyRepo, 'sw')
    const priceRows = await this.indexDailyRepo
      .createQueryBuilder('q')
      .select(['q.tradeDate', 'q.open', 'q.high', 'q.low', 'q.close'])
      .where('q.tsCode = :idx', { idx })
      .andWhere("q.category = 'sw'")
      .andWhere('q.tradeDate >= :fetchStart', { fetchStart })
      .andWhere('q.tradeDate <= :endDate', { endDate })
      .orderBy('q.tradeDate', 'ASC')
      .getMany()

    if (priceRows.length === 0) {
      const msg = `${emptyApi}:${idx}: index_daily_quotes 当窗口无行情`
      this.logger.warn(`[sw-amv] ${msg}（fetchStart=${fetchStart} endDate=${endDate}）`)
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '指数无行情' })
      return 0
    }

    const amtMap = await aggregateAmount(this.dataSource, conCodes, fetchStart, endDate)
    if (amtMap.size === 0) {
      this.logger.warn(
        `[sw-amv] amount=empty (items.length===0)：指数 ${idx} 成分股 ${expectedMembers} ` +
          `只在 ${fetchStart}~${endDate} 无任何成交额（apiName=daily_quote_sum）`,
      )
    }

    const rows: AmvDailyRow[] = buildAmvDailyRows(
      priceRows, amtMap, startDate, expectedMembers, idx, this.logger, 'sw',
    )

    if (rows.length === 0) {
      const msg = `${emptyApi}:${idx}: 裁热身/过滤异常后无可落库行`
      this.logger.warn(`[sw-amv] ${msg}`)
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '无有效指标行' })
      return 0
    }

    return persistAmvDaily(this.swAmvRepo, idx, rows, syncMode, this.logger, 'sw')
  }
}
