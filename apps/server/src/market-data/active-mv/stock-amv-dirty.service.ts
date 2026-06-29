import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity'
import { StockAmvDailyEntity } from '../../entities/active-mv/stock-amv-daily.entity'
import { AmvCalcStateEntity } from '../../entities/raw/amv-calc-state.entity'
import { calcSignal } from './amv-formula'
import { normalizeAmvCalcState } from './amv-stream'
import { AmvWorkerPool } from '../../indicators/amv-worker-pool'
import type { AmvWorkerRow } from '../../indicators/amv-worker'
import { num, finite } from './amv-sync-helpers'
import type { AmvSignal, AmvSyncResult } from './active-mv.types'

/** 每批落库的最大实体数（避免单条 INSERT 参数过多）。 */
const UPSERT_CHUNK = 1000

/** 个股同步逐股处理的并发批大小（spec §11.4：~4000 股按批，避免一次性吃满连接）。 */
export const STOCK_BATCH = 50

/** 落库行接口（主 service computeStock 也 import）。 */
export interface StockAmvInsertRow {
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
 * 个股 AMV dirty 续算服务。
 *
 * 从 StockAmvService 拆出：读 amv_dirty_from_date → amv_calc_state seed → 续算 →
 * 只写 >= dirtyFrom 段 + 末尾 checkpoint → 清 dirty。无 seed（首跑 / 复权全历史脏）时全量重算。
 */
@Injectable()
export class StockAmvDirtyService {
  private readonly logger = new Logger(StockAmvDirtyService.name)

  constructor(
    @InjectRepository(DailyQuoteEntity)
    private readonly dailyQuoteRepo: Repository<DailyQuoteEntity>,
    @InjectRepository(StockAmvDailyEntity)
    private readonly stockAmvRepo: Repository<StockAmvDailyEntity>,
    @InjectRepository(AmvCalcStateEntity)
    private readonly amvCalcStateRepo: Repository<AmvCalcStateEntity>,
  ) {}

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
      amount: num(r.amount),
      open: num(r.qfqOpen),
      high: num(r.qfqHigh),
      low: num(r.qfqLow),
      close: num(r.qfqClose),
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
   * public —— 供主 service computeStock 调用。
   */
  async upsertRows(rows: StockAmvInsertRow[]): Promise<void> {
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
}
