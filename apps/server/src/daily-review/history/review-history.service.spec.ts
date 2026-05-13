import { ReviewHistoryService } from './review-history.service';
import type { Repository } from 'typeorm';
import type { DailyReviewEntity } from '../../entities/daily-review/daily-review.entity';

/**
 * 构造一个可控的 createQueryBuilder mock，捕获 skip/take 调用值供断言。
 */
function createRepoMock(row: Partial<DailyReviewEntity> | null) {
  const calls: { skip?: number; take?: number; where?: any; orderBy?: [string, string] } = {};
  const qb: any = {
    where: jest.fn((_sql: string, params: any) => {
      calls.where = params;
      return qb;
    }),
    orderBy: jest.fn((col: string, dir: any) => {
      calls.orderBy = [col, dir];
      return qb;
    }),
    skip: jest.fn((n: number) => {
      calls.skip = n;
      return qb;
    }),
    take: jest.fn((n: number) => {
      calls.take = n;
      return qb;
    }),
    getOne: jest.fn().mockResolvedValue(row),
  };
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as Repository<DailyReviewEntity>;
  return { repo, qb, calls };
}

describe('ReviewHistoryService', () => {
  describe('readPrevious', () => {
    it('正常找到：articleMd 含锚点，提取「对下一交易日的核心判断」小节', async () => {
      const articleMd = [
        '## 0、开篇声明',
        '本报告仅供参考。',
        '',
        '## 一、先给结论',
        '今日大盘震荡上行。',
        '',
        '### 对下一交易日的核心判断',
        '维持谨慎乐观，关注半导体板块的延续性表现。',
        '若指数站稳 3400，可适度加仓。',
        '',
        '### 风险提示',
        '海外不确定性仍在。',
        '',
        '## 二、大盘全景数据',
        '指数：上证 3400。',
      ].join('\n');

      const { repo, calls } = createRepoMock({
        tradeDate: '20260512',
        articleMd,
        status: 'completed',
      } as Partial<DailyReviewEntity>);
      const svc = new ReviewHistoryService(repo);

      const r = await svc.readPrevious(1);
      expect(r).not.toBeNull();
      expect(r!.tradeDate).toBe('20260512');
      expect(r!.nextDayJudgment).toContain('维持谨慎乐观');
      expect(r!.nextDayJudgment).toContain('半导体');
      // 不应包含「风险提示」小节正文
      expect(r!.nextDayJudgment).not.toContain('海外不确定性');
      // evidencePack 列尚未 migrate，应为 null
      expect(r!.evidencePack).toBeNull();
      // skip=0, take=1
      expect(calls.skip).toBe(0);
      expect(calls.take).toBe(1);
      expect(calls.orderBy?.[0]).toBe('r.tradeDate');
      expect(calls.orderBy?.[1]).toBe('DESC');
      expect(calls.where).toEqual({ status: 'completed' });
    });

    it('articleMd 缺锚点：fallback 取「## 一、」与「## 二、」之间整段并截前 800 字', async () => {
      // 段一内填充 1200 字符的中文 + 1 个标点，确保超出 800 字阈值
      const longBody = '近期市场波动加剧。'.repeat(200); // 远超 800
      const articleMd = [
        '## 一、先给结论',
        longBody,
        '## 二、大盘全景数据',
        '指数数据略。',
      ].join('\n');

      const { repo } = createRepoMock({
        tradeDate: '20260509',
        articleMd,
        status: 'completed',
      } as Partial<DailyReviewEntity>);
      const svc = new ReviewHistoryService(repo);

      const r = await svc.readPrevious(1);
      expect(r).not.toBeNull();
      expect(r!.nextDayJudgment.length).toBe(800);
      // fallback 段内必然包含「## 一、」起始
      expect(r!.nextDayJudgment.startsWith('## 一、')).toBe(true);
    });

    it('找不到记录：返回 null，不抛异常', async () => {
      const { repo } = createRepoMock(null);
      const svc = new ReviewHistoryService(repo);
      await expect(svc.readPrevious(1)).resolves.toBeNull();
    });

    it('offsetDays=3 时 OFFSET 计算为 2（skip=2, take=1）', async () => {
      const { repo, calls } = createRepoMock({
        tradeDate: '20260507',
        articleMd: '',
        status: 'completed',
      } as Partial<DailyReviewEntity>);
      const svc = new ReviewHistoryService(repo);

      const r = await svc.readPrevious(3);
      expect(r).not.toBeNull();
      expect(calls.skip).toBe(2);
      expect(calls.take).toBe(1);
    });

    it('evidencePack 列存在时正确透传', async () => {
      const ep = { hypotheses: [{ claim: 'x' }] };
      const row: any = {
        tradeDate: '20260512',
        articleMd: '## 一、A\n内容\n## 二、B',
        status: 'completed',
        evidencePack: ep,
      };
      const { repo } = createRepoMock(row);
      const svc = new ReviewHistoryService(repo);
      const r = await svc.readPrevious(1);
      expect(r!.evidencePack).toBe(ep);
    });
  });

  describe('previousSummary', () => {
    it('回传 tradeDate + 前 300 字摘要', async () => {
      const judgment = '维持乐观判断。'.repeat(200); // 超过 300 字
      const articleMd = [
        '## 一、先给结论',
        '今日总体平稳。',
        '### 对下一交易日的核心判断',
        judgment,
        '## 二、大盘全景数据',
        '略。',
      ].join('\n');
      const { repo } = createRepoMock({
        tradeDate: '20260512',
        articleMd,
        status: 'completed',
      } as Partial<DailyReviewEntity>);
      const svc = new ReviewHistoryService(repo);

      const r = await svc.previousSummary(1);
      expect(r).not.toBeNull();
      expect(r!.tradeDate).toBe('20260512');
      expect(r!.nextDayJudgmentExcerpt.length).toBe(300);
    });

    it('readPrevious 返回 null 时透传 null', async () => {
      const { repo } = createRepoMock(null);
      const svc = new ReviewHistoryService(repo);
      await expect(svc.previousSummary(1)).resolves.toBeNull();
    });
  });
});
