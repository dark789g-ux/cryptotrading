import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { CustomIndexAmvEntity } from '../../../entities/custom-index/custom-index-amv.entity';
import { CustomIndexDefinitionEntity } from '../../../entities/custom-index/custom-index-definition.entity';
import { CustomIndexMoneyFlowEntity } from '../../../entities/custom-index/custom-index-money-flow.entity';
import { batchUpsert } from '../../_shared/sync-helpers';
import { loadComputeContext } from './custom-index-compute-context.loader';
import type { CustomIndexWarningHandler, IndexQuoteRow } from './custom-index-compute.types';
import { computeAmvRows } from './custom-index-amv-writer';
import { CustomIndexIndicatorService } from './custom-index-indicator.service';
import { CustomIndexMoneyFlowService } from './custom-index-money-flow.service';
import { computePriceIndexQuotes } from './custom-index-price-index';
import { CustomIndexQuotesWriter } from './custom-index-quotes-writer';
import { computeTotalReturnQuotes } from './custom-index-total-return';
import {
  clampEarliestEffectiveToBaseDate,
  loadWeightVersions,
  validateVersions,
} from './custom-index-weight-resolver';

export interface CustomIndexComputeRunOptions {
  customIndexId: string;
  userId: string;
  fullRebuild?: boolean;
}

const QUOTES_CHUNK_SIZE = 250;

const DERIVED_TABLES = [
  'custom_index_daily_quotes',
  'custom_index_daily_indicators',
  'custom_index_money_flow',
  'custom_index_amv',
] as const;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

