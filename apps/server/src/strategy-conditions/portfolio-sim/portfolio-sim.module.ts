/**
 * portfolio-sim.module.ts
 *
 * 组合级模拟器模块：注册三实体（forFeature——实体双注册的 module 侧；
 * 根 entities 数组已在 app.module 注册）+ controller + providers
 * （service / runner / loader）。
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PortfolioSimRunEntity } from '../../entities/strategy/portfolio-sim-run.entity';
import { PortfolioSimDailyEntity } from '../../entities/strategy/portfolio-sim-daily.entity';
import { PortfolioSimFillEntity } from '../../entities/strategy/portfolio-sim-fill.entity';
import { PortfolioSimController } from './portfolio-sim.controller';
import { PortfolioSimService } from './portfolio-sim.service';
import { PortfolioSimRunner } from './portfolio-sim.runner';
import { PortfolioSimLoader } from './portfolio-sim.loader';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PortfolioSimRunEntity,
      PortfolioSimDailyEntity,
      PortfolioSimFillEntity,
    ]),
  ],
  controllers: [PortfolioSimController],
  providers: [PortfolioSimService, PortfolioSimRunner, PortfolioSimLoader],
  // signal-stats 迷你回测层（M1）复用 loader 装载引擎输入（spec 04 §4.1）。
  exports: [PortfolioSimLoader],
})
export class PortfolioSimModule {}
