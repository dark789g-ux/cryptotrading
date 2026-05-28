import { BadRequestException } from '@nestjs/common';
import { QuantPublicScoresController } from './quant-public-scores.controller';

describe('QuantPublicScoresController（POST /quant/scores/by-tscodes，普通用户可访问）', () => {
  let svc: { getScoresByTsCodes: jest.Mock };
  let controller: QuantPublicScoresController;

  beforeEach(() => {
    svc = {
      getScoresByTsCodes: jest.fn(async () => ({
        trade_date: '20260528',
        model_version: 'prod-v1',
        items: [],
      })),
    };
    controller = new QuantPublicScoresController(svc as any);
  });

  it('happy path：合法 body → svc.getScoresByTsCodes 收到 {tradeDate, tsCodes}', async () => {
    await controller.byTsCodes({
      trade_date: '20260528',
      ts_codes: ['000001.SZ', '600519.SH'],
    });
    expect(svc.getScoresByTsCodes).toHaveBeenCalledWith({
      tradeDate: '20260528',
      tsCodes: ['000001.SZ', '600519.SH'],
    });
  });

  it('去重：重复 ts_code 被收敛', async () => {
    await controller.byTsCodes({
      trade_date: '20260528',
      ts_codes: ['000001.SZ', '000001.SZ', '600519.SH'],
    });
    expect(svc.getScoresByTsCodes).toHaveBeenCalledWith({
      tradeDate: '20260528',
      tsCodes: ['000001.SZ', '600519.SH'],
    });
  });

  it('空数组合法：正常转发，tsCodes=[]', async () => {
    await controller.byTsCodes({ trade_date: '20260528', ts_codes: [] });
    expect(svc.getScoresByTsCodes).toHaveBeenCalledWith({
      tradeDate: '20260528',
      tsCodes: [],
    });
  });

  it('trade_date 非 8 位 → 400', async () => {
    await expect(
      controller.byTsCodes({ trade_date: '2026', ts_codes: ['000001.SZ'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ts_codes 非数组 → 400', async () => {
    await expect(
      controller.byTsCodes({ trade_date: '20260528', ts_codes: '000001.SZ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ts_codes 超 500 → 400', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `${String(i).padStart(6, '0')}.SZ`);
    await expect(
      controller.byTsCodes({ trade_date: '20260528', ts_codes: tooMany }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('含非法 ts_code（注入串）→ 400', async () => {
    await expect(
      controller.byTsCodes({ trade_date: '20260528', ts_codes: ['1;DROP TABLE'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
