import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { IndexWeightEntity } from '../../entities/index-catalog/index-weight.entity';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { asString } from '../_shared/sync-helpers';

/**
 * index_weight 同步结果。
 */
export interface IndexWeightSyncResult {
  /** 本次处理的指数个数。 */
  totalIndexes: number;
  /** 成功完成同步（含无变化跳过）的指数个数。 */
  successIndexes: number;
  /** 失败项（含 API 错误、空数据、事务失败）。 */
  errors: IndexWeightSyncErrorItem[];
  /** 发生成分股变更、新建了版本的指数列表。 */
  changedIndexes: string[];
}

export interface IndexWeightSyncErrorItem {
  apiName: string;
  params: Record<string, unknown>;
  message?: string;
}

/** Tushare index_weight 返回字段（官方文档已查证） */
const INDEX_WEIGHT_FIELDS = 'con_code,trade_date,weight';

/** 原始行类型 */
interface RawIndexWeightRow {
  con_code?: string | null;
  trade_date?: string | null;
  weight?: string | number | null;
}

@Injectable()
export class IndexWeightSyncService {
  private readonly logger = new Logger(IndexWeightSyncService.name);

  constructor(
    @InjectRepository(IndexWeightEntity)
    private readonly weightRepo: Repository<IndexWeightEntity>,
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  /**
   * 同步单个月份：拉取该月全部 index_weight 行，取最新 trade_date 作为当月成分快照，
   * 与当前 active 版本（expireDate=null）做集合比对，若成分股集合变化则关旧版+插新版。
   *
   * @param indexCode 指数代码（如 000001.SH）
   * @param yearMonth 年月字符串 YYYY-MM（如 2024-06）
   */
  async syncForMonth(indexCode: string, yearMonth: string): Promise<boolean> {
    const { startDate, endDate } = this.parseYearMonth(yearMonth);

    let rows: RawIndexWeightRow[] = [];
    try {
      rows = await this.tushareClient.query(
        'index_weight',
        { index_code: indexCode, start_date: startDate, end_date: endDate },
        INDEX_WEIGHT_FIELDS,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`index_weight ${indexCode} ${yearMonth} 调用失败：${msg}`);
      throw new Error(`index_weight ${indexCode} ${yearMonth}: ${msg}`);
    }

    // data-integrity：双路径 warn（TushareClientService 内部已 warn，这里补 service 层 context）
    if (rows.length === 0) {
      this.logger.warn(`index_weight ${indexCode} ${yearMonth} 返回 0 行（data=null 或 items=[]）`);
      throw new Error(`index_weight_empty ${indexCode} ${yearMonth}`);
    }

    // 取该月最新 trade_date 的行作为当月快照
    const latestTradeDate = rows
      .map((r) => asString(r.trade_date))
      .filter((d) => d.length === 8)
      .sort()
      .pop()!;

    const latestRows = rows.filter((r) => asString(r.trade_date) === latestTradeDate);

    // 新成分集合
    const newConSet = new Set(latestRows.map((r) => asString(r.con_code)).filter(Boolean));
    if (newConSet.size === 0) {
      this.logger.warn(`index_weight ${indexCode} ${yearMonth} 最新日 ${latestTradeDate} 无有效 con_code`);
      throw new Error(`index_weight_no_con_codes ${indexCode} ${yearMonth}`);
    }

    // 当前 active 版本成分集合
    const activeRows = await this.weightRepo.find({
      where: { indexCode, expireDate: IsNull() },
      select: ['conCode'],
    });
    const activeConSet = new Set(activeRows.map((r) => r.conCode));

    // 集合比对：相同则跳过
    if (this.setsEqual(newConSet, activeConSet)) {
      this.logger.log(`index_weight ${indexCode} ${yearMonth} 成分股无变化（${newConSet.size} 只），跳过`);
      return false;
    }

    // 有变化：事务性关旧版 + 插新版
    await this.weightRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(IndexWeightEntity);

      // 关闭旧版本：expireDate = 昨天（latestTradeDate 前一天）
      const expireDate = this.yesterday(latestTradeDate);
      await repo.update(
        { indexCode, expireDate: IsNull() },
        { expireDate },
      );

      // 插入新版本
      const entities = latestRows.map((row) =>
        repo.create({
          indexCode,
          conCode: asString(row.con_code),
          effectiveDate: latestTradeDate,
          expireDate: null,
          weight: row.weight != null ? String(row.weight) : null,
        }),
      );

      // 去重（同批次同 con_code 只保留最后一条）
      const seen = new Map<string, IndexWeightEntity>();
      for (const entity of entities) {
        if (entity.conCode) {
          seen.set(entity.conCode, entity);
        }
      }
      const deduped = Array.from(seen.values());

      const chunkSize = 1000;
      for (let i = 0; i < deduped.length; i += chunkSize) {
        await repo.insert(deduped.slice(i, i + chunkSize));
      }
    });

