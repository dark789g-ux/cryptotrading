import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { type AxiosError } from 'axios';
import pLimit = require('p-limit');

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

  private readonly limiter: pLimit.Limit;
  private lastRequestAt = 0;
  private currentIntervalMs: number;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;

  constructor(private readonly configService: ConfigService) {
    const concurrency = Number(configService.get('TUSHARE_CONCURRENCY') ?? 5);
    this.minIntervalMs = Number(configService.get('TUSHARE_MIN_INTERVAL_MS') ?? 200);
    this.maxIntervalMs = Number(configService.get('TUSHARE_MAX_INTERVAL_MS') ?? 5000);
    this.currentIntervalMs = this.minIntervalMs;
    this.limiter = pLimit(concurrency);
  }

  async query(apiName: string, params: Record<string, string | number> = {}, fields = ''): Promise<TushareRow[]> {
    return this.limiter(() => this.throttledQuery(apiName, params, fields));
  }

  private async throttledQuery(
    apiName: string,
    params: Record<string, string | number>,
    fields: string,
  ): Promise<TushareRow[]> {
    const token = this.configService.get<string>('TUSHARE_TOKEN');
    if (!token) {
      throw new BadRequestException('TUSHARE_TOKEN 未配置，无法同步 A 股数据');
    }

    const wait = this.currentIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.delay(wait);
    this.lastRequestAt = Date.now();

    const response = await this.postWithRetry(apiName, token, params, fields);

    this.currentIntervalMs = Math.max(this.currentIntervalMs * 0.9, this.minIntervalMs);

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
          { api_name: apiName, token, params, fields },
          { timeout: 30000 },
        );
        const payload = response.data;
        if (payload.code !== 0) {
          const error = new ServiceUnavailableException(`TuShare ${apiName} 调用失败：${payload.msg ?? payload.code}`);
          if (!this.shouldRetryTusharePayload(payload)) throw error;
          this.onRateLimit();
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

  private onRateLimit(): void {
    this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
  }

  private shouldRetryTusharePayload(payload: TushareResponse): boolean {
    const msg = String(payload.msg ?? '').toLowerCase();
    return [
      'timeout', 'timed out', 'rate', 'too many', 'limit', 'busy', 'temporar',
      '超时', '频率', '限流', '稍后', '繁忙', '服务忙',
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
        value == null ? null
        : typeof value === 'string' || typeof value === 'number' ? value
        : String(value);
      row[field] = normalized;
    });
    return row;
  }
}
