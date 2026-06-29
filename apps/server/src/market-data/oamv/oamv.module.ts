import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity'
import { OamvController } from './oamv.controller'
import { OamvService } from './oamv.service'
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity'

@Module({
  imports: [TypeOrmModule.forFeature([OamvDailyEntity, IndexDailyQuoteEntity])],
  controllers: [OamvController],
  providers: [OamvService],
  exports: [OamvService],
})
export class OamvModule {}
