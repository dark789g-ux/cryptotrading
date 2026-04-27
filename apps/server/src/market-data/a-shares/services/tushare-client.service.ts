import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosError } from 'axios';

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
  private readonly maxAttempts = 3;
  private readonly retryDelaysMs = [1000, 2000, 4000];

  constructor(private readonly configService: ConfigService) {}

  async query(apiName: string, params: Record<string, string | number> = {}, fields = ''): Promise<TushareRow[]> {
    const token = this.configService.get<string>('TUSHARE_TOKEN');
    if (!token) {
      throw new BadRequestException('TUSHARE_TOKEN 未配置，无法同步 A 股数据');
    }

    const response = await this.postWithRetry(apiName, token, params, fields);

    const payload = response.data;
    if (payload.code !== 0) {
      throw new ServiceUnavailableException(`TuShare ${apiName} 调用失败：${payload.msg ?? payload.code}`);
    }

    const data = payload.data;
    if (!data) return [];

    return data.items.map((item) => this.toRow(data.fields, item));
  }

  private async postWithRetry(
    apiName: string,
    token: string,
    params: Record<string, string | number>,
    fields: string,
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
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
          const error = new ServiceUnavailableException(`TuShare ${apiName} 调用失败：${payload.msg ?? payload.code}`);
          if (!this.shouldRetryTusharePayload(payload)) throw error;
          lastError = error;
        } else {
          return response;
        }
      } catch (err: unknown) {
        if (!this.shouldRetryError(err)) throw err;
        lastError = err;
      }

      if (attempt < this.maxAttempts) {
        await this.delay(this.retryDelaysMs[attempt - 1] ?? this.retryDelaysMs[this.retryDelaysMs.length - 1]);
      }
    }

    throw lastError instanceof Error ? lastError : new ServiceUnavailableException(`TuShare ${apiName} 调用失败`);
  }

  private shouldRetryTusharePayload(payload: TushareResponse): boolean {
    const msg = String(payload.msg ?? '').toLowerCase();
    return [
      'timeout',
      'timed out',
      'rate',
      'too many',
      'limit',
      'busy',
      'temporar',
      '超时',
      '频率',
      '限流',
      '稍后',
      '繁忙',
      '服务忙',
    ].some((pattern) => msg.includes(pattern));
  }

  private shouldRetryError(err: unknown): boolean {
    if (!axios.isAxiosError(err)) return false;
    const error = err as AxiosError;
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return true;
    if (!error.response) return true;
    const status = error.response.status;
    return status === 429 || status >= 500;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
