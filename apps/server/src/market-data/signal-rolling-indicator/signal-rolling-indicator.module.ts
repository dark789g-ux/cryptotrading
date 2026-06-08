import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SignalRollingIndicatorEntity } from '../../entities/strategy/signal-rolling-indicator.entity';
import { SignalRollingIndicatorController } from './signal-rolling-indicator.controller';
import { SignalRollingIndicatorService } from './signal-rolling-indicator.service';

/**
 * 滚动指标模块（仿 active-mv）。
 * 预计算 5 个滚动指标落 signal_rolling_indicator（与 raw.daily_quote 1:1）。
 * service 走裸 SQL（@InjectDataSource），forFeature 注册实体仅为元数据/双注册一致性。
 * 导出 service 供 A股同步链（T6）注入做脏重算。
 */
@Module({
  imports: [TypeOrmModule.forFeature([SignalRollingIndicatorEntity])],
  controllers: [SignalRollingIndicatorController],
  providers: [SignalRollingIndicatorService],
  exports: [SignalRollingIndicatorService],
})
export class SignalRollingIndicatorModule {}
