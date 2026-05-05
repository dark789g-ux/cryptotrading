import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyConditionEntity } from '../entities/strategy-condition.entity';
import { StrategyConditionsController } from './strategy-conditions.controller';
import { StrategyConditionsService } from './strategy-conditions.service';

@Module({
  imports: [TypeOrmModule.forFeature([StrategyConditionEntity])],
  controllers: [StrategyConditionsController],
  providers: [StrategyConditionsService],
  exports: [StrategyConditionsService],
})
export class StrategyConditionsModule {}
