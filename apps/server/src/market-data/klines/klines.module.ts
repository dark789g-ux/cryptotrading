import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KlinesController } from './klines.controller';
import { KlinesService } from './klines.service';
import { KlineEntity } from '../../entities/kline.entity';

@Module({
  imports: [TypeOrmModule.forFeature([KlineEntity])],
  controllers: [KlinesController],
  providers: [KlinesService],
  exports: [KlinesService],
})
export class KlinesModule {}
