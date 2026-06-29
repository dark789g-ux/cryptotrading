/**
 * AMV 同步跨 service 共享纯函数 + 常量。
 *
 * 不注册为 NestJS provider（无 @Injectable），各 service 直接 import 调用。
 * this.dataSource / this.xxxRepo / this.logger 由调用方作参数传入。
 */

import { Logger } from '@nestjs/common'
import type { DataSource, Repository } from 'typeorm'
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity'
import {
  calcAmvSeries,
  calcMacd,
  calcSignal,
  calcZdf,
} from './amv-formula'
import type { AmvDailyEntityLike } from './amv-series-query'
import type { AmvDailyRow, AmvSyncMode } from './active-mv.types'

// ── 共享常量 ───────────────────────────────────────────────────────────────

/** 额外多取的热身交易行数（spec §6：250 + 90，EMA26 ~90 根收敛到 0.1%） */
export const WARMUP_ROWS = 90

/**
 * 量侧成分股后缀（个股代码）。
 * 真实 ths_member_stocks 的 con_code 含沪深（.SZ/.SH）外，还有北交所 .BJ、新三板 .NQ——
 * 均为合法成分股，断言只用于 catch 严重错配（如 con_code 误存成 .TI 指数代码），不得因 .BJ/.NQ 崩。
 * 这类标的若不在 raw.daily_quote 中，量 join 自然不匹配，计入覆盖度 warn 即可。
 */
export const STOCK_SUFFIX_RE = /\.(SZ|SH|BJ|NQ)$/i

// ── 共享接口 ───────────────────────────────────────────────────────────────

/** 裸 SQL 聚合量返回的单行 */
export interface AmtAggRow {
  trade_date: string
  amt: string | null
  member_count: string | null
}

// ── aggregateAmount（industry/sw 共用裸 SQL）────────────────────────────────

/**
 * 裸 SQL 聚合成分股当日 Σamount 与有 amount 的成分股数（member_count）。
 * 数组参数强转 ::text[]（database-sql 规则）。amount 为 numeric→string，由 SUM 在 DB 内聚合。
 * 返回 map：trade_date → { amt(千元数值), memberCount }。
 */
