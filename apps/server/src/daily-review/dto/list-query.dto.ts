import type { DailyReviewStatus } from '../../entities/daily-review/daily-review.entity';

export class ListQueryDto {
  status?: DailyReviewStatus;
  page?: number;
  pageSize?: number;
}
