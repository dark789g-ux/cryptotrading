import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegimeStrategyConfigEntity } from '../../entities/strategy/regime-strategy-config.entity';
import { RegimeDailyPickEntity } from '../../entities/strategy/regime-daily-pick.entity';
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { StrategyConditionsModule } from '../../strategy-conditions/strategy-conditions.module';
import { RegimeEngineController } from './regime-engine.controller';
import { RegimeEngineService } from './regime-engine.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RegimeStrategyConfigEntity,
      RegimeDailyPickEntity,
      OamvDailyEntity,
      AShareSymbolEntity,
    ]),
    // 复用条件系统查询构建器（StrategyConditionsQueryBuilder 由该模块导出）
    StrategyConditionsModule,
  ],
  controllers: [RegimeEngineController],
  providers: [RegimeEngineService],
})
export class RegimeEngineModule {}