export async function aggregateAmount(
  dataSource: DataSource,
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
  const rows = (await dataSource.query(sql, [
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

// ── todayYyyymmdd（industry/sw 共用）──────────────────────────────────────

/** 今日 YYYYMMDD（UTC 墙钟，避免本地 TZ 漂移；datetime 规则） */
export function todayYyyymmdd(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

// ── resolveIndexDailyWarmupStart（industry/sw 共享，可选 category 过滤）──

/**
 * 据交易行数确定热身起始日：在 index_daily_quotes 里取 < startDate 的第 WARMUP_ROWS 早的交易日，
 * 多取 WARMUP_ROWS 行供 SMA/EMA 预热（spec §6，本地表按行取即可）。
 *
 * 仅 industry/sw 共享（同用 IndexDailyQuoteEntity）。
 * - industry 不传 category（无过滤）
 * - sw 传 'sw'（实现内 `if (category)` 才追加 andWhere，保证 industry 路径不误加过滤）
 */
export async function resolveIndexDailyWarmupStart(
  idx: string,
  startDate: string,
  repo: Repository<IndexDailyQuoteEntity>,
  category?: string,
): Promise<string> {
  if (startDate === '00000000') return startDate
  const qb = repo
    .createQueryBuilder('q')
    .select('q.tradeDate', 'tradeDate')
    .where('q.tsCode = :idx', { idx })
    .andWhere('q.tradeDate < :startDate', { startDate })
  if (category) {
    qb.andWhere('q.category = :category', { category })
  }
  qb.orderBy('q.tradeDate', 'DESC').limit(WARMUP_ROWS)
  const warmRows = await qb.getRawMany<{ tradeDate: string }>()
  if (warmRows.length === 0) return startDate
  // 取最早的那一行作 fetchStart（warmRows 已 DESC，最后一条最早）
  return warmRows[warmRows.length - 1].tradeDate
}

// ── persistAmvDaily（industry/sw 共用 upsert）──────────────────────────────

/**
 * upsert 落库到目标表（industry/sw 同构宽表，含 member_count）。
 * 增量模式跳过已有 (tsCode, tradeDate)；upsert 前按 (tsCode, tradeDate) 去重。
 * orUpdate 10 列含 member_count，冲突键 ['ts_code', 'trade_date']。
 *
 * 复用 amv-series-query.ts 的 AmvDailyEntityLike 作泛型约束。
 *
 * @returns 落库行数
 */
export async function persistAmvDaily<E extends AmvDailyEntityLike>(
  targetRepo: Repository<E>,
  idx: string,
  rows: AmvDailyRow[],
  syncMode: AmvSyncMode,
  logger: Logger,
  label: string,
): Promise<number> {
  let toWrite = rows
  if (syncMode !== 'overwrite') {
    const existing = await targetRepo.find({
      where: { tsCode: idx } as never,
      select: ['tradeDate'] as never,
    })
    const existingSet = new Set(existing.map((e) => e.tradeDate))
    toWrite = rows.filter((r) => !existingSet.has(r.tradeDate))
    if (toWrite.length === 0) {
      logger.log(`[${label}-amv] 指数 ${idx} 增量无新数据`)
      return 0
    }
  }

  // upsert 前按 (tsCode, tradeDate) 去重，保留最后一条（database-sql 规则）
  const dedup = new Map<string, AmvDailyRow>()
  for (const r of toWrite) dedup.set(`${r.tsCode}|${r.tradeDate}`, r)
  const finalRows = [...dedup.values()]
  if (finalRows.length !== toWrite.length) {
    logger.warn(
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
    .into(targetRepo.target as never)
    .values(entities as never)
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

  logger.log(`[${label}-amv] 指数 ${idx} 落库 ${entities.length} 行`)
  return entities.length
}

// ── buildAmvDailyRows（industry/sw 共用量价对齐+裁剪段）───────────────────

/**
 * 量价对齐 + 套公式 + 裁掉热身段，返回落库行。
 *
 * 抽取 industry-amv:syncOneIndex 392-450 / sw-amv:syncOneSwIndex 194-248 段。
 * `amtMap.size===0` 的 warn 不并入（留调用方原位）。
 *
 * @param label 日志前缀（'industry' / 'sw' / 'concept'）
 * @returns 落库行数组（可能为空，由调用方判断 empty）
 */
export function buildAmvDailyRows(
  priceRows: Array<{
    tradeDate: string
    open: number | null
    high: number | null
    low: number | null
    close: number | null
  }>,
  amtMap: Map<string, { amt: number; memberCount: number }>,
  startDate: string,
  expectedMembers: number,
  idx: string,
  logger: Logger,
  label: string,
): AmvDailyRow[] {
  const tradeDates = priceRows.map((p) => p.tradeDate)
  const amountInYuan: number[] = []
  const open: number[] = []
  const high: number[] = []
  const low: number[] = []
  const close: number[] = []
  const memberCounts: number[] = []

  for (const p of priceRows) {
    const agg = amtMap.get(p.tradeDate)
    const amt = agg ? agg.amt : 0 // 指数有行情但成分股当日 Σ 为空 → 量按 0，公式里 AMVc≤0 自然 invalid
    amountInYuan.push(amt * 1000) // 千元 → 元（amount 已是千元；×1000 到元，spec §3）
    open.push(p.open ?? NaN)
    high.push(p.high ?? NaN)
    low.push(p.low ?? NaN)
    close.push(p.close ?? NaN)
    memberCounts.push(agg ? agg.memberCount : 0)
  }

  // 套公式：calcAmvSeries → calcMacd(amvClose) → calcSignal / calcZdf
  const amv = calcAmvSeries({ amountInYuan, open, high, low, close })
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
      logger.warn(
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

  return rows
}

// ── 数值工具（stock-amv 主 service + dirty service 共用）───────────────────

/** numeric→string 列转数值（用前 Number()）；空/非数落 NaN。 */
export function num(v: string | null | undefined): number {
  if (v === null || v === undefined) return NaN
  return Number(v)
}

/** double precision 列：非有限值落 null（不写 Inf/NaN）。 */
export function finite(v: number): number | null {
  return Number.isFinite(v) ? v : null
}
