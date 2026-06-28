import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomIndexDefinitionEntity } from '../../entities/custom-index/custom-index-definition.entity';
import { CustomIndexComputeRunner } from './compute/custom-index-compute.runner';

export interface EnqueueCustomIndexComputeOptions {
  customIndexId: string;
  userId: string;
  fullRebuild?: boolean;
}

@Injectable()
export class CustomIndexComputeService {
  private readonly logger = new Logger(CustomIndexComputeService.name);

  constructor(
    @InjectRepository(CustomIndexDefinitionEntity)
    private readonly definitionRepo: Repository<CustomIndexDefinitionEntity>,
    private readonly runner: CustomIndexComputeRunner,
  ) {}

  /** @deprecated 别名，指向 scheduleCompute */
  enqueue(opts: EnqueueCustomIndexComputeOptions): boolean {
    return this.scheduleCompute(opts);
  }

  /** @returns false 若该指数已在计算中（内存锁拒绝重复调度） */
  scheduleCompute(opts: EnqueueCustomIndexComputeOptions): boolean {
    if (!this.runner.tryAcquire(opts.customIndexId)) {
      this.logger.warn(
        `custom_index_compute duplicate schedule rejected id=${opts.customIndexId}`,
      );
      return false;
    }

    void this.definitionRepo
      .update(
        { id: opts.customIndexId, userId: opts.userId },
        {
          status: 'pending',
          computeProgress: 0,
          computeStage: null,
          lastError: null,
        },
      )
      .then(() =>
        this.runner.run({
          customIndexId: opts.customIndexId,
          userId: opts.userId,
          fullRebuild: opts.fullRebuild !== false,
        }),
      )
      .catch(async (err: unknown) => {
        this.runner.release(opts.customIndexId);
        const message = err instanceof Error ? err.message : String(err);
        await this.definitionRepo.update(
          { id: opts.customIndexId, userId: opts.userId },
          {
            status: 'failed',
            computeProgress: null,
            computeStage: null,
            lastError: message,
          },
        );
        this.logger.error(
          `custom_index_compute failed id=${opts.customIndexId}: ${message}`,
          err instanceof Error ? err.stack : undefined,
        );
      });

    this.logger.log(`custom_index_compute scheduled id=${opts.customIndexId}`);
    return true;
  }
}
