import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity'
import { TushareClientService } from '../a-shares/services/tushare-client.service'
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
    private readonly tushareClient: TushareClientService,
  ) {}

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
   * 从 Tushare 同步 0AMV 数据
   */
  async sync0amv(days: number = 60): Promise<{ synced: number }> {
    this.logger.log(`开始同步 0AMV 数据，天数: ${days}`)

    // 计算日期范围
    const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const startDate = new Date(Date.now() - (days + 20) * 86400000).toISOString().slice(0, 10).replace(/-/g, '')

    // 从 Tushare 拉取 930903.CSI 数据
    const fields = 'trade_date,open,high,low,close,amount'
    const rows = await this.tushareClient.query('index_daily', {
      ts_code: '930903.CSI',
      start_date: startDate,
      end_date: endDate,
    }, fields)

    if (!rows || rows.length === 0) {
      this.logger.warn('Tushare 返回空数据')
      return { synced: 0 }
    }

    this.logger.log(`从 Tushare 获取到 ${rows.length} 条数据`)

    // 转换为 TushareIndexDaily 类型
    const indexData: TushareIndexDaily[] = rows.map(r => ({
      trade_date: String(r.trade_date),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      amount: Number(r.amount),
    }))

    // 计算 0AMV
    const calcResults = this.calc0amv(indexData)

    // 过滤无效值并保存
    const validResults = calcResults.filter(r =>
      !isNaN(r.open) && !isNaN(r.high) && !isNaN(r.low) && !isNaN(r.close)
    )

    if (validResults.length === 0) {
      this.logger.warn('计算结果为空')
      return { synced: 0 }
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
      .orUpdate(['open', 'high', 'low', 'close'], ['tradeDate'])
      .execute()

    this.logger.log(`同步完成，保存 ${entities.length} 条数据`)
    return { synced: entities.length }
  }

  /**
   * 查询 0AMV 数据
   */
  async get0amvData(days: number = 250): Promise<OamvDailyEntity[]> {
    return this.repo.find({
      order: { tradeDate: 'ASC' },
      take: days,
    })
  }
}
