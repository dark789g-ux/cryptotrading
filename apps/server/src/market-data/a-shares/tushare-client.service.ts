import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface TushareResponse {
  code: number;
  msg: string | null;
  data?: {
    fields: string[];
    items: unknown[][];
  };
}

export type TushareRow = Record<string, string | number | null>;

@Injectable()
export class TushareClientService {
  private readonly endpoint = 'http://api.tushare.pro';

  constructor(private readonly configService: ConfigService) {}

  async query(apiName: string, params: Record<string, string | number> = {}, fields = ''): Promise<TushareRow[]> {
    const token = this.configService.get<string>('TUSHARE_TOKEN');
    if (!token) {
      throw new BadRequestException('TUSHARE_TOKEN 未配置，无法同步 A 股数据');
    }

    const response = await axios.post<TushareResponse>(
      this.endpoint,
      {
        api_name: apiName,
        token,
        params,
        fields,
      },
      { timeout: 30000 },
    );

    const payload = response.data;
    if (payload.code !== 0) {
      throw new ServiceUnavailableException(`TuShare ${apiName} 调用失败：${payload.msg ?? payload.code}`);
    }

    const data = payload.data;
    if (!data) return [];

    return data.items.map((item) => this.toRow(data.fields, item));
  }

  private toRow(fields: string[], item: unknown[]): TushareRow {
    const row: TushareRow = {};
    fields.forEach((field, index) => {
      const value = item[index];
      const normalized: string | number | null =
        value == null ? null : typeof value === 'string' || typeof value === 'number' ? value : String(value);
      row[field] = normalized;
    });
    return row;
  }
}
