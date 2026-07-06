/**
 * ETF PCF 同步 service：沪深 PCF 抓取 → 落库。
 *
 * 优化：增量跳过（已存在的不重复抓）+ 去冗余（batchUpsert 内部已去重）+ 业务级二轮重试。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EtfPcfEntity } from '../../entities/raw/etf-pcf.entity';
import { batchUpsert, runWithRetry } from '../_shared/sync-helpers';
import { ETF_FETCH_INTERVAL_MS, fetchSsePcf, fetchSzsePcf } from './etf-pcf.client';
import type { PcfNormalizedRow, EtfSyncErrorItem, EtfSyncResult, EtfSyncOnProgress } from './etf.types';

interface FetchAndPersistResult {
  rows: number;
  clientErrors: EtfSyncErrorItem[];
  failed: boolean;
  errorMsg?: string;
}

@Injectable()
export class EtfPcfService {
  private readonly logger = new Logger(EtfPcfService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 抓取指定 ETF 列表的 PCF 并落库。
   * @param etfCodes 有效的 ts_code 列表（如 ['510020.SH', '159919.SZ']）
   * @param tradeDate 抓取日期 YYYYMMDD
   * @param syncMode 'incremental'（默认，查出已有 PCF 的 ETF 跳过）| 'overwrite'（重抓全部 ETF）
   */
  async syncPcf(
    etfCodes: string[],
    tradeDate: string,
    syncMode?: 'incremental' | 'overwrite',
    onProgress?: EtfSyncOnProgress,
  ): Promise<EtfSyncResult> {
    const pcfRepo = this.dataSource.getRepository(EtfPcfEntity);
    let totalRows = 0;
    const errors: EtfSyncErrorItem[] = [];

    // ── 增量跳过：查出已有 PCF 的 ETF，过滤待抓取列表 ──
    // overwrite 模式绕过 getExistingPcfCodes（重抓全部 ETF，用于补齐残缺数据）。
    let existing = new Set<string>();
    let todo: string[];
    if (syncMode === 'overwrite') {
      todo = etfCodes;
      this.logger.log(`[etf-pcf] ${tradeDate} overwrite 模式：重抓全部 ${etfCodes.length} 只 ETF`);
    } else {
      existing = await this.getExistingPcfCodes(etfCodes, tradeDate);
      todo = etfCodes.filter((c) => !existing.has(c));
      this.logger.log(
        `[etf-pcf] ${tradeDate} 共 ${etfCodes.length} 只，已存在 ${existing.size} 跳过，待抓取 ${todo.length}`,
      );
    }
    if (todo.length === 0) {
      this.logger.log('[etf-pcf] 全部已存在，跳过');
      return { success: 0, errors: [] };
    }

    const total = etfCodes.length;
    let done = existing.size;

    // ── 首轮 ──
    const failedCodes: string[] = [];
    for (let i = 0; i < todo.length; i++) {
      const r = await this.fetchAndPersistOne(pcfRepo, todo[i], tradeDate, i, todo.length);
      totalRows += r.rows;
      errors.push(...r.clientErrors);
      if (r.failed) {
        failedCodes.push(todo[i]);
      }
      done++;
      onProgress?.({
        phase: '同步 ETF PCF',
        percent: (done / total) * 100,
        message: `${todo[i]} (${done}/${total})`,
      });
    }

    // ── 二轮重试（首轮失败的尚未落库，不经过增量跳过） ──
    if (failedCodes.length > 0) {
      this.logger.warn(`[etf-pcf] 首轮失败 ${failedCodes.length} 只，二轮重试`);
      for (let i = 0; i < failedCodes.length; i++) {
        const r = await this.fetchAndPersistOne(pcfRepo, failedCodes[i], tradeDate, i, failedCodes.length);
        totalRows += r.rows;
        errors.push(...r.clientErrors);
        if (r.failed) {
          errors.push({
            apiName: 'etf_pcf_sync_failed',
            message: `${failedCodes[i]} ${tradeDate}: ${r.errorMsg}`,
          });
        }
        onProgress?.({
          phase: '同步 ETF PCF（重试）',
          percent: (done / total) * 100,
          message: `重试 ${failedCodes[i]} (${i + 1}/${failedCodes.length})`,
        });
      }
      this.logger.log('[etf-pcf] 二轮重试完成');
    }

    this.logger.log(
      `[etf-pcf] 完成：抓取 ${todo.length}/${etfCodes.length} 只（跳过 ${existing.size}），落库 ${totalRows} 行，错误 ${errors.length}`,
    );
    return { success: totalRows, errors };
  }

  /**
   * 查询指定日期已有 PCF 的 ts_code 集合（命中 idx_etf_pcf_code_date）。
   * 判据：存在至少一条成分股行（conCode <> ''）。清单头行（conCode=''）不算——
   * SSE client 双 sqlId 非原子，可能只落清单头（成分股请求失败），用成分股行判据
   * 避免残缺数据被误判已同步、永不再补。
   */
  private async getExistingPcfCodes(
    etfCodes: string[],
    tradeDate: string,
  ): Promise<Set<string>> {
    if (etfCodes.length === 0) return new Set();
    const pcfRepo = this.dataSource.getRepository(EtfPcfEntity);
    const rows = await pcfRepo
      .createQueryBuilder('p')
      .select('p.tsCode', 'tsCode')
      .where('p.tsCode = ANY(:codes)', { codes: etfCodes })
      .andWhere('p.tradeDate = :tradeDate', { tradeDate })
      .andWhere('p.conCode <> :empty', { empty: '' })
      .groupBy('p.tsCode')
      .getRawMany<{ tsCode: string }>();
    return new Set(rows.map((r) => r.tsCode));
  }

  /**
   * 抓取单只 ETF 的 PCF 并落库，每次请求后 sleep 限频。
   * failed = true 仅当 runWithRetry 抛错；接口返回空不算失败（ETF 当日可能无 PCF）。
   */
  private async fetchAndPersistOne(
    pcfRepo: Repository<EtfPcfEntity>,
    tsCode: string,
    tradeDate: string,
    index: number,
    total: number,
  ): Promise<FetchAndPersistResult> {
    const exchange = tsCode.endsWith('.SH') ? 'SH' : 'SZ';
    const code6 = tsCode.replace(/\.\w+$/, '');

    this.logger.log(`[etf-pcf] (${index + 1}/${total}) 抓取 ${tsCode} ${tradeDate}`);

    try {
      const result =
        exchange === 'SH'
          ? await runWithRetry(
              () => fetchSsePcf(code6, tradeDate),
              (attempt, err) => {
                this.logger.warn(`[etf-pcf] ${tsCode} 重试 ${attempt}: ${err}`);
              },
            )
          : await runWithRetry(
              () => fetchSzsePcf(code6, tradeDate),
              (attempt, err) => {
                this.logger.warn(`[etf-pcf] ${tsCode} 重试 ${attempt}: ${err}`);
              },
            );

      if (result.rows.length === 0) {
        this.logger.warn(`[etf-pcf] ${tsCode} ${tradeDate} 无 PCF 数据`);
      }

      if (result.rows.length > 0) {
        const entities = result.rows.map(mapPcfRowToEntity);
        const written = await batchUpsert(pcfRepo, entities, ['tsCode', 'tradeDate', 'conCode']);
        // 限频
        await sleep(ETF_FETCH_INTERVAL_MS);
        return { rows: written, clientErrors: result.errors, failed: false };
      }

      // 空数据：不落库，但仍 sleep 保持限频节奏
      await sleep(ETF_FETCH_INTERVAL_MS);
      return { rows: 0, clientErrors: result.errors, failed: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`[etf-pcf] ${tsCode} ${tradeDate} 异常: ${msg}`);
      // 失败路径也 sleep，避免立即请求下一只触发限频
      await sleep(ETF_FETCH_INTERVAL_MS);
      return { rows: 0, clientErrors: [], failed: true, errorMsg: msg };
    }
  }
}

// ── 映射函数 ──────────────────────────────────────────────────────────────

function mapPcfRowToEntity(row: PcfNormalizedRow): Partial<EtfPcfEntity> {
  return {
    tsCode: row.tsCode,
    tradeDate: row.tradeDate,
    fundName: row.fundName || null,
    manager: row.manager || null,
    fundType: row.fundType || null,
    indexCode: row.indexCode || null,
    creationUnit: row.creationUnit != null ? String(row.creationUnit) : null,
    maxCashRatio: row.maxCashRatio != null ? String(row.maxCashRatio) : null,
    publishIopv: row.publishIopv,
    conCode: row.conCode,
    conName: row.conName || null,
    quantity: row.quantity != null ? String(row.quantity) : null,
    substFlag: row.substFlag || null,
    premiumRate: row.premiumRate != null ? String(row.premiumRate) : null,
    discountRate: row.discountRate != null ? String(row.discountRate) : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
