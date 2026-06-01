import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { LessThanOrEqual, Repository } from 'typeorm'
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity'
import { StockAmvDailyEntity } from '../../entities/active-mv/stock-amv-daily.entity'
import {
  calcAmvSeries,
  calcMacd,
  calcSignal,
  calcZdf,
} from './amv-formula'
import type {
  AmvSeriesRow,
  AmvSignal,
  AmvSignalRow,
  AmvSyncResult,
  StockAmvSyncOptions,
} from './active-mv.types'

/** 热身交易行数（spec §6：250 + 90，本地表按行倒取，无需自然日换算）。 */
const WARMUP_ROWS = 90

/** 每批落库的最大实体数（避免单条 INSERT 参数过多）。 */
const UPSERT_CHUNK = 1000

/** 个股同步逐股处理的并发批大小（spec §11.4：~4000 股按批，避免一次性吃满连接）。 */
const STOCK_BATCH = 50

/** 本 service 内部用的落库行（不污染 active-mv.types）。 */
interface StockAmvInsertRow {
  tsCode: string
  tradeDate: string
  amvOpen: number | null
  amvHigh: number | null
  amvLow: number | null
  amvClose: number | null
  amvDif: number | null
  amvDea: number | null
  amvMacd: number | null
  amvZdf: number | null
  signal: AmvSignal
}

/**
 * 个股活跃市值（AMV）服务。
 *
 * 读 raw.daily_quote 的前复权 qfq OHLC + amount（千元，计算时 ×1000），
 * 逐股套 calcAmvSeries → calcMacd → calcSignal/calcZdf，裁掉热身段后落 stock_amv_daily。
 */
@Injectable()
export class StockAmvService {
  private readonly logger = new Logger(StockAmvService.name)

  constructor(
    @InjectRepository(DailyQuoteEntity)
    private readonly dailyQuoteRepo: Repository<DailyQuoteEntity>,
    @InjectRepository(StockAmvDailyEntity)
    private readonly stockAmvRepo: Repository<StockAmvDailyEntity>,
  ) {}

  /**
   * 个股 AMV 增量同步落库。
   * spec §7：POST /active-mv/stock/sync { startDate, endDate, syncMode, tsCodes? }
   */
  async syncStock(opts: StockAmvSyncOptions = {}): Promise<AmvSyncResult> {
    const startDate = opts.startDate
    const endDate = opts.endDate
    if (!startDate || !endDate) {
      const reason = `缺少 startDate/endDate（startDate=${startDate}, endDate=${endDate}）`
      this.logger.warn(`syncStock 入参非法：${reason}`)
      return { synced: 0, errors: [reason] }
    }
    const overwrite = opts.syncMode === 'overwrite'

    // 目标个股：给定 tsCodes 则只算这些；否则全部 list_status='L' 的 A 股。
    const tsCodes = opts.tsCodes?.length
      ? Array.from(new Set(opts.tsCodes))
      : await this.listListedStocks()

    if (tsCodes.length === 0) {
      const reason = 'no_target_stocks：目标个股列表为空'
      this.logger.warn(`syncStock：${reason}（startDate=${startDate}, endDate=${endDate}）`)
      return { synced: 0, errors: [reason] }
    }

    this.logger.log(
      `syncStock 开始：${tsCodes.length} 股，范围 ${startDate}~${endDate}，` +
        `mode=${overwrite ? 'overwrite' : 'incremental'}`,
    )

    let synced = 0
    const errors: string[] = []
    const failedItems: NonNullable<AmvSyncResult['failedItems']> = []

    // 按批处理（结构上支持大批量；spec §11.4）。
    for (let i = 0; i < tsCodes.length; i += STOCK_BATCH) {
      const batch = tsCodes.slice(i, i + STOCK_BATCH)
      for (const tsCode of batch) {
        try {
          const rows = await this.computeStock(tsCode, startDate, endDate)
          if (rows.length === 0) {
            // 范围内 0 有效行：禁止伪装"已同步"（data-integrity）。
            this.logger.warn(`stock_amv_empty：${tsCode} 在 ${startDate}~${endDate} 无有效行`)
            failedItems.push({ tsCode, apiName: 'stock_amv_empty' })
            continue
          }

          let toWrite = rows
          if (!overwrite) {
            const existing = await this.stockAmvRepo.find({
              where: { tsCode },
              select: ['tradeDate'],
            })
            const existingSet = new Set(existing.map((e) => e.tradeDate))
            toWrite = rows.filter((r) => !existingSet.has(r.tradeDate))
            if (toWrite.length === 0) {
              // 增量模式下全部已存在：不算失败，跳过。
              continue
            }
          }

          await this.upsertRows(toWrite)
          synced += toWrite.length
        } catch (err) {
          // 禁止 .catch(()=>[]) 静默吞错：错误透出响应体 + 日志打印具体来源。
          const msg = err instanceof Error ? err.message : String(err)
          this.logger.error(`syncStock ${tsCode} 失败：${msg}`)
          if (err instanceof Error && err.stack) this.logger.error(err.stack)
          errors.push(`${tsCode}: ${msg}`)
          failedItems.push({ tsCode, apiName: 'stock_amv_error', reason: msg })
        }
      }
    }

    this.logger.log(
      `syncStock 完成：落库 ${synced} 行，失败/空 ${failedItems.length} 股，错误 ${errors.length} 条`,
    )

    const result: AmvSyncResult = { synced }
    if (errors.length) result.errors = errors
    if (failedItems.length) result.failedItems = failedItems
    return result
  }

