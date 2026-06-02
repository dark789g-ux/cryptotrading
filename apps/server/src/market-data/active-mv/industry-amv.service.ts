import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity'
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity'
import { ThsIndexDailyQuoteEntity } from '../../entities/ths-index-daily/ths-index-daily-quote.entity'
import { IndustryAmvDailyEntity } from '../../entities/active-mv/industry-amv-daily.entity'
import { ConceptAmvDailyEntity } from '../../entities/active-mv/concept-amv-daily.entity'
import {
  calcAmvSeries,
  calcMacd,
  calcSignal,
  calcZdf,
} from './amv-formula'
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

/** 额外多取的热身交易行数（spec §6：250 + 90，EMA26 ~90 根收敛到 0.1%） */
const WARMUP_ROWS = 90

/** 后缀断言抽样上限（fail-fast 用，不需全量核对） */
const SUFFIX_SAMPLE = 5

/** 类别隔离断言抽样上限（防 I/N 混存回归） */
const TYPE_SAMPLE = 5

/**
 * 量侧成分股后缀（个股代码）。
 * 真实 ths_member_stocks 的 con_code 含沪深（.SZ/.SH）外，还有北交所 .BJ、新三板 .NQ——
 * 均为合法成分股，断言只用于 catch 严重错配（如 con_code 误存成 .TI 指数代码），不得因 .BJ/.NQ 崩。
 * 这类标的若不在 raw.daily_quote 中，量 join 自然不匹配，计入覆盖度 warn 即可。
 */
const STOCK_SUFFIX_RE = /\.(SZ|SH|BJ|NQ)$/i
/** 价侧 / 指数后缀 */
const INDEX_SUFFIX_RE = /\.TI$/i

/** 裸 SQL 聚合量返回的单行 */
interface AmtAggRow {
  trade_date: string
  amt: string | null
  member_count: string | null
}

/** 类别中文标签（日志/错误透出用） */
function typeLabel(t: ThsIndexType): string {
  return t === 'I' ? 'industry' : 'concept'
}

