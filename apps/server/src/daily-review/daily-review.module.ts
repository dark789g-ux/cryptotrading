import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { MacroEventEntity } from '../entities/macro-event/macro-event.entity';
import { AShareSymbolEntity } from '../entities/a-share/a-share-symbol.entity';
import { MoneyFlowStockEntity } from '../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowSectorEntity } from '../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowIndustryEntity } from '../entities/money-flow/money-flow-industry.entity';
import { ThsMemberStockEntity } from '../entities/money-flow/ths-member-stock.entity';
import { DailyReviewController } from './daily-review.controller';
import { DailyReviewService } from './daily-review.service';
import { SnapshotBuilderService } from './snapshot/snapshot-builder.service';
import { TushareClientService } from '../market-data/a-shares/services/tushare-client.service';
import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import { LLM_PROVIDER } from './llm/llm-provider.interface';
import { DeepseekLlmProvider } from './llm/deepseek.provider';
import { MimoLlmProvider } from './llm/mimo.provider';
import { OvernightMarketService } from './snapshot/overnight/overnight-market.service';
import { MacroCalendarService } from './snapshot/macro/macro-calendar.service';
import { ReviewHistoryService } from './snapshot/history/review-history.service';
import { NewsSearchClient } from './investigation/news/news-search.client';
import { InvestigatorService } from './investigation/investigator.service';
import { ToolDispatcherService } from './investigation/tools/tool-dispatcher.service';
import { SearchNewsHandler } from './investigation/tools/handlers/search-news.handler';
import { LookupStockHandler } from './investigation/tools/handlers/lookup-stock.handler';
import { LookupConceptHandler } from './investigation/tools/handlers/lookup-concept.handler';
import { ReadPreviousReviewHandler } from './investigation/tools/handlers/read-previous-review.handler';
import { FetchTopListHandler } from './investigation/tools/handlers/fetch-top-list.handler';

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
  imports: [
    TypeOrmModule.forFeature([
      DailyReviewEntity,
      MacroEventEntity,
      AShareSymbolEntity,
      MoneyFlowStockEntity,
      MoneyFlowSectorEntity,
      MoneyFlowIndustryEntity,
      ThsMemberStockEntity,
    ]),
    ConfigModule,
  ],
  controllers: [DailyReviewController],
  providers: [
    DailyReviewService,
    SnapshotBuilderService,
    TushareClientService,
    DailyReviewProgressGateway,
    // Stage 0 数据源
    OvernightMarketService,
    MacroCalendarService,
    ReviewHistoryService,
    // Stage 1 工具与外部检索
    NewsSearchClient,
    InvestigatorService,
    ToolDispatcherService,
    SearchNewsHandler,
    LookupStockHandler,
    LookupConceptHandler,
    ReadPreviousReviewHandler,
    FetchTopListHandler,
    // LLM
    llmClientProvider,
    llmProviderProvider,
  ],
})
export class DailyReviewModule {}