  /**
   * 单股 AMV K 线 + DIF/DEA/柱 + signal（最近 days 个交易日）。
   * spec §7：GET /active-mv/stock/:tsCode?days=250
   */
  async getStock(tsCode: string, days: number): Promise<AmvSeriesRow[]> {
    const take = days > 0 ? days : 250
    // 不限制列时直接取全实体最稳（database-sql 规则：避免 .select() 水合坑）。
    const rows = await this.stockAmvRepo.find({
      where: { tsCode },
      order: { tradeDate: 'DESC' },
      take,
    })
    return rows.reverse().map((r) => this.toSeriesRow(r))
  }

  /**
   * 某交易日个股信号榜（按 signal DESC、DIF DESC 排序，走 INDEX(trade_date, signal)）。
   * spec §7：GET /active-mv/stock/signals?tradeDate=
   */
  async getStockSignals(tradeDate: string): Promise<AmvSignalRow[]> {
    if (!tradeDate) return []
    const rows = await this.stockAmvRepo.find({
      where: { tradeDate },
      order: { signal: 'DESC', amvDif: 'DESC' },
    })
    return rows.map((r) => ({
      tsCode: r.tsCode,
      tradeDate: r.tradeDate,
      amvDif: r.amvDif ?? 0,
      amvMacd: r.amvMacd ?? 0,
      signal: this.toSignal(r.signal),
    }))
  }

  // ===================== 内部实现 =====================

  /**
   * 全部 list_status='L' 的 A 股代码。
   * 模块未注册 a_share_symbols 实体，借 manager.query 走裸 SQL（显式列别名，无水合坑）。
   */
  private async listListedStocks(): Promise<string[]> {
    const rows: Array<{ ts_code: string }> = await this.dailyQuoteRepo.manager.query(
      `SELECT ts_code FROM a_share_symbols WHERE list_status = 'L' ORDER BY ts_code`,
    )
    return rows.map((r) => r.ts_code).filter(Boolean)
  }

