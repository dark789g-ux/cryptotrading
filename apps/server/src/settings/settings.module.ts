import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { SymbolEntity } from '../entities/symbol.entity';
import { AppConfigEntity } from '../entities/app-config.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SymbolEntity, AppConfigEntity])],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
