import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { OamvDailyEntity } from '../../entities/oamv/oamv-daily.entity'
import { OamvController } from './oamv.controller'
import { OamvService } from './oamv.service'
import { TushareClientService } from '../a-shares/services/tushare-client.service'

@Module({
  imports: [TypeOrmModule.forFeature([OamvDailyEntity])],
  controllers: [OamvController],
  providers: [OamvService, TushareClientService],
})
export class OamvModule {}
