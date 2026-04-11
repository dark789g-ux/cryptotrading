import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  readonly tushareToken = process.env.TUSHARE_TOKEN || '';
  readonly dataStartDate = process.env.DATA_START_DATE || '20200101';
  readonly updateTime = process.env.UPDATE_TIME || '20:00';
  readonly updateDays = parseInt(process.env.UPDATE_DAYS || '1', 10);
}
