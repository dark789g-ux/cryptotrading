import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Between, Repository } from 'typeorm'
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity'
import { StockAmvDailyEntity } from '../../entities/active-mv/stock-amv-daily.entity'
import { calcSignal } from './amv-formula'
import { AmvWorkerPool } from '../../indicators/amv-worker-pool'
import type { AmvWorkerRow } from '../../indicators/amv-worker'
import { num, finite } from './amv-sync-helpers'
import { StockAmvDirtyService, STOCK_BATCH } from './stock-amv-dirty.service'
import type { StockAmvInsertRow } from './stock-amv-dirty.service'
import type {
  AmvSeriesRow,
  AmvSignal,
  AmvSignalRow,
  AmvSyncResult,
  StockAmvSyncOptions,
} from './active-mv.types'

/** 热身交易行数（spec §6：250 + 90，本地表按行倒取，无需自然日换算）。 */
const WARMUP_ROWS = 90

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
    private readonly dirtyService: StockAmvDirtyService,
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

    if (overwrite) {
      // 全量回填：computeStock 窗口读取（PR-3①）+ worker pool 多线程（PR-5②），所有股重算覆盖。
      const pool = new AmvWorkerPool()
      try {
        for (let i = 0; i < tsCodes.length; i += STOCK_BATCH) {
          const batch = tsCodes.slice(i, i + STOCK_BATCH)
          await Promise.all(
            batch.map(async (tsCode) => {
              try {
                const rows = await this.computeStock(tsCode, startDate, endDate, pool)
                if (rows.length === 0) {
                  // 范围内 0 有效行：禁止伪装"已同步"（data-integrity）。
                  this.logger.warn(`stock_amv_empty：${tsCode} 在 ${startDate}~${endDate} 无有效行`)
                  failedItems.push({ tsCode, apiName: 'stock_amv_empty' })
                  return
                }
                await this.dirtyService.upsertRows(rows)
                synced += rows.length
              } catch (err) {
                // 禁止 .catch(()=>[]) 静默吞错：错误透出响应体 + 日志打印具体来源。
                const msg = err instanceof Error ? err.message : String(err)
                this.logger.error(`syncStock ${tsCode} 失败：${msg}`)
                if (err instanceof Error && err.stack) this.logger.error(err.stack)
                errors.push(`${tsCode}: ${msg}`)
                failedItems.push({ tsCode, apiName: 'stock_amv_error', reason: msg })
              }
            }),
          )
        }
      } finally {
        await pool.terminate()
      }
    } else {
      // 增量：dirty 续算（PR-6③-a）。只算 amv_dirty_from_date 非空的股（由 a-shares-sync 的
      // markDirtyRanges 在 daily_quote / 复权变动时标记）。recalculateDirtyAmvForSymbols 内部
      // 用 AmvWorkerPool 并发 + calcAmvStreaming(seed) 续算，data-integrity 透出 failedItems。
      const dirty = await this.recalculateDirtyAmvForSymbols(tsCodes)
      synced = dirty.synced
      failedItems.push(...dirty.failedItems)
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
    pool: AmvWorkerPool,
  ): Promise<StockAmvInsertRow[]> {
    // 仅取 [fetchStart..endDate]：fetchStart = startDate 前 WARMUP_ROWS 个交易日的最早日，
    // 含热身段；等价于旧实现「取全部历史再内存 slice」，但只读必要窗口，省 IO（① 优化）。
    const fetchStart = await this.resolveWarmupStart(tsCode, startDate)
    const window = await this.dailyQuoteRepo.find({
      where: { tsCode, tradeDate: Between(fetchStart, endDate) },
      order: { tradeDate: 'ASC' },
    })
    if (window.length === 0) return []

    // window 内第一个 >= startDate 的下标（裁热身段用）。
    const rangeStart = window.findIndex((q) => q.tradeDate >= startDate)
    if (rangeStart === -1) {
      // 全部行都 < startDate（该范围无行情），无可落数据。
      return []
    }

    // 映射 worker 入参（已 num 化；amount 千元，worker 内 ×1000，避双换算）。
    const workerRows: AmvWorkerRow[] = window.map((q) => ({
      tradeDate: q.tradeDate,
      amount: num(q.amount),
      open: num(q.qfqOpen),
      high: num(q.qfqHigh),
      low: num(q.qfqLow),
      close: num(q.qfqClose),
    }))

    // 多线程计算（pool 内部 ≤4 worker；calcAmvStreaming 与数组版逐行等价，amv-stream.spec 锁死）。
    const result = await pool.run(tsCode, workerRows, null)

    const out: StockAmvInsertRow[] = []
    for (let t = rangeStart; t < result.rows.length; t++) {
      const r = result.rows[t]
      if (r.tradeDate > endDate) break // 升序，越过 endDate 即可停。
      // 异常处置：当日不产指标 → 不落（spec §3.1 / §9）。
      if (r.invalid) continue
      if (!(r.amvClose > 0) || isNaN(r.amvClose)) continue

      out.push({
        tsCode,
        tradeDate: r.tradeDate,
        amvOpen: finite(r.amvOpen),
        amvHigh: finite(r.amvHigh),
        amvLow: finite(r.amvLow),
        amvClose: finite(r.amvClose),
        amvDif: finite(r.amvDif),
        amvDea: finite(r.amvDea),
        amvMacd: finite(r.amvMacd),
        amvZdf: r.amvZdf,
        signal: calcSignal(r.amvDif, r.amvMacd),
      })
    }
    return out
  }

  /**
   * 据交易行数确定热身起始日：取 < startDate 的最近 WARMUP_ROWS 个交易日里最早的一个作 fetchStart
   * （镜像 industry-amv.resolveWarmupStart；窗口与旧实现「全量+slice」逐位等价，仅省 IO）。
   */
  private async resolveWarmupStart(tsCode: string, startDate: string): Promise<string> {
    if (startDate === '00000000') return startDate
    const warmRows = await this.dailyQuoteRepo
      .createQueryBuilder('q')
      .select('q.tradeDate', 'tradeDate')
      .where('q.tsCode = :tsCode', { tsCode })
      .andWhere('q.tradeDate < :startDate', { startDate })
      .orderBy('q.tradeDate', 'DESC')
      .limit(WARMUP_ROWS)
      .getRawMany<{ tradeDate: string }>()
    if (warmRows.length === 0) return startDate
    // warmRows 已 DESC，最后一条最早 —— 作 fetchStart（往前含 WARMUP_ROWS 行热身）。
    return warmRows[warmRows.length - 1].tradeDate
  }

  // ── 代理 dirty service（保持 public 同签名，供 active-mv.service / a-shares-sync 调用）──

  /**
   * 批量 dirty 续算（代理到 StockAmvDirtyService）。
   * 被 active-mv.service.ts:41 和 a-shares-sync.service.ts:263 调用。
   */
  async recalculateDirtyAmvForSymbols(
    tsCodes: string[],
    onProgress?: (current: number, total: number, tsCode: string) => void,
  ): Promise<{ synced: number; failedItems: NonNullable<AmvSyncResult['failedItems']> }> {
    return this.dirtyService.recalculateDirtyAmvForSymbols(tsCodes, onProgress)
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
