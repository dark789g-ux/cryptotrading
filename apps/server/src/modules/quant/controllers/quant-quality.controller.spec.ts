import { BadRequestException } from '@nestjs/common';
import { QuantQualityController } from './quant-quality.controller';

describe('QuantQualityController', () => {
  let svc: {
    getByDate: jest.Mock;
    getRecent: jest.Mock;
  };
  let controller: QuantQualityController;

  beforeEach(() => {
    svc = {
      getByDate: jest.fn(async () => []),
      getRecent: jest.fn(async () => []),
    };
    controller = new QuantQualityController(svc as any);
  });

  describe('GET /quant/quality/:date', () => {
    it('happy path：合法 date → svc.getByDate（不传 level → levels=undefined）', async () => {
      svc.getByDate.mockResolvedValueOnce([
        {
          id: '1',
          trade_date: '20260517',
          level: 'warn',
          rule: 'row_count_drift',
          detail: { delta_ratio: 0.08 },
          created_at: '2026-05-17 00:00:00Z',
        },
      ]);
      const out = await controller.getByDate('20260517', {});
      expect(svc.getByDate).toHaveBeenCalledWith('20260517', undefined);
      expect(out).toEqual({
        trade_date: '20260517',
        levels: null,
        items: [
          {
            id: '1',
            trade_date: '20260517',
            level: 'warn',
            rule: 'row_count_drift',
            detail: { delta_ratio: 0.08 },
            created_at: '2026-05-17 00:00:00Z',
          },
        ],
      });
    });

    it('支持 ?level=warn,critical → service 收到 levels 数组（spec M3 §5）', async () => {
      svc.getByDate.mockResolvedValueOnce([]);
      const out = await controller.getByDate('20260517', { level: 'warn,critical' });
      expect(svc.getByDate).toHaveBeenCalledWith('20260517', ['warn', 'critical']);
      expect(out.levels).toEqual(['warn', 'critical']);
    });

    it('date 非 8 位 → 400', async () => {
      await expect(controller.getByDate('2026', {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('level 非法 → 400', async () => {
      await expect(
        controller.getByDate('20260517', { level: 'oops' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('GET /quant/quality/recent', () => {
    it('happy path：合法 query → svc.getRecent', async () => {
      await controller.getRecent({ days: '14', level: 'warn,critical' });
      expect(svc.getRecent).toHaveBeenCalledWith({
        days: 14,
        levels: ['warn', 'critical'],
      });
    });

    it('days 超 90 → 400', async () => {
      await expect(controller.getRecent({ days: '999' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('level 非法 token → 400', async () => {
      await expect(controller.getRecent({ level: 'oops' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('全空 query：默认 days=7，无 levels 过滤', async () => {
      await controller.getRecent({});
      expect(svc.getRecent).toHaveBeenCalledWith({ days: 7 });
    });
  });
});