    this.logger.log(
      `index_weight ${indexCode} ${yearMonth} 成分股变更：${activeConSet.size} → ${newConSet.size}，` +
      `生效日 ${latestTradeDate}，旧版关闭于 ${this.yesterday(latestTradeDate)}`,
    );
    return true;
  }

  /**
   * 按需同步：计算 range 覆盖的全部月份，对每个大盘指数（ths_index_catalog type='M'）逐月同步。
   */
  async syncIfNeeded(range: { startDate: string; endDate: string }): Promise<IndexWeightSyncResult> {
    const months = this.computeMonths(range.startDate, range.endDate);
    if (months.length === 0) {
      return {
        totalIndexes: 0,
        successIndexes: 0,
        errors: [{
          apiName: 'no_months',
          params: range,
          message: '空窗口或日期格式错误',
        }],
        changedIndexes: [],
      };
    }

    const scopeRows = await this.catalogRepo.find({ where: { type: 'M' } });
    if (scopeRows.length === 0) {
      this.logger.warn('ths_index_catalog type=\'M\' 为空，跳过 index_weight 同步');
      return {
        totalIndexes: 0,
        successIndexes: 0,
        errors: [{
          apiName: 'market_scope_empty',
          params: { type: 'M' },
          message: 'ths_index_catalog 无 type=\'M\' 行',
        }],
        changedIndexes: [],
      };
    }

    const errors: IndexWeightSyncErrorItem[] = [];
    const changedIndexes: string[] = [];
    let successIndexes = 0;

    for (const { tsCode } of scopeRows) {
      let indexSuccess = true;
      for (const yearMonth of months) {
        try {
          const changed = await this.syncForMonth(tsCode, yearMonth);
          if (changed && !changedIndexes.includes(tsCode)) {
            changedIndexes.push(tsCode);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push({
            apiName: 'index_weight',
            params: { index_code: tsCode, year_month: yearMonth },
            message: msg,
          });
          indexSuccess = false;
          // 单个月份失败继续下一个月（指数内逐月独立）
        }
      }
      if (indexSuccess) {
        successIndexes++;
      }
    }

    return {
      totalIndexes: scopeRows.length,
      successIndexes,
      errors,
      changedIndexes,
    };
  }

  /** YYYY-MM → { startDate: YYYYMMDD, endDate: YYYYMMDD }（当月首日与末日） */
  private parseYearMonth(yearMonth: string): { startDate: string; endDate: string } {
    const [y, m] = yearMonth.split('-').map(Number);
    if (!y || !m || m < 1 || m > 12) {
      throw new Error(`yearMonth 格式错误：${yearMonth}`);
    }
    const startDate = `${String(y)}${String(m).padStart(2, '0')}01`;
    // 次月首日减一天 = 当月末日
    const nextMonth = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    nextMonth.setUTCDate(nextMonth.getUTCDate() - 1);
    const endDate = `${nextMonth.getUTCFullYear()}${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}${String(nextMonth.getUTCDate()).padStart(2, '0')}`;
    return { startDate, endDate };
  }

  /** YYYYMMDD → 前一天 YYYYMMDD */
  private yyyymmdd(d: Date): string {
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  private yesterday(tradeDate: string): string {
    const d = new Date(`${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return this.yyyymmdd(d);
  }

  /** 计算两个 YYYYMMDD 之间覆盖的全部 YYYY-MM 月份 */
  private computeMonths(startDate: string, endDate: string): string[] {
    if (!startDate || !endDate || startDate.length !== 8 || endDate.length !== 8 || startDate > endDate) {
      return [];
    }
    const start = new Date(`${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}T00:00:00Z`);
    const end = new Date(`${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}T00:00:00Z`);

    const months: string[] = [];
    const cur = new Date(start);
    // 归一化到当月首日
    cur.setUTCDate(1);

    while (cur <= end) {
      months.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return months;
  }

  /** 两个 Set<string> 是否元素完全相同 */
  private setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }
}
