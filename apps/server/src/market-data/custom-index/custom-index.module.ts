import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MlJobEntity } from '../../entities/ml/ml-job.entity';
import { CustomIndexDefinitionEntity } from '../../entities/custom-index/custom-index-definition.entity';
import { CustomIndexWeightVersionEntity } from '../../entities/custom-index/custom-index-weight-version.entity';
import { CustomIndexMemberEntity } from '../../entities/custom-index/custom-index-member.entity';
import { CustomIndexDailyQuoteEntity } from '../../entities/custom-index/custom-index-daily-quote.entity';
import { CustomIndexDailyIndicatorEntity } from '../../entities/custom-index/custom-index-daily-indicator.entity';
import { CustomIndexMoneyFlowEntity } from '../../entities/custom-index/custom-index-money-flow.entity';
import { CustomIndexAmvEntity } from '../../entities/custom-index/custom-index-amv.entity';
import { QuantModule } from '../../modules/quant/quant.module';
import { CustomIndexController } from './custom-index.controller';
import { CustomIndexSseController } from './custom-index-sse.controller';
import { CustomIndexService } from './custom-index.service';
import { CustomIndexComputeService } from './custom-index-compute.service';
import { CustomIndexSseGuard } from './custom-index-sse.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MlJobEntity,
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
  providers: [CustomIndexService, CustomIndexComputeService, CustomIndexSseGuard],
  exports: [CustomIndexService],
})
export class CustomIndexModule {}
