import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { DailyReviewController } from './daily-review.controller';
import { DailyReviewService } from './daily-review.service';

@Module({
  imports: [TypeOrmModule.forFeature([DailyReviewEntity])],
  controllers: [DailyReviewController],
  providers: [DailyReviewService],
})
export class DailyReviewModule {}
