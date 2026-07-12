import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RequestWithUser } from '../../auth/shared/auth.types';
import { CustomIndexService } from './custom-index.service';
import { parseQueryCustomIndexLatest } from './dto/custom-index-latest.dto';
import {
  validateCreateCustomIndexBody,
  validatePreviewWeightsBody,
} from './dto/create-custom-index.dto';
import { validateUpdateCustomIndexBody } from './dto/update-custom-index.dto';

@Controller('custom-indices')
export class CustomIndexController {
  constructor(private readonly service: CustomIndexService) {}

  @Get('latest')
  latest(@Req() req: RequestWithUser, @Query() query: Record<string, unknown>) {
    return this.service.getLatest(req.user.id, parseQueryCustomIndexLatest(query));
  }

  @Post('preview-weights')
  previewWeights(@Body() body: unknown) {
    return this.service.previewWeights(validatePreviewWeightsBody(body));
  }

  @Post()
  create(@Req() req: RequestWithUser, @Body() body: unknown) {
    return this.service.create(req.user.id, validateCreateCustomIndexBody(body));
  }

  @Get(':id')
  detail(@Req() req: RequestWithUser, @Param('id') id: string) {
    return this.service.getDetail(req.user.id, id);
  }

  @Get(':id/members')
  members(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Query('as_of_date') asOfDate?: string,
  ) {
    return this.service.getMembers(req.user.id, id, asOfDate);
  }

  @Patch(':id')
  update(@Req() req: RequestWithUser, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(req.user.id, id, validateUpdateCustomIndexBody(body));
  }

  @Delete(':id')
  remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    return this.service.remove(req.user.id, id);
  }

  @Post(':id/recompute')
  recompute(@Req() req: RequestWithUser, @Param('id') id: string) {
    return this.service.recompute(req.user.id, id);
  }

  @Get(':id/kline')
  kline(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException('start_date 与 end_date 必填');
    }
    return this.service.getKline(req.user.id, id, startDate, endDate);
  }

  @Get(':id/amv')
  amv(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.service.getAmv(req.user.id, id, startDate, endDate);
  }

  @Get(':id/money-flow')
  moneyFlow(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException('start_date 与 end_date 必填');
    }
    return this.service.getMoneyFlow(req.user.id, id, startDate, endDate);
  }

  @Post(':id/sse-token')
  issueSseToken(@Req() req: RequestWithUser, @Param('id') id: string) {
    return this.service.issueSseToken(req.user.id, id);
  }
}