/**
 * 同花顺指数活跃市值（AMV）服务（行业 type='I' / 概念 type='N' 共用，按 type 参数化）。
 *
 * 双 join：
 *  - 量 join：ths_member_stocks.con_code (.SZ/.SH/.BJ/.NQ) = raw.daily_quote.ts_code，Σ amount × 1000
 *  - 价 join：ths_member_stocks.ts_code (.TI) = ths_index_daily_quotes.ts_code（指数点位）
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
    @InjectRepository(ThsIndexDailyQuoteEntity)
    private readonly indexDailyRepo: Repository<ThsIndexDailyQuoteEntity>,
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

  /** 单行业 AMV K 线 + 指标 + signal（最近 days 个交易日）。spec §7。 */
  getIndustry(tsCode: string, days: number): Promise<AmvSeriesRow[]> {
    return this.getSeriesByType(this.industryAmvRepo, tsCode, days)
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

  /** 单概念 AMV K 线 + 指标 + signal（最近 days 个交易日）。spec §7。 */
  getConcept(tsCode: string, days: number): Promise<AmvSeriesRow[]> {
    return this.getSeriesByType(this.conceptAmvRepo, tsCode, days)
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
    const endDate = opts.endDate ?? this.todayYyyymmdd()
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

  /** 单标的 AMV 序列（最近 days 个交易日），从目标 repo 取。 */
  private async getSeriesByType(
    targetRepo: Repository<AmvDailyEntity>,
    tsCode: string,
    days: number,
  ): Promise<AmvSeriesRow[]> {
    const take = days > 0 ? days : 250
    const rows = await targetRepo.find({
      where: { tsCode },
      order: { tradeDate: 'DESC' },
      take,
    })
    return rows.reverse().map((r) => ({
      tradeDate: r.tradeDate,
      amvOpen: r.amvOpen ?? NaN,
      amvHigh: r.amvHigh ?? NaN,
      amvLow: r.amvLow ?? NaN,
      amvClose: r.amvClose ?? NaN,
      amvDif: r.amvDif ?? NaN,
      amvDea: r.amvDea ?? NaN,
      amvMacd: r.amvMacd ?? NaN,
      amvZdf: r.amvZdf,
      signal: r.signal as AmvSeriesRow['signal'],
      memberCount: r.memberCount ?? undefined,
    }))
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

    // 价侧表后缀也抽样核对一条（指数日线表 ts_code 必须 .TI）
    const sampleIdxDaily = await this.indexDailyRepo
      .createQueryBuilder('q')
      .select('q.tsCode', 'tsCode')
      .limit(SUFFIX_SAMPLE)
      .getRawMany<{ tsCode: string }>()
    const badIdxDaily = sampleIdxDaily
      .map((q) => q.tsCode)
      .filter((c) => !INDEX_SUFFIX_RE.test(c))
      .slice(0, SUFFIX_SAMPLE)
    if (badIdxDaily.length > 0) {
      throw new Error(
        `${label}_amv_suffix: 价侧 ths_index_daily_quotes.ts_code 非 .TI 后缀，样本=${JSON.stringify(badIdxDaily)}`,
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
    const fetchStart = await this.resolveWarmupStart(idx, startDate)
    const priceRows = await this.indexDailyRepo
      .createQueryBuilder('q')
      .select(['q.tradeDate', 'q.open', 'q.high', 'q.low', 'q.close'])
      .where('q.tsCode = :idx', { idx })
      .andWhere('q.tradeDate >= :fetchStart', { fetchStart })
      .andWhere('q.tradeDate <= :endDate', { endDate })
      .orderBy('q.tradeDate', 'ASC')
      .getMany()

    if (priceRows.length === 0) {
      const msg = `${emptyApi}:${idx}: ths_index_daily_quotes 当窗口无行情`
      this.logger.warn(
        `[${label}-amv] ${msg}（fetchStart=${fetchStart} endDate=${endDate}）`,
      )
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '指数无行情' })
      return 0
    }

    // 量：裸 SQL 聚合成分股 Σamount + member_count（规避 QueryBuilder 水合坑）
    const amtMap = await this.aggregateAmount(conCodes, fetchStart, endDate)

    // 双路径空数据 warn（data-integrity 规则）
    if (amtMap.size === 0) {
      this.logger.warn(
        `[${label}-amv] amount=empty (items.length===0)：指数 ${idx} 成分股 ` +
          `${expectedMembers} 只在 ${fetchStart}~${endDate} 无任何成交额` +
          `（apiName=daily_quote_sum, conCodes=${expectedMembers}）`,
      )
    }

    // 按 trade_date 升序对齐量与价（以指数行情日期为主轴）
    const tradeDates = priceRows.map((p) => p.tradeDate)
    const volume: number[] = []
    const open: number[] = []
    const high: number[] = []
    const low: number[] = []
    const close: number[] = []
    const memberCounts: number[] = []

    for (const p of priceRows) {
      const agg = amtMap.get(p.tradeDate)
      const amt = agg ? agg.amt : 0 // 指数有行情但成分股当日 Σ 为空 → 量按 0，公式里 AMVc≤0 自然 invalid
      volume.push(amt * 1000) // 千元 → 元（amount 已是千元；×1000 到元，spec §3）
      open.push(p.open ?? NaN)
      high.push(p.high ?? NaN)
      low.push(p.low ?? NaN)
      close.push(p.close ?? NaN)
      memberCounts.push(agg ? agg.memberCount : 0)
    }

    // 套公式：calcAmvSeries → calcMacd(amvClose) → calcSignal / calcZdf
    const amv = calcAmvSeries({ volume, open, high, low, close })
    const macd = calcMacd(amv.amvClose, 12, 26, 9)
    const zdf = calcZdf(amv.amvClose)

    // 裁掉热身段（< startDate）并丢弃 invalid / amvClose≤0 当日
    const rows: AmvDailyRow[] = []
    let coveredWarned = false
    for (let i = 0; i < tradeDates.length; i++) {
      const td = tradeDates[i]
      if (td < startDate) continue // 热身行，不落库
      if (amv.invalid[i]) continue
      const c = amv.amvClose[i]
      if (!(c > 0) || isNaN(c)) continue

      const mc = memberCounts[i]
      // 覆盖度 warn：当日有 amount 的成分股 < 当前名单总数
      if (mc < expectedMembers && !coveredWarned) {
        this.logger.warn(
          `[${label}-amv] 成分股覆盖不足：指数 ${idx} ${td} covered=${mc} expected=${expectedMembers}`,
        )
        coveredWarned = true
      }

      rows.push({
        tsCode: idx,
        tradeDate: td,
        amvOpen: amv.amvOpen[i],
        amvHigh: amv.amvHigh[i],
        amvLow: amv.amvLow[i],
        amvClose: c,
        amvDif: macd.dif[i],
        amvDea: macd.dea[i],
        amvMacd: macd.macd[i],
        amvZdf: zdf[i],
        signal: calcSignal(macd.dif[i], macd.macd[i]),
        memberCount: mc,
      })
    }

    if (rows.length === 0) {
      const msg = `${emptyApi}:${idx}: 裁热身/过滤异常后无可落库行`
      this.logger.warn(`[${label}-amv] ${msg}`)
      errors.push(msg)
      failedItems.push({ tsCode: idx, apiName: emptyApi, reason: '无有效指标行' })
      return 0
    }

    return this.persist(indexType, targetRepo, idx, rows, syncMode)
  }

  /**
   * 裸 SQL 聚合成分股当日 Σamount 与有 amount 的成分股数（member_count）。
   * 数组参数强转 ::text[]（database-sql 规则）。amount 为 numeric→string，由 SUM 在 DB 内聚合。
   * 返回 map：trade_date → { amt(千元数值), memberCount }。
   */
  private async aggregateAmount(
    conCodes: string[],
    startDate: string,
    endDate: string,
  ): Promise<Map<string, { amt: number; memberCount: number }>> {
    const sql = `
      SELECT trade_date,
             SUM(amount)            AS amt,
             COUNT(amount)          AS member_count
      FROM raw.daily_quote
      WHERE ts_code = ANY($1::text[])
        AND trade_date >= $2
        AND trade_date <= $3
        AND amount IS NOT NULL
      GROUP BY trade_date
    `
    const rows = (await this.dataSource.query(sql, [
      conCodes,
      startDate,
      endDate,
    ])) as AmtAggRow[]

    const map = new Map<string, { amt: number; memberCount: number }>()
    for (const r of rows) {
      map.set(r.trade_date, {
        amt: r.amt === null ? 0 : Number(r.amt),
        memberCount: r.member_count === null ? 0 : Number(r.member_count),
      })
    }
    return map
  }

  /**
   * 据交易行数确定热身起始日：在指数行情里取 < startDate 的第 WARMUP_ROWS 早的交易日，
   * 多取 WARMUP_ROWS 行供 SMA/EMA 预热（spec §6，本地表按行取即可）。
   */
  private async resolveWarmupStart(idx: string, startDate: string): Promise<string> {
    if (startDate === '00000000') return startDate
    const warmRows = await this.indexDailyRepo
      .createQueryBuilder('q')
      .select('q.tradeDate', 'tradeDate')
      .where('q.tsCode = :idx', { idx })
      .andWhere('q.tradeDate < :startDate', { startDate })
      .orderBy('q.tradeDate', 'DESC')
      .limit(WARMUP_ROWS)
      .getRawMany<{ tradeDate: string }>()
    if (warmRows.length === 0) return startDate
    // 取最早的那一行作 fetchStart（warmRows 已 DESC，最后一条最早）
    return warmRows[warmRows.length - 1].tradeDate
  }

  /**
   * upsert 落库到目标表。增量模式跳过已有 (tsCode, tradeDate)；upsert 前按 (tsCode, tradeDate) 去重。
   */
  private async persist(
    indexType: ThsIndexType,
    targetRepo: Repository<AmvDailyEntity>,
    idx: string,
    rows: AmvDailyRow[],
    syncMode: 'incremental' | 'overwrite',
  ): Promise<number> {
    const label = typeLabel(indexType)
    let toWrite = rows
    if (syncMode !== 'overwrite') {
      const existing = await targetRepo.find({
        where: { tsCode: idx },
        select: ['tradeDate'],
      })
      const existingSet = new Set(existing.map((e) => e.tradeDate))
      toWrite = rows.filter((r) => !existingSet.has(r.tradeDate))
      if (toWrite.length === 0) {
        this.logger.log(`[${label}-amv] 指数 ${idx} 增量无新数据`)
        return 0
      }
    }

    // upsert 前按 (tsCode, tradeDate) 去重，保留最后一条（database-sql 规则）
    const dedup = new Map<string, AmvDailyRow>()
    for (const r of toWrite) dedup.set(`${r.tsCode}|${r.tradeDate}`, r)
    const finalRows = [...dedup.values()]
    if (finalRows.length !== toWrite.length) {
      this.logger.warn(
        `[${label}-amv] 指数 ${idx} upsert 去重：原 ${toWrite.length} → ${finalRows.length}`,
      )
    }

    const entities = finalRows.map((r) => ({
      tsCode: r.tsCode,
      tradeDate: r.tradeDate,
      amvOpen: r.amvOpen,
      amvHigh: r.amvHigh,
      amvLow: r.amvLow,
      amvClose: r.amvClose,
      amvDif: r.amvDif,
      amvDea: r.amvDea,
      amvMacd: r.amvMacd,
      amvZdf: r.amvZdf,
      signal: r.signal,
      memberCount: r.memberCount ?? null,
    }))

    await targetRepo
      .createQueryBuilder()
      .insert()
      .into(targetRepo.target)
      .values(entities)
      .orUpdate(
        [
          'amv_open',
          'amv_high',
          'amv_low',
          'amv_close',
          'amv_dif',
          'amv_dea',
          'amv_macd',
          'amv_zdf',
          'signal',
          'member_count',
        ],
        ['ts_code', 'trade_date'],
      )
      .execute()

    this.logger.log(`[${label}-amv] 指数 ${idx} 落库 ${entities.length} 行`)
    return entities.length
  }

  /** 今日 YYYYMMDD（UTC 墙钟，避免本地 TZ 漂移；datetime 规则） */
  private todayYyyymmdd(): string {
    const d = new Date()
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  }
}
