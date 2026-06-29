import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Between, Repository } from 'typeorm'
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity'
import { StockAmvDailyEntity } from '../../entities/active-mv/stock-amv-daily.entity'
import { calcSignal } from './amv-formula'
import { normalizeAmvCalcState } from './amv-stream'
import { AmvCalcStateEntity } from '../../entities/raw/amv-calc-state.entity'
import { AmvWorkerPool } from '../../indicators/amv-worker-pool'
import type { AmvWorkerRow } from '../../indicators/amv-worker'
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
    @InjectRepository(AmvCalcStateEntity)
    private readonly amvCalcStateRepo: Repository<AmvCalcStateEntity>,
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
                await this.upsertRows(rows)
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
      amount: this.num(q.amount),
      open: this.num(q.qfqOpen),
      high: this.num(q.qfqHigh),
      low: this.num(q.qfqLow),
      close: this.num(q.qfqClose),
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
        amvOpen: this.finite(r.amvOpen),
        amvHigh: this.finite(r.amvHigh),
        amvLow: this.finite(r.amvLow),
        amvClose: this.finite(r.amvClose),
        amvDif: this.finite(r.amvDif),
        amvDea: this.finite(r.amvDea),
        amvMacd: this.finite(r.amvMacd),
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

  // ── PR-6③-a：个股 AMV dirty 续算（镜像 a-shares-indicator.recalculateDirtyIndicatorsForSymbol）──

  /**
   * 批量 dirty 续算（worker pool 并发）。读 amv_dirty_from_date → amv_calc_state seed → 续算 →
   * 只写 >= dirtyFrom 段 + 末尾 checkpoint → 清 dirty。无 seed（首跑 / 复权全历史脏）时全量重算。
   */
  async recalculateDirtyAmvForSymbols(
    tsCodes: string[],
    onProgress?: (current: number, total: number, tsCode: string) => void,
  ): Promise<{ synced: number; failedItems: NonNullable<AmvSyncResult['failedItems']> }> {
    const target = [...new Set(tsCodes)].filter((v) => v.length > 0).sort()
    if (target.length === 0) return { synced: 0, failedItems: [] }
    const pool = new AmvWorkerPool()
    let count = 0
    const failedItems: NonNullable<AmvSyncResult['failedItems']> = []
    let completed = 0
    try {
      for (let i = 0; i < target.length; i += STOCK_BATCH) {
        const batch = target.slice(i, i + STOCK_BATCH)
        await Promise.all(
          batch.map(async (tsCode) => {
            try {
              const r = await this.recalculateDirtyAmvForSymbol(tsCode, pool)
              if (r.status === 'empty') {
                // dirty 段无有效行：透出（data-integrity）；not_dirty 正常跳过不计失败。
                failedItems.push({ tsCode, apiName: 'stock_amv_empty' })
              } else if (r.status === 'synced') {
                count += r.count
              }
            } catch (err) {
              // 单股错误不拖垮整批：透出 failedItems，继续其余股。
              const msg = err instanceof Error ? err.message : String(err)
              this.logger.error(`recalculateDirtyAmv ${tsCode} 失败：${msg}`)
              failedItems.push({ tsCode, apiName: 'stock_amv_error', reason: msg })
            }
            onProgress?.(++completed, target.length, tsCode)
          }),
        )
      }
    } finally {
      await pool.terminate()
    }
    return { synced: count, failedItems }
  }

  private async recalculateDirtyAmvForSymbol(
    tsCode: string,
    pool: AmvWorkerPool,
  ): Promise<{ count: number; status: 'synced' | 'empty' | 'not_dirty' }> {
    // 1) 读 amv_dirty_from_date；无则不脏，跳过（not_dirty 不计失败）
    const dirtyRows = await this.dailyQuoteRepo.manager.query<Array<{ dirtyFrom: string | null }>>(
      `SELECT amv_dirty_from_date AS "dirtyFrom" FROM a_share_sync_states WHERE ts_code = $1`,
      [tsCode],
    )
    const dirtyFrom = dirtyRows[0]?.dirtyFrom
    if (!dirtyFrom) return { count: 0, status: 'not_dirty' }

    // 2) 取 seed：amv_calc_state 中 trade_date < dirtyFrom 的最后一行
    const seedRows = await this.dailyQuoteRepo.manager.query<
      Array<{ tradeDate: string; state: unknown }>
    >(
      `SELECT trade_date AS "tradeDate", state FROM raw.amv_calc_state
        WHERE ts_code = $1 AND trade_date < $2 ORDER BY trade_date DESC LIMIT 1`,
      [tsCode, dirtyFrom],
    )
    const seedState = normalizeAmvCalcState(seedRows[0]?.state)
    const seedTradeDate = seedState ? seedRows[0]?.tradeDate : null

    // 3) 加载 quote rows（seed 后 或 全量；过滤 qfq NULL，升序）
    const quoteRows = await this.loadAmvQuoteRows(
      tsCode,
      seedState && seedTradeDate ? seedTradeDate : null,
    )
    if (quoteRows.length === 0) return { count: 0, status: 'empty' }

    // 4) worker 续算（amount 千元，worker 内 ×1000）
    const workerRows: AmvWorkerRow[] = quoteRows.map((r) => ({
      tradeDate: r.tradeDate,
      amount: this.num(r.amount),
      open: this.num(r.qfqOpen),
      high: this.num(r.qfqHigh),
      low: this.num(r.qfqLow),
      close: this.num(r.qfqClose),
    }))
    const result = await pool.run(tsCode, workerRows, seedState)

    // 5) 映射落库行（裁 invalid；无 seed 时只保留 >= dirtyFrom）
    const out: StockAmvInsertRow[] = []
    for (let t = 0; t < result.rows.length; t++) {
      const r = result.rows[t]
      if (!seedState && r.tradeDate < dirtyFrom) continue
      if (r.invalid) continue
      if (!(r.amvClose > 0) || isNaN(r.amvClose)) continue
      out.push({
        tsCode,
        tradeDate: r.tradeDate,
        amvOpen: this.finite(r.amvOpen),
        amvHigh: this.finite(r.amvHigh),
        amvLow: this.finite(r.amvLow),
        amvClose: this.finite(r.amvClose),
        amvDif: this.finite(r.amvDif),
        amvDea: this.finite(r.amvDea),
        amvMacd: this.finite(r.amvMacd),
        amvZdf: r.amvZdf,
        signal: calcSignal(r.amvDif, r.amvMacd),
      })
    }
    if (out.length === 0) return { count: 0, status: 'empty' }

    // 6) upsert stock_amv_daily（dirty 段；upsertRows 内部按 tsCode|tradeDate 去重）
    await this.upsertRows(out)

    // 7) 末尾 checkpoint（finalState；覆盖后续增量续算）
    const lastTradeDate = quoteRows[quoteRows.length - 1].tradeDate
    await this.amvCalcStateRepo.upsert(
      this.amvCalcStateRepo.create({
        tsCode,
        tradeDate: lastTradeDate,
        state: result.finalState as unknown as Record<string, unknown>,
      }),
      ['tsCode', 'tradeDate'],
    )

    // 8) 清 amv_dirty_from_date，设 amv_calculated_to_date
    await this.dailyQuoteRepo.manager.query(
      `INSERT INTO a_share_sync_states (ts_code, amv_dirty_from_date, amv_calculated_to_date, updated_at)
       VALUES ($1, NULL, $2, now())
       ON CONFLICT (ts_code) DO UPDATE SET
         amv_dirty_from_date = NULL,
         amv_calculated_to_date = EXCLUDED.amv_calculated_to_date,
         updated_at = now()`,
      [tsCode, lastTradeDate],
    )
    return { count: out.length, status: 'synced' }
  }

  /**
   * 加载 daily_quote：传 afterDate 取 > afterDate（seed 后续算），传 null 取全量（首跑 / 无 seed）。
   * 过滤 qfq NULL（停牌 / 脏数据），升序。列映射与 a-shares-indicator.loadQuoteRows 一致。
   */
  private async loadAmvQuoteRows(
    tsCode: string,
    afterDate: string | null,
  ): Promise<
    Array<{
      tradeDate: string
      amount: string | null
      qfqOpen: string | null
      qfqHigh: string | null
      qfqLow: string | null
      qfqClose: string | null
    }>
  > {
    const cond = afterDate ? 'AND trade_date > $2' : ''
    const params = afterDate ? [tsCode, afterDate] : [tsCode]
    return this.dailyQuoteRepo.manager.query(
      `SELECT trade_date AS "tradeDate", amount, qfq_open AS "qfqOpen", qfq_high AS "qfqHigh", qfq_low AS "qfqLow", qfq_close AS "qfqClose"
         FROM raw.daily_quote
        WHERE ts_code = $1 ${cond}
          AND qfq_open IS NOT NULL AND qfq_high IS NOT NULL AND qfq_low IS NOT NULL AND qfq_close IS NOT NULL
        ORDER BY trade_date ASC`,
      params,
    )
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
