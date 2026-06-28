import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomIndexDefinitionEntity } from '../../entities/custom-index/custom-index-definition.entity';
import { CustomIndexWeightVersionEntity } from '../../entities/custom-index/custom-index-weight-version.entity';
import { CustomIndexMemberEntity } from '../../entities/custom-index/custom-index-member.entity';
import { CustomIndexDailyQuoteEntity } from '../../entities/custom-index/custom-index-daily-quote.entity';
import { CustomIndexDailyIndicatorEntity } from '../../entities/custom-index/custom-index-daily-indicator.entity';
import { CustomIndexMoneyFlowEntity } from '../../entities/custom-index/custom-index-money-flow.entity';
import { CustomIndexAmvEntity } from '../../entities/custom-index/custom-index-amv.entity';
import { QuantModule } from '../../modules/quant/quant.module';
import { CustomIndexComputeRunner } from './compute/custom-index-compute.runner';
import { CustomIndexIndicatorService } from './compute/custom-index-indicator.service';
import { CustomIndexMoneyFlowService } from './compute/custom-index-money-flow.service';
import { CustomIndexQuotesWriter } from './compute/custom-index-quotes-writer';
import { CustomIndexController } from './custom-index.controller';
import { CustomIndexSseController } from './custom-index-sse.controller';
import { CustomIndexService } from './custom-index.service';
import { CustomIndexComputeService } from './custom-index-compute.service';
import { CustomIndexStartupService } from './custom-index-startup.service';
import { CustomIndexSseGuard } from './custom-index-sse.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CustomIndexDefinitionEntity,
      CustomIndexWeightVersionEntity,
      CustomIndexMemberEntity,
      CustomIndexDailyQuoteEntity,
      CustomIndexDailyIndicatorEntity,
      CustomIndexMoneyFlowEntity,
      CustomIndexAmvEntity,
    ]),
    QuantModule,
  ],
  controllers: [CustomIndexController, CustomIndexSseController],
  providers: [
    CustomIndexService,
    CustomIndexComputeService,
    CustomIndexComputeRunner,
    CustomIndexQuotesWriter,
    CustomIndexIndicatorService,
    CustomIndexMoneyFlowService,
    CustomIndexStartupService,
    CustomIndexSseGuard,
  ],
  exports: [CustomIndexService],
})
export class CustomIndexModule {}
