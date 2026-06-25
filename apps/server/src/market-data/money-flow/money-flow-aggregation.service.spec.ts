import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoneyFlowAggregationService } from './money-flow-aggregation.service';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowThsIndustryEntity } from '../../entities/money-flow/money-flow-ths-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowIndexEntity } from '../../entities/money-flow/money-flow-index.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { IndexWeightEntity } from '../../entities/index-catalog/index-weight.entity';

describe('MoneyFlowAggregationService', () => {
  let service: MoneyFlowAggregationService;
  const mockRepo = () => ({
    query: jest.fn().mockResolvedValue([{ rowCount: 3 }]),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoneyFlowAggregationService,
        { provide: getRepositoryToken(MoneyFlowStockEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowIndustryEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowThsIndustryEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowSectorEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowIndexEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowMarketEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(IndexWeightEntity), useValue: mockRepo() },
      ],
    }).compile();

    service = module.get(MoneyFlowAggregationService);
  });

  it('aggregateAll 并行执行 5 个维度', async () => {
    const results = await service.aggregateAll('20240601', '20240630');
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('申万行业聚合 SQL 包含 sw_industry_l3_code 汇总', async () => {
    const industryRepo = (service as any).industryRepo as { query: jest.Mock };
    await service.aggregateSwIndustry('20240601', '20240630');
    const sql = industryRepo.query.mock.calls[0][0] as string;
    expect(sql).toContain('money_flow_industries');
    expect(sql).toContain('sw_industry_l3_code');
    expect(sql).toContain('SUM(m.net_amount)');
  });

  it('同花顺行业聚合 SQL 过滤 type=I', async () => {
    const thsRepo = (service as any).thsIndustryRepo as { query: jest.Mock };
    await service.aggregateThsIndustry('20240601', '20240630');
    const sql = thsRepo.query.mock.calls[0][0] as string;
    expect(sql).toContain("c.type = 'I'");
    expect(sql).toContain('money_flow_ths_industries');
  });

  it('同花顺概念聚合 SQL 过滤 type=N', async () => {
    const sectorRepo = (service as any).sectorRepo as { query: jest.Mock };
    await service.aggregateThsSector('20240601', '20240630');
    const sql = sectorRepo.query.mock.calls[0][0] as string;
    expect(sql).toContain("c.type = 'N'");
    expect(sql).toContain('money_flow_sectors');
  });

  it('宽基指数聚合 SQL 使用 index_weight PIT 版本链', async () => {
    const indexRepo = (service as any).indexRepo as { query: jest.Mock };
    await service.aggregateIndex('20240601', '20240630');
    const sql = indexRepo.query.mock.calls[0][0] as string;
    expect(sql).toContain('index_weight');
    expect(sql).toContain('effective_date');
    expect(sql).toContain('expire_date');
  });

  it('大盘聚合 SQL 汇总全部个股', async () => {
    const marketRepo = (service as any).marketRepo as { query: jest.Mock };
    await service.aggregateMarket('20240601', '20240630');
    const sql = marketRepo.query.mock.calls[0][0] as string;
    expect(sql).toContain('money_flow_market');
    expect(sql).toContain('SUM(net_amount)');
  });
});
