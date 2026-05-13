import { ReadPreviousReviewHandler } from './read-previous-review.handler';
import { ToolArgError } from '../tool-types';
import type { ReviewHistoryService } from '../../history/review-history.service';

function buildHistory(result: any): ReviewHistoryService {
  return { readPrevious: jest.fn().mockResolvedValue(result) } as unknown as ReviewHistoryService;
}

describe('ReadPreviousReviewHandler', () => {
  it('1) 正常路径：转发到 ReviewHistoryService.readPrevious 并回传结果', async () => {
    const fixture = {
      tradeDate: '20260513',
      nextDayJudgment: '维持谨慎乐观，关注半导体延续性',
      evidencePack: null,
    };
    const history = buildHistory(fixture);
    const handler = new ReadPreviousReviewHandler(history);

    const out = await handler.call({ offsetDays: 1 });
    expect(history.readPrevious).toHaveBeenCalledWith(1);
    expect(out).toEqual(fixture);
  });

  it('2) 降级路径：找不到历史复盘 → 转发返回 null', async () => {
    const history = buildHistory(null);
    const handler = new ReadPreviousReviewHandler(history);
    const out = await handler.call({ offsetDays: 5 });
    expect(history.readPrevious).toHaveBeenCalledWith(5);
    expect(out).toBeNull();
  });

  it('3) 入参 offsetDays 缺失/非数字 → 抛 ToolArgError', async () => {
    const handler = new ReadPreviousReviewHandler(buildHistory(null));
    await expect(handler.call({})).rejects.toBeInstanceOf(ToolArgError);
    await expect(handler.call({ offsetDays: 'abc' })).rejects.toBeInstanceOf(ToolArgError);
  });
});
