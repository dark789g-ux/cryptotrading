import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class CalendarLoader {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async load(dateStart: string | null, dateEnd: string | null): Promise<string[]> {
    let sql = `SELECT cal_date FROM raw.trade_cal WHERE exchange='SSE' AND is_open=1`;
    const params: unknown[] = [];
    if (dateStart) {
      params.push(dateStart);
      sql += ` AND cal_date >= $${params.length}`;
    }
    if (dateEnd) {
      params.push(dateEnd);
      sql += ` AND cal_date <= $${params.length}`;
    }
    sql += ` ORDER BY cal_date ASC`;
    const rows = await this.dataSource.query<Array<{ cal_date: string }>>(
      sql,
      params.length ? params : undefined,
    );
    return rows.map((r) => r.cal_date);
  }
}
