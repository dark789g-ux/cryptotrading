import {
  ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import type { CurrentUser } from '../auth/shared/auth.types';
import { SnapshotBuilderService } from './snapshot-builder.service';
import { DeepseekService } from './deepseek.service';
import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { ListQueryDto } from './dto/list-query.dto';

@Injectable()
export class DailyReviewService {
  private readonly logger = new Logger(DailyReviewService.name);

  constructor(
    @InjectRepository(DailyReviewEntity)
    private readonly repo: Repository<DailyReviewEntity>,
    private readonly ds: DataSource,
    private readonly builder: SnapshotBuilderService,
    private readonly deepseek: DeepseekService,
    private readonly gateway: DailyReviewProgressGateway,
  ) {}

  async list(q: ListQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const qb = this.repo.createQueryBuilder('r')
      .orderBy('r.tradeDate', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async getDetail(tradeDate: string, user?: CurrentUser) {
    const row = await this.repo.findOne({ where: { tradeDate } });
    if (!row) throw new NotFoundException(`复盘 ${tradeDate} 不存在`);
    if (user?.role !== 'admin') {
      const { reasoningContent, tokenUsage, llmModel, ...rest } = row;
      return rest;
    }
    return row;
  }

  async startGeneration(dto: CreateReviewDto, userId: string) {
    const tradeDate = dto.tradeDate ?? await this.resolveLatestTradeDate();

    if (this.gateway.hasActive(tradeDate)) {
      throw new ConflictException(`${tradeDate} 已有生成任务在进行`);
    }

    const existing = await this.repo.findOne({ where: { tradeDate } });
    const row = existing ?? this.repo.create({ tradeDate, createdById: userId });
    row.status = 'fetching';
    row.snapshot = null;
    row.articleMd = null;
    row.reasoningContent = null;
    row.tokenUsage = null;
    row.errorMessage = null;
    await this.repo.save(row);

    // 异步触发，不 await
    this.runPipeline(row.id, tradeDate).catch((err: Error) => {
      this.logger.error(`pipeline crashed for ${tradeDate}: ${err.stack}`);
    });

    return { tradeDate, status: row.status };
  }

  async remove(tradeDate: string) {
    const r = await this.repo.delete({ tradeDate });
    if (r.affected === 0) throw new NotFoundException(`复盘 ${tradeDate} 不存在`);
    return { ok: true };
  }

  private async runPipeline(id: string, tradeDate: string) {
    try {
      this.gateway.emit(tradeDate, { stage: 'validate', percent: 1 });

      this.gateway.emit(tradeDate, { stage: 'fetch', percent: 10 });
      const snapshot = await this.builder.buildSnapshot(tradeDate);

      this.gateway.emit(tradeDate, { stage: 'build', percent: 35 });
      await this.repo.update(id, { snapshot, status: 'generating' });

      const { article, reasoning, tokenUsage } = await this.deepseek.generateArticle(
        JSON.stringify(snapshot),
        (e) => this.gateway.emit(tradeDate, e),
      );

      this.gateway.emit(tradeDate, { stage: 'finalize', percent: 97 });
      if (article.length < 2000) {
        throw new Error(`文章长度异常 (${article.length} chars)`);
      }
      await this.repo.update(id, {
        articleMd: article,
        reasoningContent: reasoning,
        tokenUsage,
        llmModel: this.deepseek.modelName,
        status: 'completed',
      });
      this.gateway.emit(tradeDate, { stage: 'completed', percent: 100 });
    } catch (err: any) {
      await this.repo.update(id, { status: 'failed', errorMessage: err.message });
      this.gateway.emit(tradeDate, { stage: 'failed', percent: 0, error: err.message });
    }
  }

  private async resolveLatestTradeDate(): Promise<string> {
    const [r] = await this.ds.query(
      'SELECT MAX(trade_date) AS d FROM a_share_daily_quotes',
    );
    if (!r?.d) throw new UnprocessableEntityException('尚无任何 A 股日线数据');
    return r.d;
  }
}
