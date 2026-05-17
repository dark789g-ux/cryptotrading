import { BadRequestException } from '@nestjs/common';
import { QuantScoresController } from './quant-scores.controller';

describe('QuantScoresController', () => {
  let svc: {
    getDailyTopK: jest.Mock;
    getTimeSeries: jest.Mock;
    getModelVersions: jest.Mock;
    compareModels: jest.Mock;
    listScores: jest.Mock;
  };
  let controller: QuantScoresController;

  beforeEach(() => {
    svc = {
      getDailyTopK: jest.fn(async () => []),
      getTimeSeries: jest.fn(async () => []),
      getModelVersions: jest.fn(async () => [
        { model_version: 'v1', created_at: '2026-05-10 00:00:00Z' },
      ]),
      compareModels: jest.fn(async () => []),
      listScores: jest.fn(async () => ({
        items: [],
        total: 0,
        trade_date: '20260517',
        model_version: 'v1',
      })),
    };
    controller = new QuantScoresController(svc as any);
  });

  describe('GET /quant/scores（顶层列表 spec M3 §5）', () => {
    it('happy path：trade_date+model_version+top_k+page+page_size+sort → svc.listScores 收到 ValidatedScoresListQuery', async () => {
      await controller.list({
        trade_date: '20260517',
        model_version: 'v1',
        top_k: '200',
        page: '2',
        page_size: '50',
        sort: 'rank_in_day,asc',
      });
      expect(svc.listScores).toHaveBeenCalledWith({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 200,
        page: 2,
        pageSize: 50,
        sortField: 'rank_in_day',
        sortDir: 'ASC',
      });
    });

    it('全空可选参数：sort 默认 rank_in_day ASC；top_k=50；page=1；page_size=50', async () => {
      await controller.list({ trade_date: '20260517', model_version: 'v1' });
      expect(svc.listScores).toHaveBeenCalledWith({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 50,
        page: 1,
        pageSize: 50,
        sortField: 'rank_in_day',
        sortDir: 'ASC',
      });
    });

    it('top_k 超 1000 → 400（spec M3：5500 标的 × 4 年规模 P95 上限）', async () => {
      await expect(
        controller.list({ trade_date: '20260517', model_version: 'v1', top_k: '5000' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sort.field 不在白名单 → 400（防 SQL 注入面）', async () => {
      await expect(
        controller.list({
          trade_date: '20260517',
          model_version: 'v1',
          sort: 'drop_table,asc',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('GET /quant/scores/daily', () => {
    it('happy path：合法 query → svc.getDailyTopK 收到 validated dto；响应回填 trade_date/model_version/top_k', async () => {
      svc.getDailyTopK.mockResolvedValueOnce([
        { trade_date: '20260517', ts_code: '000001.SZ', model_version: 'v1', score: 1.2, rank_in_day: 1 },
      ]);
      const out = await controller.getDaily({
        trade_date: '20260517',
        model_version: 'v1',
        top_k: '50',
      });
      expect(svc.getDailyTopK).toHaveBeenCalledWith({
        tradeDate: '20260517',
        modelVersion: 'v1',
        topK: 50,
      });
      expect(out).toEqual({
        trade_date: '20260517',
        model_version: 'v1',
        top_k: 50,
        items: [
          { trade_date: '20260517', ts_code: '000001.SZ', model_version: 'v1', score: 1.2, rank_in_day: 1 },
        ],
      });
    });

    it('trade_date 非 8 位 → 400', async () => {
      await expect(
        controller.getDaily({ trade_date: '2026', model_version: 'v1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('top_k 超 500 → 400', async () => {
      await expect(
        controller.getDaily({ trade_date: '20260517', model_version: 'v1', top_k: '600' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('GET /quant/scores/ts/:ts_code', () => {
    it('happy path：合法 ts_code + 日期区间 → svc.getTimeSeries 被调用', async () => {
      await controller.getTimeSeries('000001.SZ', {
        model_version: 'v1',
        start: '20260510',
        end: '20260511',
      });
      expect(svc.getTimeSeries).toHaveBeenCalledWith({
        tsCode: '000001.SZ',
        modelVersion: 'v1',
        start: '20260510',
        end: '20260511',
      });
    });
    it('start > end → 400', async () => {
      await expect(
        controller.getTimeSeries('000001.SZ', {
          model_version: 'v1',
          start: '20260520',
          end: '20260510',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('GET /quant/scores/model-versions', () => {
    it('转发到 svc.getModelVersions', async () => {
      const out = await controller.listModelVersions();
      expect(svc.getModelVersions).toHaveBeenCalled();
      expect(out).toEqual({
        items: [{ model_version: 'v1', created_at: '2026-05-10 00:00:00Z' }],
      });
    });
  });

  describe('GET /quant/scores/compare', () => {
    it('happy path：逗号分隔解析为数组并去重 → svc.compareModels', async () => {
      await controller.compare({
        trade_date: '20260517',
        model_versions: 'v1,v2,v1',
        top_k: '20',
      });
      expect(svc.compareModels).toHaveBeenCalledWith({
        tradeDate: '20260517',
        modelVersions: ['v1', 'v2'],
        topK: 20,
      });
    });

    it('model_versions 为空 → 400', async () => {
      await expect(
        controller.compare({ trade_date: '20260517', model_versions: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('model_versions 含非法字符（空格）→ 400', async () => {
      await expect(
        controller.compare({ trade_date: '20260517', model_versions: 'v1,bad version' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
