import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { ThsIndexDailyIndicatorService } from './ths-index-daily-indicator.service';
import {
  asString,
  deduplicateBy,
  runWithRetry,
  RETRY_MAX_ATTEMPTS,
} from '../_shared/sync-helpers';

/**
 * 大盘指数日线同步（Tushare index_daily）。
 * spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md【后端>同步改造>大盘】
 *
 * 遍历大盘范围（ths_index_catalog type='M'，动态范围），分段拉 index_daily（单次 8000 行 ≈ 33 年，按 5 年一段），
 * 映射写入 index_daily_quotes category='market'（无 total_mv/float_mv/turnover_rate，合法 NULL），
 * 同步后触发指标重算。与 ThsIndexDailySyncService（行业/概念 ths_daily）互不干扰。
 *
 * spec: docs/superpowers/specs/2026-06-23-market-index-dynamic-scope-design/02-backend.md §2.2
 *
 * syncMode 说明：本 service 无「跳过已有 (ts_code, trade_date)」逻辑——每次按 ts_code 逐指数、
 * 按 5 年段全量重拉 Tushare index_daily，再 upsert（ON CONFLICT DO UPDATE，本身即覆盖）。
 * 因此 syncMode='overwrite' 对本 service 是 no-op：incremental 与 overwrite 行为完全一致。
 * 字段仅作 API 对齐（与一键同步 ctx.syncMode 形态统一）+ 日志标识，不改变落库行为。
 */
// Tushare index_daily 出参：ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol(手),amount(千元)
const INDEX_DAILY_FIELDS =
  'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount';

interface RawRow {
  [k: string]: unknown;
}

export interface MarketIndexSyncDto {
  start_date: string;
  end_date: string;
  /** 同步模式（本 service 为 no-op，见类注释）；与一键同步 ctx.syncMode 形态对齐 */
  syncMode?: 'incremental' | 'overwrite';
}

export interface MarketIndexSyncErrorItem {
  apiName: string;
  params: Record<string, unknown>;
  message?: string;
}

export interface MarketIndexSyncResult {
  success: number;
  errors: MarketIndexSyncErrorItem[];
}

/** 单段年数（index_daily 单次 8000 行 ≈ 33 年，5 年段留足余量且增量友好） */
const SEGMENT_YEARS = 5;

function yyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Tushare 数值字段 → number | null（OHLC/vol/amount 走 double） */
function asNullableFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class MarketIndexSyncService {
  private readonly logger = new Logger(MarketIndexSyncService.name);

  constructor(
    @InjectRepository(IndexDailyQuoteEntity)
    private readonly quotesRepo: Repository<IndexDailyQuoteEntity>,
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    private readonly tushareClient: TushareClientService,
    private readonly indicatorService: ThsIndexDailyIndicatorService,
  ) {}

  async sync(dto: MarketIndexSyncDto): Promise<MarketIndexSyncResult> {
    // syncMode 对本 service 为 no-op（无跳过逻辑，逐指数全量重拉 + upsert 即覆盖）；
    // 此处仅记录模式，便于排查与一键同步 API 形态对齐。
    const syncMode = dto.syncMode ?? 'incremental';
    this.logger.log(
      `[market-index] syncMode=${syncMode}（no-op：本 service 无增量跳过，逐指数全量重拉 + upsert）`,
    );
    const errors: MarketIndexSyncErrorItem[] = [];
    let success = 0;
    const affected = new Set<string>();

    const segments = this.computeSegments(dto.start_date, dto.end_date);
    if (segments.length === 0) {
      errors.push({
        apiName: 'no_segments',
        params: { start_date: dto.start_date, end_date: dto.end_date },
        message: '空窗口或 start>end',
      });
      return { success: 0, errors };
    }

    // 大盘范围来自 ths_index_catalog type='M'（动态范围，废弃硬编码 LIST）
    const scopeRows = await this.catalogRepo.find({ where: { type: 'M' } });
    if (scopeRows.length === 0) {
      // 空范围兜底：warn + 返回空结果，不伪装成功
      this.logger.warn(
        '大盘范围（ths_index_catalog type=\'M\'）为空，跳过同步。请在 sync 域管理页面添加大盘指数。',
      );
      errors.push({
        apiName: 'market_scope_empty',
        params: { type: 'M' },
        message: 'ths_index_catalog 无 type=\'M\' 行，大盘范围为空',
      });
      return { success: 0, errors };
    }

    // 固定额外源：0AMV 基准指数 930903.CSI。不进 type='M'（避免触发 index-weight-sync；它无权重需求），
    // 与大盘指数同表 category='market' 落库、靠 ts_code 过滤区分；0AMV 自治指标（recomputeIndicatorsAll），
    // 不走 indicatorService（见下方 affected 循环跳过 EXTRA_OAMV_CODES）。
    const EXTRA_OAMV_CODES = ['930903.CSI'];
    const allTsCodes = Array.from(
      new Set([...scopeRows.map((r) => r.tsCode), ...EXTRA_OAMV_CODES]),
    );

    for (const tsCode of allTsCodes) {
      for (const seg of segments) {
        let rows: RawRow[] = [];
        try {
          rows = (await runWithRetry(
            () =>
              this.tushareClient.query(
                'index_daily',
                { ts_code: tsCode, start_date: seg.s, end_date: seg.e },
                INDEX_DAILY_FIELDS,
              ),
            (attempt, err) =>
              this.logger.warn(
                `index_daily ${tsCode} ${seg.s}~${seg.e} 重试 ${attempt}/${RETRY_MAX_ATTEMPTS}：${err instanceof Error ? err.message : String(err)}`,
              ),
          )) as RawRow[];
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error(`index_daily ${tsCode} ${seg.s}~${seg.e} 调用失败：${msg}`);
          errors.push({
            apiName: 'index_daily',
            params: { ts_code: tsCode, start_date: seg.s, end_date: seg.e },
            message: msg,
          });
          continue;
        }

        // 双路径 warn（data-integrity）：0 行也算 failedItem，不静默成功
        if (rows.length === 0) {
          this.logger.warn(`index_daily ${tsCode} ${seg.s}~${seg.e} 返回 0 行`);
          errors.push({
            apiName: 'index_daily_empty',
            params: { ts_code: tsCode, start_date: seg.s, end_date: seg.e },
          });
          continue;
        }

        const entities = rows.map((row) =>
          this.quotesRepo.create({
            tsCode: asString(row.ts_code),
            tradeDate: asString(row.trade_date),
            open: asNullableFloat(row.open),
            high: asNullableFloat(row.high),
            low: asNullableFloat(row.low),
            close: asNullableFloat(row.close),
            preClose: asNullableFloat(row.pre_close),
            change: asNullableFloat(row.change),
            pctChange: asNullableFloat(row.pct_chg), // index_daily 是 pct_chg（非 pct_change）
            volHand: asNullableFloat(row.vol), // 落「手」，K 线输出层 ×100 转股
            amount: asNullableFloat(row.amount), // 千元，仅大盘有
            category: 'market',
            // total_mv_wan / float_mv_wan / turnover_rate：大盘无，合法 NULL
          }),
        );

        // upsert 前按 (tsCode, tradeDate) 去重（database-sql 规则）
        const deduped = deduplicateBy(entities, ['tsCode', 'tradeDate']);
        if (deduped.length < entities.length) {
          this.logger.warn(
            `index_daily ${tsCode} ${seg.s}~${seg.e} 重复：${entities.length} → ${deduped.length}`,
          );
        }

        if (deduped.length) {
          const chunkSize = 1000;
          for (let j = 0; j < deduped.length; j += chunkSize) {
            await this.quotesRepo.upsert(deduped.slice(j, j + chunkSize), ['tsCode', 'tradeDate']);
          }
          success += deduped.length;
          affected.add(tsCode);
        }
      }
    }

    // 指标重算（MA/MACD/KDJ/BBI/BRICK，复用 ThsIndexDailyIndicatorService，它读 index_daily_quotes）
    for (const tsCode of affected) {
      // 0AMV 基准指数（EXTRA_OAMV_CODES）自治指标（OamvService.recomputeIndicatorsAll），跳过 MA/MACD/KDJ 重算。
      if (EXTRA_OAMV_CODES.includes(tsCode)) continue;
      try {
        await this.indicatorService.recalculateForSymbols([tsCode]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`market_index_indicator ${tsCode} 计算失败：${msg}`);
        errors.push({
          apiName: 'market_index_indicator',
          params: { ts_code: tsCode },
          message: msg,
        });
      }
    }

    return { success, errors };
  }

  /** 按段切分窗口（SEGMENT_YEARS 年一段），返回 [{s,e}] YYYYMMDD。start>end 返回空。 */
  private computeSegments(start: string, end: string): Array<{ s: string; e: string }> {
    if (!start || !end || start.length !== 8 || end.length !== 8 || start > end) return [];
    const out: Array<{ s: string; e: string }> = [];
    // YYYYMMDD → Date 插分隔符（datetime.md：禁 new Date('YYYYMMDD')）
    let cur = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`);
    const endD = new Date(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T00:00:00Z`);
    while (cur <= endD) {
      const next = new Date(cur);
      next.setUTCFullYear(next.getUTCFullYear() + SEGMENT_YEARS);
      const s = yyyymmdd(cur);
      const eRaw = next > endD ? endD : next;
      out.push({ s, e: yyyymmdd(eRaw) });
      cur = next;
    }
    return out;
  }
}
