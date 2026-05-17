import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MlJobEntity } from '../../entities/ml/ml-job.entity';
import { MlModelRunEntity } from '../../entities/ml/ml-model-run.entity';
import { MlScoreDailyEntity } from '../../entities/ml/ml-score-daily.entity';
import { MlQualityReportEntity } from '../../entities/ml/ml-quality-report.entity';
import { QuantJobsService } from './services/quant-jobs.service';
import { SseTokenService } from './services/sse-token.service';
import { QuantScoresService } from './services/quant-scores.service';
import { QuantRunsService } from './services/quant-runs.service';
import { QuantQualityService } from './services/quant-quality.service';
import { QuantJobsController } from './controllers/quant-jobs.controller';
import { QuantJobsSseController } from './controllers/quant-jobs-sse.controller';
import { QuantScoresController } from './controllers/quant-scores.controller';
import { QuantRunsController } from './controllers/quant-runs.controller';
import { QuantQualityController } from './controllers/quant-quality.controller';
import { SseTokenGuard } from './guards/sse-token.guard';

/**
 * `apps/server/src/modules/quant/`：量化模型训练相关 HTTP 表面。
 *
 * M2 范围（本 PR）：
 *   - jobs controller：POST/GET /quant/jobs/* + POST /quant/jobs/:id/sse-token
 *   - sse-stream controller：GET /quant/jobs/:id/stream（M2 polling 占位，M4 升 LISTEN/NOTIFY）
 *   - SseTokenGuard + SseTokenService：5 分钟短期 token 签发与校验
 *
 * M3 追加（本 PR）：
 *   - scores controller：GET /quant/scores/{daily,ts/:ts_code,model-versions,compare}
 *   - runs controller：GET /quant/runs · GET /quant/runs/:id
 *   - quality controller：GET /quant/quality/recent · GET /quant/quality/:date
 *   - 每个 service 维护独立 FIELD_COL_MAP（CLAUDE.md 动态 SQL 规范）
 *
 * 留到 M4：
 *   - PG LISTEN/NOTIFY 实时进度（M4 替换 polling 实现）
 *   - SHAP / RunDetail UI 配套接口
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
  controllers: [
    QuantJobsController,
    QuantJobsSseController,
    QuantScoresController,
    QuantRunsController,
    QuantQualityController,
  ],
  providers: [
    QuantJobsService,
    SseTokenService,
    SseTokenGuard,
    QuantScoresService,
    QuantRunsService,
    QuantQualityService,
  ],
  exports: [
    QuantJobsService,
    SseTokenService,
    SseTokenGuard,
    QuantScoresService,
    QuantRunsService,
    QuantQualityService,
  ],
})
export class QuantModule {}
