import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EtfSymbolEntity } from '../../entities/raw/etf-symbol.entity';
import { EtfPcfEntity } from '../../entities/raw/etf-pcf.entity';
import { FundDailyEntity } from '../../entities/raw/fund-daily.entity';
import { FundDailyIndicatorEntity } from '../../entities/raw/fund-daily-indicator.entity';
import { FundAmvDailyEntity } from '../../entities/raw/fund-amv-daily.entity';
import { MoneyFlowEtfEntity } from '../../entities/money-flow/money-flow-etf.entity';
import { ASharesModule } from '../a-shares/a-shares.module';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { EtfCatalogService } from './etf-catalog.service';
import { EtfController } from './etf.controller';
import { EtfFundDailyService } from './etf-fund-daily.service';
import { EtfIndicatorService } from './etf-indicator.service';
import { EtfMfService } from './etf-mf.service';
import { EtfAmvService } from './etf-amv.service';
import { EtfPcfService } from './etf-pcf.service';
import { EtfQueryService } from './etf-query.service';
import { EtfService } from './etf.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EtfSymbolEntity,
      EtfPcfEntity,
      FundDailyEntity,
      FundDailyIndicatorEntity,
      FundAmvDailyEntity,
      MoneyFlowEtfEntity,
    ]),
    ASharesModule,
  ],
  controllers: [EtfController],
  providers: [
    TushareClientService,
    EtfService,
    EtfCatalogService,
    EtfFundDailyService,
    EtfPcfService,
    EtfIndicatorService,
    EtfAmvService,
    EtfMfService,
    EtfQueryService,
  ],
  exports: [
    EtfService,
    EtfAmvService,
    EtfMfService,
  ],
})
export class EtfModule {}
