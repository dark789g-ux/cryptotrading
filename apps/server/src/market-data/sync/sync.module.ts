import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { SymbolEntity } from '../entities/symbol.entity';
import { KlineEntity } from '../entities/kline.entity';
import { AppConfigEntity } from '../entities/app-config.entity';
import { SymbolsModule } from '../symbols/symbols.module';
import { KlinesModule } from '../klines/klines.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SymbolEntity, KlineEntity, AppConfigEntity]),
    SymbolsModule,
    KlinesModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
