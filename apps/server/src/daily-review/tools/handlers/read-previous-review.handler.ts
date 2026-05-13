import { Injectable } from '@nestjs/common';
import { ReviewHistoryService } from '../../history/review-history.service';
import { ToolArgError, type ToolHandler } from '../tool-types';
import type { PreviousReview } from '../../history/history.types';

/**
 * read_previous_review（spec § 5.1）
 *
 * 入参：offsetDays: number（1 = 上一交易日已完成的复盘）
 * 出参：PreviousReview | null（未命中返回 null，由 LLM 自行处理）
 *
 * 直接转发到 ReviewHistoryService.readPrevious；不再附加业务逻辑。
 * 入参缺失时 throw ToolArgError → dispatcher 转 error 字段回 LLM。
 */
@Injectable()
export class ReadPreviousReviewHandler implements ToolHandler {
  readonly name = 'read_previous_review';

  constructor(private readonly reviewHistoryService: ReviewHistoryService) {}

  async call(args: Record<string, unknown>): Promise<PreviousReview | null> {
    const offsetDays = this.parseOffsetDays(args.offsetDays);
    return this.reviewHistoryService.readPrevious(offsetDays);
  }

  private parseOffsetDays(raw: unknown): number {
    if (raw === undefined || raw === null) {
      throw new ToolArgError('missing required arg: offsetDays (number, >=1)');
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      throw new ToolArgError('invalid arg: offsetDays must be a finite number');
    }
    // ReviewHistoryService.readPrevious 内部已对 <1 做了 max(1) 兜底，这里允许 LLM 传 0/负数
    return Math.floor(n);
  }
}
