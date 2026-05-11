import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { DailyReviewController } from './daily-review.controller';
import { DailyReviewService } from './daily-review.service';
import { SnapshotBuilderService } from './snapshot-builder.service';
import { TushareClientService } from '../market-data/a-shares/services/tushare-client.service';
import { DeepseekService } from './deepseek.service';

const DEEPSEEK_CLIENT = 'DEEPSEEK_CLIENT';

const deepseekClientProvider = {
  provide: DEEPSEEK_CLIENT,
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) =>
    new OpenAI({
      apiKey: cfg.getOrThrow<string>('DEEPSEEK_API_KEY'),
      baseURL: cfg.get<string>('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com',
      timeout: 240_000,
    }),
};

const deepseekServiceProvider = {
  provide: DeepseekService,
  inject: [DEEPSEEK_CLIENT, ConfigService],
  useFactory: (client: OpenAI, cfg: ConfigService) =>
    new DeepseekService(client, {
      model: cfg.get<string>('DEEPSEEK_MODEL') || 'deepseek-v4-pro',
    }),
};

@Module({
  imports: [TypeOrmModule.forFeature([DailyReviewEntity]), ConfigModule],
  controllers: [DailyReviewController],
  providers: [
    DailyReviewService,
    SnapshotBuilderService,
    TushareClientService,
    deepseekClientProvider,
    deepseekServiceProvider,
  ],
})
export class DailyReviewModule {}
