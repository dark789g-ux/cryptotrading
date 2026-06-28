import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MlJobEntity } from '../../entities/ml/ml-job.entity';
import { CustomIndexDefinitionEntity } from '../../entities/custom-index/custom-index-definition.entity';

export interface EnqueueCustomIndexComputeOptions {
  customIndexId: string;
  userId: string;
  fullRebuild?: boolean;
}

@Injectable()
export class CustomIndexComputeService {
  private readonly logger = new Logger(CustomIndexComputeService.name);

  constructor(
    @InjectRepository(MlJobEntity)
    private readonly jobsRepo: Repository<MlJobEntity>,
    @InjectRepository(CustomIndexDefinitionEntity)
    private readonly definitionRepo: Repository<CustomIndexDefinitionEntity>,
  ) {}

  /**
   * 插入 ml.jobs（run_type=custom_index_compute）并回写 definition.latest_job_id / status=pending。
   * 普通用户不直接调 POST /api/quant/jobs。
   */
  async enqueue(opts: EnqueueCustomIndexComputeOptions): Promise<MlJobEntity> {
    const job = this.jobsRepo.create({
      runType: 'custom_index_compute',
      params: {
        custom_index_id: opts.customIndexId,
        user_id: opts.userId,
        full_rebuild: opts.fullRebuild !== false,
      },
      priority: 200,
      maxAttempts: 2,
      status: 'pending',
      progress: 0,
      attempts: 0,
      cancelRequested: false,
      createdBy: opts.userId,
    });
    const saved = await this.jobsRepo.save(job);

    await this.definitionRepo.update(
      { id: opts.customIndexId, userId: opts.userId },
      {
        latestJobId: saved.id,
        status: 'pending',
        computeProgress: 0,
        computeStage: null,
        lastError: null,
      },
    );

    this.logger.log(
      `custom_index_compute enqueued custom_index_id=${opts.customIndexId} job_id=${saved.id}`,
    );
    return saved;
  }

  /** 若关联 job 仍在 running/pending，请求 cancel */
  async cancelLatestJob(definition: CustomIndexDefinitionEntity): Promise<void> {
    if (!definition.latestJobId) return;
    const job = await this.jobsRepo.findOne({ where: { id: definition.latestJobId } });
    if (!job) return;
    if (['success', 'failed', 'blocked', 'cancelled'].includes(job.status)) return;
    if (job.status === 'draft') {
      await this.jobsRepo.update({ id: job.id }, { status: 'cancelled' });
      return;
    }
    await this.jobsRepo.update({ id: job.id }, { cancelRequested: true });
  }
}
