import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { DailyReviewController } from './daily-review.controller';
import { DailyReviewService } from './daily-review.service';
import { SnapshotBuilderService } from './snapshot-builder.service';
import { TushareClientService } from '../market-data/a-shares/services/tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([DailyReviewEntity]), ConfigModule],
  controllers: [DailyReviewController],
  providers: [DailyReviewService, SnapshotBuilderService, TushareClientService],
})
export class DailyReviewModule {}
