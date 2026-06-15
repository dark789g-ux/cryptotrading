import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UsSymbolEntity } from '../../entities/raw/us-symbol.entity';
import { UsStockSymbolItem, UsStockTrackedUpdateItem } from './us-stocks.types';

/**
 * 美股标的清单读取 + tracked 写。
 *
 * tracked 写契约（spec 05）：只 `UPDATE raw.us_symbol SET tracked=:v WHERE ticker=:t`，
 * 不碰 name / theme / 日线表。Python 播种侧 ON CONFLICT 时不写 tracked，两方按列归属切分。
 */
@Injectable()
export class UsStocksSymbolsService {
  private readonly logger = new Logger(UsStocksSymbolsService.name);

  constructor(
    @InjectRepository(UsSymbolEntity)
    private readonly symbolRepo: Repository<UsSymbolEntity>,
  ) {}

  async listSymbols(): Promise<UsStockSymbolItem[]> {
    // 不限制列，直接取全实体（database-sql.md：不限列的 getMany 最稳，避免 .select 水合丢字段）。
    const rows = await this.symbolRepo
      .createQueryBuilder('s')
      .orderBy('s.ticker', 'ASC')
      .getMany();

    return rows.map((s) => ({
      ticker: s.ticker,
      name: s.name ?? null,
      theme: s.theme ?? null,
      stockType: s.stockType ?? null,
      tracked: s.tracked === true,
      listDate: s.listDate ?? null,
    }));
  }

  /**
   * 批量改 tracked。
   *
   * - 按 ticker 去重（保留最后一条，与 upsert 去重同理，避免同 ticker 多次写）。
   * - 每条只 UPDATE tracked 列，WHERE ticker 命中；不存在的 ticker 静默跳过（affected=0）。
   * - 返回实际更新行数。
   */
  async updateTracked(items: UsStockTrackedUpdateItem[]): Promise<{ updated: number }> {
    if (!Array.isArray(items) || items.length === 0) {
      return { updated: 0 };
    }

    // 按 ticker 去重，保留最后一条
    const dedup = new Map<string, boolean>();
    for (const item of items) {
      if (!item || typeof item.ticker !== 'string' || item.ticker === '') continue;
      if (typeof item.tracked !== 'boolean') continue;
      dedup.set(item.ticker, item.tracked);
    }

    if (dedup.size !== items.length) {
      this.logger.warn(
        `us_stocks update_tracked dedup: 原始 ${items.length} 条 → 去重/过滤后 ${dedup.size} 条`,
      );
    }

    let updated = 0;
    for (const [ticker, tracked] of dedup) {
      const res = await this.symbolRepo.update({ ticker }, { tracked });
      updated += res.affected ?? 0;
    }
    return { updated };
  }
}
