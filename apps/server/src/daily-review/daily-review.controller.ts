import { Controller, Get, Param, Query } from '@nestjs/common';
import { DailyReviewService } from './daily-review.service';
import { ListQueryDto } from './dto/list-query.dto';

@Controller('api/daily-review')
export class DailyReviewController {
  constructor(private readonly svc: DailyReviewService) {}

  @Get()
  list(@Query() q: ListQueryDto) {
    return this.svc.list(q);
  }

  @Get(':tradeDate')
  detail(@Param('tradeDate') tradeDate: string) {
    return this.svc.getDetail(tradeDate);
  }
}