@Injectable()
export class CustomIndexComputeRunner {
  private readonly logger = new Logger(CustomIndexComputeRunner.name);
  private readonly computing = new Set<string>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(CustomIndexDefinitionEntity)
    private readonly definitionRepo: Repository<CustomIndexDefinitionEntity>,
    @InjectRepository(CustomIndexMoneyFlowEntity)
    private readonly moneyFlowRepo: Repository<CustomIndexMoneyFlowEntity>,
    @InjectRepository(CustomIndexAmvEntity)
    private readonly amvRepo: Repository<CustomIndexAmvEntity>,
    private readonly quotesWriter: CustomIndexQuotesWriter,
    private readonly indicatorService: CustomIndexIndicatorService,
    private readonly moneyFlowService: CustomIndexMoneyFlowService,
  ) {}

  tryAcquire(customIndexId: string): boolean {
    if (this.computing.has(customIndexId)) {
      return false;
    }
    this.computing.add(customIndexId);
    return true;
  }

  release(customIndexId: string): void {
    this.computing.delete(customIndexId);
  }

  async run(opts: CustomIndexComputeRunOptions): Promise<void> {
    const { customIndexId, userId, fullRebuild = true } = opts;

    const def = await this.definitionRepo.findOne({
      where: { id: customIndexId, userId },
    });
    if (!def) {
      this.release(customIndexId);
      throw new Error(`custom_index 不存在或无权限: ${customIndexId}`);
    }

    if (def.status === 'computing') {
      this.logger.warn(
        `custom_index_compute duplicate rejected (db computing) id=${customIndexId}`,
      );
      this.release(customIndexId);
      return;
    }

    try {
      await this.runStages(def, fullRebuild);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.patchDefinition(customIndexId, {
        status: 'failed',
        computeProgress: def.computeProgress,
        computeStage: null,
        lastError: message,
      });
      throw err;
    } finally {
      this.release(customIndexId);
    }
  }

  private async runStages(
    def: CustomIndexDefinitionEntity,
    fullRebuild: boolean,
  ): Promise<void> {
    const customIndexId = def.id;
    const baseDate = def.baseDate;
    const basePoint = Number(def.basePoint);
    const indexType = def.indexType;

    await this.patchDefinition(customIndexId, {
      status: 'computing',
      computeProgress: 5,
      computeStage: 'load_members',
      lastError: null,
    });

    const rawVersions = await loadWeightVersions(this.dataSource, customIndexId);
    validateVersions(rawVersions);
    // 最早版本视作自 base_date 起生效（spec：base_date 为 effective_date 默认值）。
    // 同一份夹取后的 versions 贯穿 quotes / money_flow / amv，保证 PIT 解析一致。
    const versions = clampEarliestEffectiveToBaseDate(rawVersions, baseDate);

    if (fullRebuild) {
      await this.deleteDerivedData(customIndexId);
    }

    await this.patchDefinition(customIndexId, {
      computeProgress: 15,
      computeStage: 'sync_quotes',
    });

    const ctx = await loadComputeContext(this.dataSource, versions, baseDate);

    await this.patchDefinition(customIndexId, {
      computeProgress: 50,
      computeStage: 'quotes',
    });

    const warnings: Array<{ code: string; detail: Record<string, unknown> }> = [];
    const onWarning: CustomIndexWarningHandler = (code, detail) => {
      warnings.push({ code, detail });
      this.logger.warn(
        `custom_index_warning id=${customIndexId} code=${code} detail=${JSON.stringify(detail)}`,
      );
    };

    const quotes =
      indexType === 'total_return'
        ? computeTotalReturnQuotes({
            versions,
            ctx,
            baseDate,
            basePoint,
            onWarning,
          })
        : computePriceIndexQuotes({
            versions,
            ctx,
            baseDate,
            basePoint,
            onWarning,
          });

    // 完整性兜底：0 点位不得伪装成 ready（data-integrity）。抛错经 run() catch 落
    // status=failed + lastError，前端「状态」列显示失败 + tooltip + 重试按钮。
    if (quotes.length === 0) {
      throw new Error(
        `计算产出 0 个点位：检查 base_date(${baseDate})、成分有效性，或 effective_date 是否晚于最近交易日`,
      );
    }

    await this.upsertQuotesInChunks(customIndexId, quotes);

    await this.patchDefinition(customIndexId, {
      computeProgress: 60,
      computeStage: 'indicators',
    });
    await this.indicatorService.upsertIndicatorsFromQuotes(customIndexId, quotes);

    await this.patchDefinition(customIndexId, {
      computeProgress: 70,
      computeStage: 'money_flow',
    });
    const tradeDates = quotes.map((q) => q.tradeDate);
    const mfRows = await this.moneyFlowService.aggregateMoneyFlow({
      customIndexId,
      versions,
      tradeDates,
    });
    await this.upsertMoneyFlow(customIndexId, mfRows);

    await this.patchDefinition(customIndexId, {
      computeProgress: 80,
      computeStage: 'amv',
    });
    const amvRows = computeAmvRows({ customIndexId, versions, ctx, quotes });
    await this.upsertAmv(customIndexId, amvRows);

    await this.patchDefinition(customIndexId, {
      status: 'ready',
      computeProgress: 100,
      computeStage: 'finalize',
      lastError: null,
    });

    this.logger.log(
      `custom_index_compute_done id=${customIndexId} quotes=${quotes.length} warnings=${warnings.length}`,
    );
  }

  private async upsertQuotesInChunks(
    customIndexId: string,
    quotes: readonly IndexQuoteRow[],
  ): Promise<void> {
    for (const chunk of chunkArray(quotes, QUOTES_CHUNK_SIZE)) {
      await this.quotesWriter.upsertQuotes(customIndexId, chunk);
      await yieldEventLoop();
    }
  }

  private async upsertMoneyFlow(
    customIndexId: string,
    rows: Array<{
      customIndexId: string;
      tradeDate: string;
      netAmount: number | null;
      buyLgAmount: number | null;
      buyMdAmount: number | null;
      buySmAmount: number | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const entities = rows.map((row) =>
      this.moneyFlowRepo.create({
        customIndexId,
        tradeDate: row.tradeDate,
        netAmount: row.netAmount,
        buyLgAmount: row.buyLgAmount,
        buyMdAmount: row.buyMdAmount,
        buySmAmount: row.buySmAmount,
      }),
    );
    await batchUpsert(this.moneyFlowRepo, entities, ['customIndexId', 'tradeDate']);
  }

  private async upsertAmv(
    customIndexId: string,
    rows: Array<{
      customIndexId: string;
      tradeDate: string;
      amv: number;
      amvMa5: number | null;
      amvMa10: number | null;
      amvMa20: number | null;
      amvMa60: number | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const entities = rows.map((row) =>
      this.amvRepo.create({
        customIndexId,
        tradeDate: row.tradeDate,
        amv: row.amv,
        amvMa5: row.amvMa5,
        amvMa10: row.amvMa10,
        amvMa20: row.amvMa20,
        amvMa60: row.amvMa60,
      }),
    );
    await batchUpsert(this.amvRepo, entities, ['customIndexId', 'tradeDate']);
  }

  private async deleteDerivedData(customIndexId: string): Promise<void> {
    for (const table of DERIVED_TABLES) {
      await this.dataSource.query(
        `DELETE FROM ${table} WHERE custom_index_id = $1`,
        [customIndexId],
      );
    }
  }

  private async patchDefinition(
    customIndexId: string,
    patch: Partial<
      Pick<
        CustomIndexDefinitionEntity,
        'status' | 'computeProgress' | 'computeStage' | 'lastError'
      >
    >,
  ): Promise<void> {
    await this.definitionRepo.update({ id: customIndexId }, patch);
  }
}
