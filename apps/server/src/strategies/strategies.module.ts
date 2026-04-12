import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { StrategyEntity } from '../entities/strategy.entity';
import { StrategyTypeEntity } from '../entities/strategy-type.entity';

@Module({
  imports: [TypeOrmModule.forFeature([StrategyEntity, StrategyTypeEntity])],
  controllers: [StrategiesController],
  providers: [StrategiesService],
  exports: [StrategiesService],
})
export class StrategiesModule {}
