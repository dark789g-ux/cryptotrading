import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AShareDailyMetricEntity } from '../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { ASharesController } from './a-shares.controller';
import { ASharesService } from './a-shares.service';
import { TushareClientService } from './tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([AShareSymbolEntity, AShareDailyQuoteEntity, AShareDailyMetricEntity])],
  controllers: [ASharesController],
  providers: [ASharesService, TushareClientService],
  exports: [ASharesService],
})
export class ASharesModule {}
