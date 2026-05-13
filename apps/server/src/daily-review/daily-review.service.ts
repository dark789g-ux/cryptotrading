import {
  ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import type { CurrentUser } from '../auth/shared/auth.types';
import { SnapshotBuilderService } from './snapshot-builder.service';
import { LLM_PROVIDER, type LlmProvider } from './llm/llm-provider.interface';
import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import { InvestigatorService } from './investigator.service';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { ListQueryDto } from './dto/list-query.dto';
import type {
  EvidencePack,
  ProgressEvent,
  Stage,
  StageTiming,
  ToolCallLog,
} from './daily-review.types';

@Injectable()
export class DailyReviewService {
  private readonly logger = new Logger(DailyReviewService.name);

  constructor(
    @InjectRepository(DailyReviewEntity)
    private readonly repo: Repository<DailyReviewEntity>,
    private readonly ds: DataSource,
    private readonly builder: SnapshotBuilderService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly gateway: DailyReviewProgressGateway,
    private readonly investigator: InvestigatorService,
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
      // stageTimings 不属敏感数据（仅耗时），对所有用户可见
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
    row.stageTimings = null;
    row.errorMessage = null;
    row.llmModel = null;
    row.evidencePack = null;
    row.investigatorToolCalls = null;
    row.investigatorToolCallCount = null;
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
    const stageTimings: StageTiming[] = [];
    let currentStage: Stage = 'validate';
    // UTC 墙钟字符串（CLAUDE.md 时间规范）
    let currentStageStartedAt: string = new Date().toISOString();
    let currentStageStartMs = Date.now();
    let partialReasoning = '';

    const finishCurrent = (now: number) => {
      const durationMs = now - currentStageStartMs;
      stageTimings.push({ stage: currentStage, startedAt: currentStageStartedAt, durationMs });
      return durationMs;
    };

    const transitionStage = (next: Stage, percent: number) => {
      const now = Date.now();
      const durationMs = finishCurrent(now);
      this.gateway.emit(tradeDate, { type: 'stage_done', stage: currentStage, durationMs, ts: now });
      currentStage = next;
      currentStageStartedAt = new Date(now).toISOString();
      currentStageStartMs = now;
      this.gateway.emit(tradeDate, { type: 'stage', stage: next, percent, ts: now });
    };

    // LLM provider 在收到首个 content 时会自行发 stage_done(reasoning)+stage(writing)；pipeline 监听后同步累计 timings
    const onLlmProgress = (e: ProgressEvent) => {
      if (e.type === 'reasoning_delta') partialReasoning += e.text;
      if (e.type === 'stage_done' && e.stage === 'reasoning' && currentStage === 'reasoning') {
        stageTimings.push({ stage: 'reasoning', startedAt: currentStageStartedAt, durationMs: e.durationMs });
        currentStage = 'writing';
        currentStageStartedAt = new Date(e.ts).toISOString();
        currentStageStartMs = e.ts;
      }
      this.gateway.emit(tradeDate, e);
    };

    // Stage1 产出（落库 + 注入 Writer），Investigator 失败时为 null + degraded=true
    let evidencePack: EvidencePack | null = null;
    let investigatorToolCalls: ToolCallLog[] | null = null;
    let investigatorToolCallCount: number | null = null;
    let investigatorDegraded = false;

    try {
      this.gateway.emit(tradeDate, { type: 'stage', stage: 'validate', percent: 1, ts: Date.now() });

      transitionStage('fetch', 10);
      const snapshot = await this.builder.buildSnapshot(tradeDate);

      transitionStage('build', 35);
      await this.repo.update(id, { snapshot, status: 'generating' });

      // Stage1 · Investigator：tool-calling 自主追查归因；失败返回 null 走 Writer 降级
      transitionStage('investigate', 42);
      const investigateResult = await this.investigator.investigate(snapshot, onLlmProgress);
      if (investigateResult) {
        evidencePack = investigateResult.evidencePack;
        investigatorToolCalls = investigateResult.toolCallLog;
        investigatorToolCallCount = investigateResult.toolCallLog.length;
      } else {
        investigatorDegraded = true;
        this.logger.warn(`[investigator_degraded] tradeDate=${tradeDate}，Writer 走外部归因缺失降级写作`);
      }

      transitionStage('reasoning', 60);
      const { article, reasoning, tokenUsage } = await this.llm.generateArticle(
        JSON.stringify(snapshot),
        onLlmProgress,
        // Investigator 失败时显式传 null 触发 Writer prompt 的「外部归因数据缺失」降级分支
        investigatorDegraded ? null : evidencePack,
      );

      transitionStage('finalize', 97);
      if (article.length < 2000) {
        throw new Error(`文章长度异常 (${article.length} chars)`);
      }
      const finalizeNow = Date.now();
      finishCurrent(finalizeNow);
      this.gateway.emit(tradeDate, { type: 'stage_done', stage: 'finalize', durationMs: finalizeNow - currentStageStartMs, ts: finalizeNow });

      await this.repo.update(id, {
        articleMd: article,
        reasoningContent: reasoning,
        tokenUsage,
        llmModel: this.llm.modelName,
        stageTimings,
        evidencePack,
        investigatorToolCalls,
        investigatorToolCallCount,
        // Investigator 降级时把降级标记塞进 errorMessage（最小侵入，admin 列表页一眼可见）
        errorMessage: investigatorDegraded ? 'investigator_degraded' : null,
        status: 'completed',
      });
      this.gateway.emit(tradeDate, { type: 'completed', ts: Date.now() });
    } catch (err: any) {
      // 失败时仍把已收集的 reasoning 残段与 stageTimings 落库，便于 admin 排错 prompt
      finishCurrent(Date.now());
      await this.repo.update(id, {
        status: 'failed',
        errorMessage: err.message,
        reasoningContent: partialReasoning || null,
        stageTimings,
        // 把 Stage1 已经收集到的证据/工具日志一并落库，便于失败时排查
        evidencePack,
        investigatorToolCalls,
        investigatorToolCallCount,
      });
      this.gateway.emit(tradeDate, { type: 'failed', error: err.message, ts: Date.now() });
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
