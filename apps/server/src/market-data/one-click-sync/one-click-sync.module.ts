import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OneClickSyncRunEntity } from '../../entities/market-data/one-click-sync-run.entity';
import { BaseDataSyncModule } from '../base-data-sync/base-data-sync.module';
import { ASharesModule } from '../a-shares/a-shares.module';
import { MoneyFlowModule } from '../money-flow/money-flow.module';
import { ThsIndexDailyModule } from '../ths-index-daily/ths-index-daily.module';
import { ActiveMvModule } from '../active-mv/active-mv.module';
import { OamvModule } from '../oamv/oamv.module';
import { OneClickSyncController } from './one-click-sync.controller';
import { OneClickSyncOrchestratorService } from './one-click-sync-orchestrator.service';

/**
 * 「一键同步」后端托管编排模块。spec 2026-06-16-one-click-sync-backend-orchestration-design。
 *
 * 复用 6 个现有 sync service（各自 module 已 export 对应 service）——锁与逻辑零改；
 * 自身仅新增一张 one_click_sync_runs 进度行（public schema）+ 编排器 + 4 个端点。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OneClickSyncRunEntity]),
    BaseDataSyncModule,
    ASharesModule,
    MoneyFlowModule,
    ThsIndexDailyModule,
    ActiveMvModule,
    OamvModule,
  ],
  controllers: [OneClickSyncController],
  providers: [OneClickSyncOrchestratorService],
})
export class OneClickSyncModule {}
