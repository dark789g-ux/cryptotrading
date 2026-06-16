import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TradeCalEntity } from '../../entities/raw/trade-cal.entity';
import { StkLimitEntity } from '../../entities/raw/stk-limit.entity';
import { SuspendEntity } from '../../entities/raw/suspend.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { BaseDataSyncService } from './base-data-sync.service';

// 历史上有 BaseDataSyncController（@AdminOnly HTTP：/api/base-data/sync/run SSE + /range）
// 驱动「基础数据」手动同步弹窗；弹窗在 43fa7be 移除后整条 HTTP 链悬空，于 2026-06-16 一并删除。
// BaseDataSyncService 仍存活——由一键同步编排器（one-click-sync）进程内 DI 直调。
@Module({
  imports: [TypeOrmModule.forFeature([TradeCalEntity, StkLimitEntity, SuspendEntity])],
  providers: [BaseDataSyncService, TushareClientService],
  exports: [BaseDataSyncService],
})
export class BaseDataSyncModule {}
