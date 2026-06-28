import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomIndexDailyQuoteEntity } from '../../../entities/custom-index/custom-index-daily-quote.entity';
import { batchUpsert } from '../../_shared/sync-helpers';
import type { IndexQuoteRow } from './custom-index-compute.types';

export function quotesToDbRows(
  customIndexId: string,
  quotes: readonly IndexQuoteRow[],
): Array<Partial<CustomIndexDailyQuoteEntity>> {
  return quotes.map((q) => ({
    customIndexId,
    tradeDate: q.tradeDate,
    open: q.open ?? null,
    high: q.high ?? null,
    low: q.low ?? null,
    close: q.close ?? null,
    preClose: q.preClose ?? null,
    change: q.change ?? null,
    pctChange: q.pctChange ?? null,
    volHand: q.volHand ?? null,
    amount: q.amount ?? null,
  }));
}

@Injectable()
export class CustomIndexQuotesWriter {
  constructor(
    @InjectRepository(CustomIndexDailyQuoteEntity)
    private readonly quotesRepo: Repository<CustomIndexDailyQuoteEntity>,
  ) {}

  async upsertQuotes(
    customIndexId: string,
    quotes: readonly IndexQuoteRow[],
  ): Promise<number> {
    if (quotes.length === 0) {
      return 0;
    }

    const rows = quotesToDbRows(customIndexId, quotes);
    const entities = rows.map((row) => this.quotesRepo.create(row));
    return batchUpsert(this.quotesRepo, entities, [
      'customIndexId',
      'tradeDate',
    ]);
  }
}
