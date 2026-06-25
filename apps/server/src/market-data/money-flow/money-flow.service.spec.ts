import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoneyFlowService } from './money-flow.service';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { MoneyFlowThsIndustryEntity } from '../../entities/money-flow/money-flow-ths-industry.entity';
import { MoneyFlowIndexEntity } from '../../entities/money-flow/money-flow-index.entity';

/**
 * 测试 MoneyFlowService.queryMembers 的三种场景：
 * - 传 trade_date：返回 pctChange/netAmount，且 netAmount 已 ÷10000（万→亿）
 * - 传 trade_date 但成分股在 money_flow_stocks 当日无记录 → 两字段 null（LEFT JOIN 自然行为）
 * - 不传 trade_date → 两字段均 null，且不应触发 leftJoin
 */
describe('MoneyFlowService.queryMembers', () => {
  let service: MoneyFlowService;
  let memberQb: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    leftJoin: jest.Mock;
    orderBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  let memberRepo: { createQueryBuilder: jest.Mock };

  const otherRepo = () => ({ createQueryBuilder: jest.fn() });

  beforeEach(async () => {
    memberQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    memberRepo = { createQueryBuilder: jest.fn().mockReturnValue(memberQb) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoneyFlowService,
        { provide: getRepositoryToken(MoneyFlowStockEntity), useValue: otherRepo() },
        { provide: getRepositoryToken(MoneyFlowIndustryEntity), useValue: otherRepo() },
        { provide: getRepositoryToken(MoneyFlowSectorEntity), useValue: otherRepo() },
        { provide: getRepositoryToken(MoneyFlowMarketEntity), useValue: otherRepo() },
        { provide: getRepositoryToken(MoneyFlowThsIndustryEntity), useValue: otherRepo() },
        { provide: getRepositoryToken(MoneyFlowIndexEntity), useValue: otherRepo() },
        { provide: getRepositoryToken(ThsMemberStockEntity), useValue: memberRepo },
      ],
    }).compile();

    service = module.get(MoneyFlowService);
  });

  it('传 trade_date：返回行含 pctChange，netAmount 已 ÷10000（亿元）', async () => {
    memberQb.getRawMany.mockResolvedValue([
      {
        tsCode: '881101.TI',
        conCode: '000001.SZ',
        conName: '平安银行',
        isNew: 'N',
        pctChange: '2.3456',
        netAmount: '12345.6789', // 万元
      },
    ]);

    const rows = await service.queryMembers('881101.TI', '20260512');

    // 触发 LEFT JOIN
    expect(memberQb.leftJoin).toHaveBeenCalledWith(
      'money_flow_stocks',
      'mfs',
      'mfs.ts_code = m.con_code AND mfs.trade_date = :tradeDate',
      { tradeDate: '20260512' },
    );
    expect(memberQb.orderBy).toHaveBeenCalledWith('m.con_code', 'ASC');

    expect(rows).toHaveLength(1);
    expect(rows[0].pctChange).toBeCloseTo(2.3456, 6);
    // 12345.6789 / 10000 = 1.23456789
    expect(rows[0].netAmount).toBeCloseTo(1.23456789, 8);
    expect(rows[0].conCode).toBe('000001.SZ');
  });

  it('传 trade_date 但成分股当日无 money_flow_stocks 记录 → pctChange/netAmount 均 null', async () => {
    // LEFT JOIN 未命中时 raw 字段为 null
    memberQb.getRawMany.mockResolvedValue([
      {
        tsCode: '881101.TI',
        conCode: '000002.SZ',
        conName: '万科 A',
        isNew: 'N',
        pctChange: null,
        netAmount: null,
      },
    ]);

    const rows = await service.queryMembers('881101.TI', '20260512');

    expect(memberQb.leftJoin).toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0].pctChange).toBeNull();
    expect(rows[0].netAmount).toBeNull();
  });

  it('不传 trade_date：不触发 leftJoin，pctChange/netAmount 均 null', async () => {
    memberQb.getRawMany.mockResolvedValue([
      {
        tsCode: '881101.TI',
        conCode: '000001.SZ',
        conName: '平安银行',
        isNew: 'N',
      },
    ]);

    const rows = await service.queryMembers('881101.TI');

    expect(memberQb.leftJoin).not.toHaveBeenCalled();
    expect(memberQb.orderBy).toHaveBeenCalledWith('m.con_code', 'ASC');
    expect(rows).toHaveLength(1);
    expect(rows[0].pctChange).toBeNull();
    expect(rows[0].netAmount).toBeNull();
    expect(rows[0].conCode).toBe('000001.SZ');
  });
});
