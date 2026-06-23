import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { MarketIndexScopeService } from './market-index-scope.service';

function makeRepoMock(): jest.Mocked<Repository<ThsIndexCatalogEntity>> {
  return {
    find: jest.fn(),
    create: jest.fn().mockImplementation((x: Partial<ThsIndexCatalogEntity>) => x as ThsIndexCatalogEntity),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as jest.Mocked<Repository<ThsIndexCatalogEntity>>;
}

describe('MarketIndexScopeService', () => {
  let service: MarketIndexScopeService;
  let repo: jest.Mocked<Repository<ThsIndexCatalogEntity>>;
  let tushare: { query: jest.Mock };

  beforeEach(async () => {
    repo = makeRepoMock();
    tushare = { query: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketIndexScopeService,
        { provide: getRepositoryToken(ThsIndexCatalogEntity), useValue: repo },
        { provide: TushareClientService, useValue: tushare },
      ],
    }).compile();
    service = module.get(MarketIndexScopeService);
  });

  describe('getScope', () => {
    it('查 catalog type=M 并按 ts_code 升序返回 {ts_code,name}', async () => {
      repo.find.mockResolvedValue([
        { tsCode: '000300.SH', name: '沪深300' } as ThsIndexCatalogEntity,
        { tsCode: '000001.SH', name: '上证指数' } as ThsIndexCatalogEntity,
      ]);

      const result = await service.getScope();

      expect(repo.find).toHaveBeenCalledWith({ where: { type: 'M' }, order: { tsCode: 'ASC' } });
      expect(result).toEqual([
        { ts_code: '000300.SH', name: '沪深300' },
        { ts_code: '000001.SH', name: '上证指数' },
      ]);
    });

    it('空范围返回空数组', async () => {
      repo.find.mockResolvedValue([]);
      const result = await service.getScope();
      expect(result).toEqual([]);
    });
  });

  describe('addToScope', () => {
    it('创建 type=M 实体并 batchUpsert（exchange 取 ts_code 后缀）', async () => {
      await service.addToScope('000300.SH', '沪深300');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        tsCode: '000300.SH',
        name: '沪深300',
        exchange: 'SH',
        type: 'M',
        count: null,
        listDate: null,
      }));
      expect(repo.upsert).toHaveBeenCalledWith([expect.objectContaining({ tsCode: '000300.SH' })], ['tsCode']);
    });

    it('trim 入参', async () => {
      await service.addToScope('  000300.SH  ', '  沪深300  ');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        tsCode: '000300.SH',
        name: '沪深300',
      }));
    });

    it('tsCode 为空抛错', async () => {
      await expect(service.addToScope('', '名')).rejects.toThrow(/tsCode/);
      await expect(service.addToScope('000300.SH', '')).rejects.toThrow(/tsCode/);
    });

    it('无后缀的 ts_code 仍可入库（exchange 空串）', async () => {
      await service.addToScope('000300', '沪深300');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
        tsCode: '000300',
        exchange: '',
      }));
    });
  });

  describe('removeFromScope', () => {
    it('delete 带 type=M 守卫', async () => {
      await service.removeFromScope('000300.SH');
      expect(repo.delete).toHaveBeenCalledWith({ tsCode: '000300.SH', type: 'M' });
    });

    it('tsCode 为空抛错', async () => {
      await expect(service.removeFromScope('')).rejects.toThrow(/tsCode/);
    });

    it('trim 入参', async () => {
      await service.removeFromScope('  000300.SH  ');
      expect(repo.delete).toHaveBeenCalledWith({ tsCode: '000300.SH', type: 'M' });
    });
  });

  describe('discoverCandidates', () => {
    it('对 SSE/SZSE/CSI 各调一次 index_basic，取 ts_code/name/exp_date/category', async () => {
      repo.find.mockResolvedValue([]);
      tushare.query.mockResolvedValue([]);

      await service.discoverCandidates();

      expect(tushare.query).toHaveBeenCalledTimes(3);
      for (const market of ['SSE', 'SZSE', 'CSI']) {
        expect(tushare.query).toHaveBeenCalledWith(
          'index_basic',
          { market },
          'ts_code,name,exp_date,category',
        );
      }
    });

    it('过滤基础宽基（6 位纯数字 + 规模/综合指数）并丢弃其他 category/前缀', async () => {
      repo.find.mockResolvedValue([]);
      tushare.query.mockImplementation(async (_api, params) => {
        const market = params.market;
        if (market === 'SSE') {
          return [
            { ts_code: '000001.SH', name: '上证指数', exp_date: null, category: '综合指数' },
            { ts_code: '000016.SH', name: '上证50', exp_date: null, category: '规模指数' },
            // 非宽基：主题指数
            { ts_code: '000002.SH', name: '上证主题', exp_date: null, category: '主题指数' },
            // 非纯数字前缀
            { ts_code: 'CI0001.SH', name: '中证定制', exp_date: null, category: '规模指数' },
          ];
        }
        return [];
      });

      const result = await service.discoverCandidates();

      expect(result.candidates.map((c) => c.ts_code).sort()).toEqual(['000001.SH', '000016.SH']);
    });

    it('标注 in_scope：范围内的 ts_code in_scope=true', async () => {
      repo.find.mockResolvedValue([
        { tsCode: '000300.SH', name: '沪深300' } as ThsIndexCatalogEntity,
      ]);
      tushare.query.mockResolvedValue([
        { ts_code: '000300.SH', name: '沪深300', exp_date: null, category: '规模指数' },
        { ts_code: '000016.SH', name: '上证50', exp_date: null, category: '规模指数' },
      ]);

      const result = await service.discoverCandidates();

      const hs300 = result.candidates.find((c) => c.ts_code === '000300.SH');
      const sz50 = result.candidates.find((c) => c.ts_code === '000016.SH');
      expect(hs300?.in_scope).toBe(true);
      expect(sz50?.in_scope).toBe(false);
    });

    it('exp_date 非空的候选 noise_tags 含 delisted', async () => {
      repo.find.mockResolvedValue([]);
      tushare.query.mockResolvedValue([
        { ts_code: '000999.SH', name: '已退市指数', exp_date: '20200101', category: '综合指数' },
      ]);

      const result = await service.discoverCandidates();

      expect(result.candidates[0].noise_tags).toContain('delisted');
      expect(result.candidates[0].exp_date).toBe('20200101');
    });

    it('同名多挂牌（沪深300 SH+SZ）duplicate 标在非 .SH', async () => {
      repo.find.mockResolvedValue([]);
      tushare.query.mockImplementation(async (_api, params) => {
        if (params.market === 'SSE') {
          return [{ ts_code: '000300.SH', name: '沪深300', exp_date: null, category: '规模指数' }];
        }
        if (params.market === 'SZSE') {
          return [{ ts_code: '399300.SZ', name: '沪深300', exp_date: null, category: '规模指数' }];
        }
        return [];
      });

      const result = await service.discoverCandidates();

      const sh = result.candidates.find((c) => c.ts_code === '000300.SH');
      const sz = result.candidates.find((c) => c.ts_code === '399300.SZ');
      expect(sh?.noise_tags).not.toContain('duplicate');
      expect(sz?.noise_tags).toContain('duplicate');
    });

    it('某 market 返回空数据：failedItems 含 index_basic_empty_<market>', async () => {
      repo.find.mockResolvedValue([]);
      tushare.query.mockImplementation(async (_api, params) => {
        if (params.market === 'SZSE') return [];
        if (params.market === 'SSE') {
          return [{ ts_code: '000001.SH', name: '上证指数', exp_date: null, category: '综合指数' }];
        }
        return [];
      });
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const result = await service.discoverCandidates();

      expect(result.failedItems).toContain('index_basic_empty_SZSE');
      expect(result.failedItems).toContain('index_basic_empty_CSI');
      // SSE 有数据不进 empty
      expect(result.failedItems).not.toContain('index_basic_empty_SSE');
      // 候选仍来自 SSE
      expect(result.candidates.map((c) => c.ts_code)).toEqual(['000001.SH']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('market=SZSE'));
    });

    it('某 market 调用抛错：failedItems 含 index_basic_error_<market> 且不中断其他 market', async () => {
      repo.find.mockResolvedValue([]);
      tushare.query.mockImplementation(async (_api, params) => {
        if (params.market === 'CSI') throw new Error('rate limit');
        if (params.market === 'SSE') {
          return [{ ts_code: '000001.SH', name: '上证指数', exp_date: null, category: '综合指数' }];
        }
        return [];
      });
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

      const result = await service.discoverCandidates();

      expect(result.failedItems).toContain('index_basic_error_CSI');
      expect(result.candidates.map((c) => c.ts_code)).toEqual(['000001.SH']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('market=CSI'));
    });

    it('同 ts_code 跨 market 重复：去重保留首次', async () => {
      repo.find.mockResolvedValue([]);
      tushare.query.mockImplementation(async () => [
        { ts_code: '000300.SH', name: '沪深300', exp_date: null, category: '规模指数' },
      ]);

      const result = await service.discoverCandidates();

      expect(result.candidates).toHaveLength(1);
    });
  });
});
