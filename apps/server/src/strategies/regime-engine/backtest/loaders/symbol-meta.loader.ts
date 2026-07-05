import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SymbolMeta } from '../types/backtest-data.types';

@Injectable()
export class SymbolMetaLoader {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async prefetchSymbolMap(tsCodes: string[]): Promise<Map<string, SymbolMeta>> {
    const map = new Map<string, SymbolMeta>();
    if (tsCodes.length === 0) return map;
    const rows = await this.dataSource.query<
      Array<{ ts_code: string; list_date: string | null; delist_date: string | null }>
    >(
      `SELECT ts_code, list_date, delist_date FROM a_share_symbols WHERE ts_code = ANY($1::text[])`,
      [tsCodes],
    );
    for (const r of rows) {
      map.set(r.ts_code, { listDate: r.list_date ?? null, delistDate: r.delist_date ?? null });
    }
    return map;
  }
}
