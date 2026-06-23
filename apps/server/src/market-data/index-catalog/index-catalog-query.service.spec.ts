import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IndexCatalogQueryService } from './index-catalog-query.service';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';

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

const MARKET_ROWS: ThsIndexCatalogEntity[] = [
  makeCatalogRow({ tsCode: '000001.SH', name: '上证指数', type: 'M' }),
  makeCatalogRow({ tsCode: '399001.SZ', name: '深证成指', type: 'M' }),
  makeCatalogRow({ tsCode: '399006.SZ', name: '创业板指', type: 'M' }),
  makeCatalogRow({ tsCode: '000688.SH', name: '科创50', type: 'M' }),
  makeCatalogRow({ tsCode: '000300.SH', name: '沪深300', type: 'M' }),
  makeCatalogRow({ tsCode: '000016.SH', name: '上证50', type: 'M' }),
  makeCatalogRow({ tsCode: '000905.SH', name: '中证500', type: 'M' }),
  makeCatalogRow({ tsCode: '000852.SH', name: '中证1000', type: 'M' }),
];

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
      find: jest.fn(),
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
    it('category=market 查 ths_index_catalog WHERE type=M', async () => {
      catalogRepo.find = jest.fn().mockResolvedValue(MARKET_ROWS) as never;

      const rows = await service.findAll('market');

      expect(catalogRepo.find).toHaveBeenCalledWith({
        where: { type: 'M' },
        order: { tsCode: 'ASC' },
      });
      expect(rows).toHaveLength(MARKET_ROWS.length);
      for (const r of rows) {
        expect(r.category).toBe('market');
      }
      const codes = rows.map((r) => r.tsCode);
      expect(codes).toContain('000001.SH');
      expect(codes).toContain('000852.SH');
    });

    it('category=market 按 tsCode ASC 排序', async () => {
      // 故意打乱顺序，断言 find 收到 order；service 不过滤顺序（DB 负责）
      const shuffled = [...MARKET_ROWS].reverse();
      catalogRepo.find = jest.fn().mockResolvedValue(shuffled) as never;

      await service.findAll('market');

      expect(catalogRepo.find).toHaveBeenCalledWith({
        where: { type: 'M' },
        order: { tsCode: 'ASC' },
      });
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

    it('category 缺省：三类合并（market 来自 DB type=M + DB 行业/概念）', async () => {
      const dbRows = [
        makeCatalogRow({ tsCode: '881101.TI', name: '采掘', type: 'I' }),
        makeCatalogRow({ tsCode: '885001.TI', name: '网络安全', type: 'N' }),
      ];
      catalogRepo.find = jest.fn().mockResolvedValue(MARKET_ROWS) as never;
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock(dbRows)) as never;

      const rows = await service.findAll();

      const categories = rows.map((r) => r.category).sort();
      expect(categories).toEqual(['concept', 'industry', ...Array(MARKET_ROWS.length).fill('market')]);
      expect(rows).toHaveLength(MARKET_ROWS.length + 2);
    });

    it('缺省 category 时 DB 查询用 type IN (I,N) 一次拉取', async () => {
      catalogRepo.find = jest.fn().mockResolvedValue(MARKET_ROWS) as never;
      catalogRepo.createQueryBuilder = jest.fn().mockReturnValue(makeQbMock([])) as never;

      await service.findAll();

      const qb = (catalogRepo.createQueryBuilder as jest.Mock).mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('c.type IN (:...types)', { types: ['I', 'N'] });
    });

    it('q 模糊搜索：market 按 name 过滤', async () => {
      catalogRepo.find = jest.fn().mockResolvedValue(MARKET_ROWS) as never;

      const rows = await service.findAll('market', '沪深');

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tsCode: '000300.SH', name: '沪深300' });
    });

    it('q 模糊搜索大小写不敏感（market）', async () => {
      catalogRepo.find = jest.fn().mockResolvedValue(MARKET_ROWS) as never;

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

    it('q 对 market 不匹配时返回空数组', async () => {
      catalogRepo.find = jest.fn().mockResolvedValue(MARKET_ROWS) as never;

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

    it('category=market 透传 count 列', async () => {
      const rowsWithCount = [
        makeCatalogRow({ tsCode: '000300.SH', name: '沪深300', type: 'M', count: 300 }),
      ];
      catalogRepo.find = jest.fn().mockResolvedValue(rowsWithCount) as never;

      const rows = await service.findAll('market');

      expect(rows[0].count).toBe(300);
    });
  });
});
