import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MlJobEntity } from '../../entities/ml/ml-job.entity';
import { MlModelRunEntity } from '../../entities/ml/ml-model-run.entity';
import { MlScoreDailyEntity } from '../../entities/ml/ml-score-daily.entity';
import { MlQualityReportEntity } from '../../entities/ml/ml-quality-report.entity';
import { QuantJobsService } from './services/quant-jobs.service';
import { SseTokenService } from './services/sse-token.service';
import { QuantJobsController } from './controllers/quant-jobs.controller';
import { QuantJobsSseController } from './controllers/quant-jobs-sse.controller';
import { SseTokenGuard } from './guards/sse-token.guard';

/**
 * `apps/server/src/modules/quant/`：量化模型训练相关 HTTP 表面。
 *
 * M2 范围（本 PR）：
 *   - jobs controller：POST/GET /quant/jobs/* + POST /quant/jobs/:id/sse-token
 *   - sse-stream controller：GET /quant/jobs/:id/stream（M2 polling 占位，M4 升 LISTEN/NOTIFY）
 *   - SseTokenGuard + SseTokenService：5 分钟短期 token 签发与校验
 *
 * 留到 M3 / M4：
 *   - scores / runs / quality 三只读 controller（M3，与 UI 一并）
 *   - PG LISTEN/NOTIFY 实时进度（M4 替换 polling 实现）
 *
 * 注册的 entities 仅覆盖 ml.* 4 张表：
 *   - ml.jobs：本 module **读写**（INSERT pending + UPDATE cancel_requested）
 *   - ml.model_runs / ml.scores_daily / ml.quality_reports：**仅声明 entity**，
 *     M2 不在本 service 暴露 mutator，留给 M3 真正使用。
 * raw / factors schema 由其它 module 拥有，本 module 不直接读写。
 * 表 DDL 由 Python 侧 Alembic 管理（synchronize: false）。
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      MlJobEntity,
      MlModelRunEntity,
      MlScoreDailyEntity,
      MlQualityReportEntity,
    ]),
  ],
  controllers: [QuantJobsController, QuantJobsSseController],
  providers: [QuantJobsService, SseTokenService, SseTokenGuard],
  exports: [QuantJobsService, SseTokenService, SseTokenGuard],
})
export class QuantModule {}
