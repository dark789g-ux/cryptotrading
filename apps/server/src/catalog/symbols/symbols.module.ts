import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SymbolsController } from './symbols.controller';
import { SymbolsService } from './symbols.service';
import { SymbolEntity } from '../entities/symbol.entity';
import { KlineEntity } from '../entities/kline.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SymbolEntity, KlineEntity])],
  controllers: [SymbolsController],
  providers: [SymbolsService],
  exports: [SymbolsService],
})
export class SymbolsModule {}