  /**
   * 取单股 [startDate..endDate] + 向前 90 个交易行热身，套公式，裁掉热身段，
   * 返回 startDate..endDate 内的有效落库行（invalid 或 amvClose≤0 的当日不落）。
   */
  private async computeStock(
    tsCode: string,
    startDate: string,
    endDate: string,
  ): Promise<StockAmvInsertRow[]> {
    // 本地表按 tradeDate 升序取 <= endDate 的全部行，再在内存里截 [前90行热身 .. endDate]。
    const quotes = await this.dailyQuoteRepo.find({
      where: { tsCode, tradeDate: LessThanOrEqual(endDate) },
      order: { tradeDate: 'ASC' },
    })
    if (quotes.length === 0) return []

    // 第一个 >= startDate 的下标；其前 90 行作热身。
    let firstInRange = quotes.findIndex((q) => q.tradeDate >= startDate)
    if (firstInRange === -1) {
      // 全部行都 < startDate（该范围无行情），无可落数据。
      return []
    }
    const warmupStart = Math.max(0, firstInRange - WARMUP_ROWS)
    const window = quotes.slice(warmupStart)
    // window 内 [startDate..endDate] 的起始下标（裁热身用）。
    const rangeStart = firstInRange - warmupStart

    // 构造公式入参：volume = amount(千元)×1000 到元；价用 qfq OHLC。
    const volume = window.map((q) => this.num(q.amount) * 1000)
    const open = window.map((q) => this.num(q.qfqOpen))
    const high = window.map((q) => this.num(q.qfqHigh))
    const low = window.map((q) => this.num(q.qfqLow))
    const close = window.map((q) => this.num(q.qfqClose))

    const series = calcAmvSeries({ volume, open, high, low, close })
    const macd = calcMacd(series.amvClose, 12, 26, 9)
    const zdf = calcZdf(series.amvClose)

    const out: StockAmvInsertRow[] = []
    for (let t = rangeStart; t < window.length; t++) {
      const tradeDate = window[t].tradeDate
      if (tradeDate > endDate) break // 升序，越过 endDate 即可停。
      // 异常处置：当日不产指标 → 不落（spec §3.1 / §9）。
      if (series.invalid[t]) continue
      const amvClose = series.amvClose[t]
      if (!(amvClose > 0) || isNaN(amvClose)) continue

      const dif = macd.dif[t]
      const bar = macd.macd[t]
      out.push({
        tsCode,
        tradeDate,
        amvOpen: this.finite(series.amvOpen[t]),
        amvHigh: this.finite(series.amvHigh[t]),
        amvLow: this.finite(series.amvLow[t]),
        amvClose: this.finite(amvClose),
        amvDif: this.finite(dif),
        amvDea: this.finite(macd.dea[t]),
        amvMacd: this.finite(bar),
        amvZdf: zdf[t],
        signal: calcSignal(dif, bar),
      })
    }
    return out
  }

  /**
   * upsert 落库：分块 + 按 (tsCode, tradeDate) 去重保留最后一条
   * （database-sql：同批重复键会 cannot affect row a second time）。
   */
  private async upsertRows(rows: StockAmvInsertRow[]): Promise<void> {
    const dedup = new Map<string, StockAmvInsertRow>()
    for (const r of rows) dedup.set(`${r.tsCode}|${r.tradeDate}`, r)
    const unique = Array.from(dedup.values())
    if (unique.length !== rows.length) {
      this.logger.warn(
        `upsertRows 去重：原 ${rows.length} 行 → 去重后 ${unique.length} 行（${rows[0]?.tsCode}）`,
      )
    }

    for (let i = 0; i < unique.length; i += UPSERT_CHUNK) {
      const chunk = unique.slice(i, i + UPSERT_CHUNK)
      await this.stockAmvRepo
        .createQueryBuilder()
        .insert()
        .into(StockAmvDailyEntity)
        .values(
          chunk.map((r) => ({
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
          })),
        )
        .orUpdate(
          ['amv_open', 'amv_high', 'amv_low', 'amv_close', 'amv_dif', 'amv_dea', 'amv_macd', 'amv_zdf', 'signal'],
          ['ts_code', 'trade_date'],
        )
        .execute()
    }
  }

  /** numeric→string 列转数值（用前 Number()）；空/非数落 NaN。 */
  private num(v: string | null | undefined): number {
    if (v === null || v === undefined) return NaN
    return Number(v)
  }

  /** double precision 列：非有限值落 null（不写 Inf/NaN）。 */
  private finite(v: number): number | null {
    return Number.isFinite(v) ? v : null
  }

  private toSignal(v: number): AmvSignal {
    return v > 0 ? 1 : v < 0 ? -1 : 0
  }

  private toSeriesRow(r: StockAmvDailyEntity): AmvSeriesRow {
    return {
      tradeDate: r.tradeDate,
      amvOpen: r.amvOpen ?? 0,
      amvHigh: r.amvHigh ?? 0,
      amvLow: r.amvLow ?? 0,
      amvClose: r.amvClose ?? 0,
      amvDif: r.amvDif ?? 0,
      amvDea: r.amvDea ?? 0,
      amvMacd: r.amvMacd ?? 0,
      amvZdf: r.amvZdf,
      signal: this.toSignal(r.signal),
    }
  }
}
