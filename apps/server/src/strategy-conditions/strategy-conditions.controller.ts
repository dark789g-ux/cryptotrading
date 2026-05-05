import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { StrategyConditionsService } from './strategy-conditions.service';
import { CreateStrategyConditionDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('strategy-conditions')
@UseGuards(AuthGuard)
export class StrategyConditionsController {
  constructor(private readonly service: StrategyConditionsService) {}

  @Post()
  create(@Request() req: any, @Body() dto: CreateStrategyConditionDto) {
    return this.service.create(req.user.id, dto);
  }

  @Get()
  findAll(@Request() req: any, @Query('targetType') targetType?: string) {
    return this.service.findAll(req.user.id, targetType);
  }

  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    return this.service.findOne(id, req.user.id);
  }

  @Put(':id')
  update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateStrategyConditionDto,
  ) {
    return this.service.update(id, req.user.id, dto);
  }

  @Delete(':id')
  remove(@Request() req: any, @Param('id') id: string) {
    return this.service.remove(id, req.user.id);
  }

  @Post(':id/run')
  run(@Request() req: any, @Param('id') id: string) {
    return this.service.run(id, req.user.id);
  }
}
