import {
  Body, Controller, Delete, Get, MessageEvent, Param, Post, Query, Req, Sse,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { DailyReviewService } from './daily-review.service';
import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { ListQueryDto } from './dto/list-query.dto';
import type { RequestWithUser } from '../auth/shared/auth.types';

@Controller('daily-review')
export class DailyReviewController {
  constructor(
    private readonly svc: DailyReviewService,
    private readonly gateway: DailyReviewProgressGateway,
  ) {}

  @Get()
  list(@Query() q: ListQueryDto) {
    return this.svc.list(q);
  }

  @Get(':tradeDate')
  detail(@Param('tradeDate') tradeDate: string, @Req() req: RequestWithUser) {
    return this.svc.getDetail(tradeDate, req.user);
  }

  @Post()
  @AdminOnly()
  create(@Body() dto: CreateReviewDto, @Req() req: RequestWithUser) {
    return this.svc.startGeneration(dto, req.user!.id);
  }

  @Delete(':tradeDate')
  @AdminOnly()
  remove(@Param('tradeDate') tradeDate: string) {
    return this.svc.remove(tradeDate);
  }

  @Sse(':tradeDate/stream')
  stream(@Param('tradeDate') tradeDate: string, @Req() req: RequestWithUser): Observable<MessageEvent> {
    const isAdmin = req.user?.role === 'admin';
    return this.gateway.observe(tradeDate, isAdmin).pipe(
      map((e) => ({ data: e } as MessageEvent)),
    );
  }
}
