import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiKeyEntity } from '../entities/api-key/api-key.entity';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKeyEntity])],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
