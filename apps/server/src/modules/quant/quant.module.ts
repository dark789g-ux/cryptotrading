import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MlJobEntity } from '../../entities/ml/ml-job.entity';
import { MlModelRunEntity } from '../../entities/ml/ml-model-run.entity';
import { MlScoreDailyEntity } from '../../entities/ml/ml-score-daily.entity';
import { MlQualityReportEntity } from '../../entities/ml/ml-quality-report.entity';
import { UserEntity } from '../../users/entities/user.entity';
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
import { PgListenService } from './realtime/pg-listen.service';
import { FactorsModule } from './factors/factors.module';

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
 * M4 追加（本 PR · Part B）：
 *   - PgListenService：长生命周期独立 PG 连接 `LISTEN ml_job_progress`，桥接 NOTIFY
 *     到 RxJS Subject 供 SSE controller 广播订阅
 *   - QuantJobsSseController：升级到 LISTEN/NOTIFY，建连先 SELECT 一次快照（避免漏掉
 *     LISTEN 注册之前 worker 已写过的进度），后续按 job_id 过滤转发 NOTIFY
 *
 * 留到 M4 Part A/C：
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
      // SSE 流接口二次校验当前 user.role（refactor 2026-05-23 由 env 白名单改为 DB role）
      UserEntity,
    ]),
    // 因子元数据 admin 管理 API（spec 2026-05-23-factor-registry-frontend-design）
    FactorsModule,
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
    // M4 Part M：PG LISTEN/NOTIFY 桥接（长生命周期独立连接，不复用 TypeORM 池）
    PgListenService,
  ],
  exports: [
    QuantJobsService,
    SseTokenService,
    SseTokenGuard,
    QuantScoresService,
    QuantRunsService,
    QuantQualityService,
    PgListenService,
  ],
})
export class QuantModule {}
