import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexCatalogQueryService } from './index-catalog-query.service';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { MARKET_INDEX_LIST } from './market-index-list';

function makeCatalogRow(partial: Partial<ThsIndexCatalogEntity>): ThsIndexCatalogEntity {
  return {
    tsCode: '000001.SH',
    name: 'x',
    count: null,
    exchange: 'A',
    listDate: null,
    type: 'I',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as ThsIndexCatalogEntity;
}

function makeQbMock(rows: ThsIndexCatalogEntity[]) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

describe('IndexCatalogQueryService', () => {
  let service: IndexCatalogQueryService;
  let catalogRepo: jest.Mocked<Repository<ThsIndexCatalogEntity>>;

  beforeEach(async () => {
    catalogRepo = {
      createQueryBuilder: jest.fn(),
    } as unknown as jest.Mocked<Repository<ThsIndexCatalogEntity>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexCatalogQueryService,
        { provide: getRepositoryToken(ThsIndexCatalogEntity), useValue: catalogRepo },
      ],
    }).compile();

    service = module.get(IndexCatalogQueryService);
  });

  describe('findAll', () => {
    it('category=market 只返回 MARKET_INDEX_LIST 常量，不查 DB', async () => {
      const rows = await service.findAll('market');

      expect(rows).toHaveLength(MARKET_INDEX_LIST.length);
      expect(catalogRepo.createQueryBuilder).not.toHaveBeenCalled();
      for (const r of rows) {
        expect(r.category).toBe('market');
        expect(r.count).toBeUndefined();
      }
      const codes = rows.map((r) => r.tsCode);
      expect(codes).toContain('000001.SH');
      expect(codes).toContain('000852.SH');
    });

    it('category=industry 查 ths_index_catalog WHERE type IN (I)', async () => {
      const industryRows = [
        makeCatalogRow({ tsCode: '881101.TI', name: '采掘', type: 'I', count: 50 }),
      ];
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock(industryRows)) as never;

      const rows = await service.findAll('industry');

      expect(catalogRepo.createQueryBuilder).toHaveBeenCalledWith('c');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tsCode: '881101.TI', name: '采掘', category: 'industry', count: 50 });
    });

    it('category=concept 查 ths_index_catalog WHERE type IN (N)', async () => {
      const conceptRows = [
        makeCatalogRow({ tsCode: '885001.TI', name: '网络安全', type: 'N', count: 30 }),
      ];
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock(conceptRows)) as never;

      const rows = await service.findAll('concept');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tsCode: '885001.TI', name: '网络安全', category: 'concept', count: 30 });
    });

    it('category 缺省：三类合并（market 常量 + DB 行业/概念）', async () => {
      const dbRows = [
        makeCatalogRow({ tsCode: '881101.TI', name: '采掘', type: 'I' }),
        makeCatalogRow({ tsCode: '885001.TI', name: '网络安全', type: 'N' }),
      ];
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock(dbRows)) as never;

      const rows = await service.findAll();

      const categories = rows.map((r) => r.category).sort();
      expect(categories).toEqual(['concept', 'industry', ...Array(MARKET_INDEX_LIST.length).fill('market')]);
      expect(rows).toHaveLength(MARKET_INDEX_LIST.length + 2);
    });

    it('缺省 category 时 DB 查询用 type IN (I,N) 一次拉取', async () => {
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock([])) as never;

      await service.findAll();

      const qb = (catalogRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('c.type IN (:...types)', { types: ['I', 'N'] });
    });

    it('q 模糊搜索：market 常量按 name 过滤', async () => {
      const rows = await service.findAll('market', '沪深');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tsCode: '000300.SH', name: '沪深300' });
    });

    it('q 模糊搜索大小写不敏感（market 常量）', async () => {
      const rowsUpper = await service.findAll('market', '沪深');
      const rowsLower = await service.findAll('market', '沪深');
      expect(rowsUpper).toEqual(rowsLower);
    });

    it('q 模糊搜索：DB 走 ILIKE 并叠加', async () => {
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock([])) as never;

      await service.findAll('industry', '安全');

      const qb = (catalogRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
      expect(qb.andWhere).toHaveBeenCalledWith('c.name ILIKE :q', { q: '%安全%' });
    });

    it('q 仅空白时不触发 ILIKE', async () => {
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock([])) as never;

      await service.findAll('industry', '   ');

      const qb = (catalogRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('q 对 market 常量不匹配时返回空数组', async () => {
      const rows = await service.findAll('market', '不存在的指数名');
      expect(rows).toEqual([]);
    });

    it('type=M 的 entity 行（如未来 DB 灌入大盘）也按 industry 查询不会被返回', async () => {
      // category=industry 时 types=['I']，即使 DB 有 type='M' 行也不查到
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock([])) as never;

      await service.findAll('industry');

      const qb = (catalogRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('c.type IN (:...types)', { types: ['I'] });
    });
  });
});
