import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { DailyReviewController } from './daily-review.controller';
import { DailyReviewService } from './daily-review.service';
import { SnapshotBuilderService } from './snapshot-builder.service';
import { TushareClientService } from '../market-data/a-shares/services/tushare-client.service';
import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import { LLM_PROVIDER } from './llm/llm-provider.interface';
import { DeepseekLlmProvider } from './llm/deepseek.provider';
import { MimoLlmProvider } from './llm/mimo.provider';

const LLM_CLIENT = 'LLM_CLIENT';

const llmClientProvider = {
  provide: LLM_CLIENT,
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) =>
    new OpenAI({
      apiKey: cfg.getOrThrow<string>('LLM_API_KEY'),
      baseURL: cfg.getOrThrow<string>('LLM_BASE_URL'),
      timeout: 240_000,
    }),
};

const llmProviderProvider = {
  provide: LLM_PROVIDER,
  inject: [LLM_CLIENT, ConfigService],
  useFactory: (client: OpenAI, cfg: ConfigService) => {
    const kind = cfg.getOrThrow<string>('LLM_PROVIDER');
    const model = cfg.getOrThrow<string>('LLM_MODEL');
    switch (kind) {
      case 'deepseek': return new DeepseekLlmProvider(client, model);
      case 'mimo':     return new MimoLlmProvider(client, model);
      default:
        throw new Error(`Unknown LLM_PROVIDER: ${kind} (expected 'deepseek' or 'mimo')`);
    }
  },
};

@Module({
  imports: [TypeOrmModule.forFeature([DailyReviewEntity]), ConfigModule],
  controllers: [DailyReviewController],
  providers: [
    DailyReviewService,
    SnapshotBuilderService,
    TushareClientService,
    DailyReviewProgressGateway,
    llmClientProvider,
    llmProviderProvider,
  ],
})
export class DailyReviewModule {}
