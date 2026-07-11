import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import {
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
  type FindOptionsWhere,
} from 'typeorm'
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity'
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity'
import {
  calcKdjSeries,
  isCustomKdjParams,
  roundKdjPoint,
} from '../../indicators/kdj'
import { buildIndicatorArrays } from './oamv-indicators'
import type { OamvCalcResult, TushareIndexDaily } from './oamv.types'

// 0AMV 参数
const OAMVN = 10
const OAMVK = 0.87
const OAMV_AMOUNT_DIV = 1_000_000

@Injectable()
export class OamvService {
  private readonly logger = new Logger(OamvService.name)

  constructor(
    @InjectRepository(OamvDailyEntity)
    private readonly repo: Repository<OamvDailyEntity>,
    @InjectRepository(IndexDailyQuoteEntity)
    private readonly indexDailyRepo: Repository<IndexDailyQuoteEntity>,
  ) {}

  /**
   * 在 YYYYMMDD 字符串上加减自然日（按 UTC 计算，避免本地 TZ 漂移）
   */
  private shiftYyyymmdd(yyyymmdd: string, deltaDays: number): string {
    const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00Z`
    const t = new Date(iso).getTime() + deltaDays * 86400000
    const d = new Date(t)
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  }

  /**
   * 通达信风格 SMA 递推计算
   */
  private tdSma(values: number[], n: number = 10, m: number = 1): number[] {
    const result: number[] = []
    let sma: number | null = null

    for (const x of values) {
      if (x === null || x === undefined || isNaN(x)) {
        result.push(NaN)
        continue
      }
      if (sma === null) {
        sma = x
      } else {
        sma = (m * x + (n - m) * sma) / n
      }
      result.push(sma)
    }

    return result
  }

  /**
   * 通达信风格 EMA 递推计算
   */
  private tdEma(values: number[], n: number = 12): number[] {
    const result: number[] = []
    let ema: number | null = null

    for (const x of values) {
      if (x === null || x === undefined || isNaN(x)) {
        result.push(NaN)
        continue
      }
      if (ema === null) {
        ema = x
      } else {
        ema = (2 * x + (n - 1) * ema) / (n + 1)
      }
      result.push(ema)
    }

    return result
  }

  /**
   * 计算 0AMV 指标
   */
  calc0amv(data: TushareIndexDaily[]): OamvCalcResult[] {
    if (data.length === 0) return []

    // 按日期排序
    const sorted = [...data].sort((a, b) => a.trade_date.localeCompare(b.trade_date))

    // Step 1: 成交额平滑（tushare amount 单位是千元，需先 ×1000）
    const amountYuan = sorted.map(d => d.amount * 1000)
    const oamvv1Raw = this.tdSma(amountYuan, OAMVN, 1)
    const oamvv1 = oamvv1Raw.map(v => v / OAMV_AMOUNT_DIV)

    // Step 2: 价格基准（前一日收盘价的5日均线）
    const closes = sorted.map(d => d.close)
    const refClose1 = [NaN, ...closes.slice(0, -1)] // REF(CLOSE, 1)
    const oamvv3: number[] = []
    for (let i = 0; i < refClose1.length; i++) {
      const start = Math.max(0, i - 4)
      const window = refClose1.slice(start, i + 1).filter(v => !isNaN(v))
      oamvv3.push(window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : NaN)
    }

    // Step 3: OAMV 四价
    const multiplier = 0.1 * OAMVK
    const results: OamvCalcResult[] = sorted.map((d, i) => ({
      tradeDate: d.trade_date,
      open: oamvv1[i] * d.open / oamvv3[i] * multiplier,
      high: oamvv1[i] * d.high / oamvv3[i] * multiplier,
      low: oamvv1[i] * d.low / oamvv3[i] * multiplier,
      close: oamvv1[i] * d.close / oamvv3[i] * multiplier,
    }))

    return results
  }

  /**
   * 查询 0AMV 数据的日期范围（已落库的最早和最晚交易日）
   */
  async getDateRange(): Promise<{ min: string | null; max: string | null }> {
    const result = await this.repo
      .createQueryBuilder('o')
      .select('MIN(o.tradeDate)', 'min')
      .addSelect('MAX(o.tradeDate)', 'max')
      .getRawOne<{ min: string | null; max: string | null }>()
    return result ?? { min: null, max: null }
  }

  /**
   * 从 Tushare 同步 0AMV 数据
   */
  async sync0amv(options: {
    startDate?: string
    endDate?: string
    syncMode?: 'incremental' | 'overwrite'
    /** 一键同步编排器注入的中断信号 */
    signal?: AbortSignal
  } = {}): Promise<{ synced: number }> {
    this.logger.log(`开始同步 0AMV 数据，参数: ${JSON.stringify(options)}`)

    if (options.signal?.aborted) throw new DOMException('Sync aborted', 'AbortError')

    // 计算日期范围
    const endDate = options.endDate
      ?? new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const startDate = options.startDate
      ?? new Date(Date.now() - 80 * 86400000).toISOString().slice(0, 10).replace(/-/g, '')

    // SMA 类指标需要前置历史数据热身（oamvv1 用 10 日 SMA，oamvv3 用 REF(CLOSE,1) 的 5 日均线），
    // Tushare 查询窗口必须比保存窗口向前扩展，否则首行 refClose1=NaN 会让整段计算结果为 NaN。
    // 30 自然日（约 20 交易日）足够使 oamvv3/oamvv1 在 startDate 之前完成预热。
    const WARMUP_DAYS = 30
    const fetchStartDate = this.shiftYyyymmdd(startDate, -WARMUP_DAYS)

    // 从本地 index_daily_quotes 读 930903.CSI（PR-4：不再自连 Tushare，复用 Step5 大盘行情管线已落库的数据；
    // 数据连续性依赖 Step5 已同步 930903.CSI 历史段）。本地 amount 同为千元，calc0amv 内 ×1000 不变。
    const rows = await this.indexDailyRepo.find({
      where: {
        tsCode: '930903.CSI',
        tradeDate: Between(fetchStartDate, endDate),
      },
      order: { tradeDate: 'ASC' },
    })

    if (!rows || rows.length === 0) {
      this.logger.warn(
        `0AMV 本地无数据：index_daily_quotes 930903.CSI ${fetchStartDate}~${endDate} 为空（确认 Step5 已同步该指数历史段）`,
      )
      return { synced: 0 }
    }

    this.logger.log(`从本地 index_daily_quotes 读到 ${rows.length} 条 930903.CSI 数据`)

    // 映射成 calc0amv 入参（实体 open/high/low/close/amount 为 number|null，null→NaN 让递推正确跳过）
    const indexData: TushareIndexDaily[] = rows.map((r) => ({
      trade_date: r.tradeDate,
      open: r.open ?? NaN,
      high: r.high ?? NaN,
      low: r.low ?? NaN,
      close: r.close ?? NaN,
      amount: r.amount ?? NaN,
    }))

    // 计算 0AMV
    const calcResults = this.calc0amv(indexData)

    // 过滤无效值；并截掉用于热身但不属于用户请求范围的早期日期
    const validResults = calcResults.filter(r =>
      r.tradeDate >= startDate
      && !isNaN(r.open) && !isNaN(r.high) && !isNaN(r.low) && !isNaN(r.close)
    )

    if (validResults.length === 0) {
      this.logger.warn(`计算结果为空（Tushare 返回 ${rows.length} 行，含热身窗口 ${fetchStartDate}~${endDate}，用户范围 ${startDate}~${endDate}）`)
      return { synced: 0 }
    }

    // 增量模式：跳过已有日期
    if (options.syncMode !== 'overwrite') {
      const existing = await this.repo.find({ select: ['tradeDate'] })
      const existingSet = new Set(existing.map((e) => e.tradeDate))
      const before = validResults.length
      const newResults = validResults.filter((r) => !existingSet.has(r.tradeDate))
      if (newResults.length === 0) {
        this.logger.log(`增量同步：无新数据（已有 ${before} 条）`)
        return { synced: 0 }
      }
      validResults.splice(0, validResults.length, ...newResults)
      this.logger.log(`增量同步：跳过 ${before - validResults.length} 条已有数据，新增 ${validResults.length} 条`)
    }

    // 使用 upsert 去重保存
    const entities = validResults.map(r => ({
      tradeDate: r.tradeDate,
      open: r.open.toFixed(2),
      high: r.high.toFixed(2),
      low: r.low.toFixed(2),
      close: r.close.toFixed(2),
    }))

    await this.repo
      .createQueryBuilder()
      .insert()
      .into(OamvDailyEntity)
      .values(entities)
      .orUpdate(['open', 'high', 'low', 'close'], ['trade_date'])
      .execute()

    this.logger.log(`同步完成，保存 ${entities.length} 条数据`)

    // MACD/MA/KDJ 均为递推或窗口指标，增量算会与全历史口径漂移；
    // 序列总量仅千行级，每次 sync 后全量重算所有指标列，保证整段自洽。
    await this.recomputeIndicatorsAll()

    return { synced: entities.length }
  }

  /**
   * 从 DB 全量序列重算 0AMV 所有技术指标并写库：
   *   - MACD（amv_dif/amv_dea/amv_macd）：通达信式 tdEma 12/26/9，口径不变；
   *   - MA5/MA30/MA60/MA120/MA240：严格 SMA，不足期为 null；
   *   - KDJ K/D/J：9日窗口，初始种子 50。
   */
  async recomputeIndicatorsAll(): Promise<{ updated: number }> {
    const rows = await this.repo.find({
      select: ['tradeDate', 'open', 'high', 'low', 'close'],
      order: { tradeDate: 'ASC' },
    })
    if (rows.length === 0) {
      this.logger.warn('recomputeIndicatorsAll：oamv_daily 为空，跳过')
      return { updated: 0 }
    }

    const {
      tradeDates,
      dif: difArr,
      dea: deaArr,
      macd: macdArr,
      ma5: ma5Arr,
      ma30: ma30Arr,
      ma60: ma60Arr,
      ma120: ma120Arr,
      ma240: ma240Arr,
      kdjK: kdjKArr,
      kdjD: kdjDArr,
      kdjJ: kdjJArr,
    } = buildIndicatorArrays(rows)

    await this.repo.query(
      `UPDATE oamv_daily o
          SET amv_dif  = u.dif,
              amv_dea  = u.dea,
              amv_macd = u.macd,
              ma5      = u.ma5,
              ma30     = u.ma30,
              ma60     = u.ma60,
              ma120    = u.ma120,
              ma240    = u.ma240,
              kdj_k    = u.kdj_k,
              kdj_d    = u.kdj_d,
              kdj_j    = u.kdj_j
         FROM unnest(
                $1::text[],
                $2::float8[], $3::float8[], $4::float8[],
                $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[],
                $10::float8[], $11::float8[], $12::float8[]
              ) AS u(trade_date, dif, dea, macd, ma5, ma30, ma60, ma120, ma240, kdj_k, kdj_d, kdj_j)
        WHERE o.trade_date = u.trade_date`,
      [tradeDates, difArr, deaArr, macdArr, ma5Arr, ma30Arr, ma60Arr, ma120Arr, ma240Arr, kdjKArr, kdjDArr, kdjJArr],
    )

    this.logger.log(`recomputeIndicatorsAll：全量重算 MACD/MA/KDJ 完成，更新 ${rows.length} 行`)
    return { updated: rows.length }
  }

  /**
   * 查询 0AMV 数据。
   * - 传 range（startDate/endDate，YYYYMMDD）：按 trade_date 闭区间过滤、升序返回，忽略 days
   *   （trade_date 为 varchar(8) YYYYMMDD，字典序即时间序；MA/KDJ/MACD 是 sync 后全量重算落库的
   *   存值，窗口读取直接返回、无需热身重算）。
   * - 不传 range：取最近 days 条、升序返回（面板默认"看近期象限"窗口）。
   */
  async get0amvData(
    days: number = 250,
    range?: { startDate?: string; endDate?: string },
  ): Promise<OamvDailyEntity[]> {
    if (range && (range.startDate || range.endDate)) {
      const where: FindOptionsWhere<OamvDailyEntity> = {}
      if (range.startDate && range.endDate) {
        where.tradeDate = Between(range.startDate, range.endDate)
      } else if (range.startDate) {
        where.tradeDate = MoreThanOrEqual(range.startDate)
      } else if (range.endDate) {
        where.tradeDate = LessThanOrEqual(range.endDate)
      }
      return this.repo.find({ where, order: { tradeDate: 'ASC' } })
    }
    const rows = await this.repo.find({
      order: { tradeDate: 'DESC' },
      take: days,
    })
    return rows.reverse()
  }

  /**
   * 按自定义 KDJ 参数重新计算 0AMV 指标序列。
   *
   * - 复用 get0amvData() 的查询逻辑（已按 trade_date ASC 排列）；
   * - 仅当 kdjParams 为有效自定义参数时，用 calcKdjSeries 重算 KDJ 序列；
   * - 替换 kdjK / kdjD / kdjJ 三列，其余字段（MACD/MA/0AMV OHLC 等）保持原值；
   * - 返回字段形状与 get0amvData() 完全一致（OamvDailyEntity 数组）。
   */
  async recalcKlines(
    days: number = 250,
    range?: { startDate?: string; endDate?: string },
    kdjParams?: { n: number; m1: number; m2: number },
  ): Promise<OamvDailyEntity[]> {
    const rows = await this.get0amvData(days, range)

    if (!kdjParams || !isCustomKdjParams(kdjParams)) {
      return rows
    }

    const kdjSeries = calcKdjSeries(
      rows.map((r) => ({
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
      })),
      kdjParams.n,
      kdjParams.m1,
      kdjParams.m2,
    )

    return rows.map((row, index) => {
      const kdj = roundKdjPoint(kdjSeries[index])
      return {
        ...row,
        kdjK: kdj.k,
        kdjD: kdj.d,
        kdjJ: kdj.j,
      }
    })
  }
}
