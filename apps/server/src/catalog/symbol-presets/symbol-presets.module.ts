import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SymbolPresetsController } from './symbol-presets.controller';
import { SymbolPresetsService } from './symbol-presets.service';
import { SymbolPresetEntity } from '../entities/symbol-preset.entity';
import { SymbolPresetItemEntity } from '../entities/symbol-preset-item.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SymbolPresetEntity, SymbolPresetItemEntity])],
  controllers: [SymbolPresetsController],
  providers: [SymbolPresetsService],
  exports: [SymbolPresetsService],
})
export class SymbolPresetsModule {}
