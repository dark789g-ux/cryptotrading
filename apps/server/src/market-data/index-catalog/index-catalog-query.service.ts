import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import type { IndexCatalogCategory } from './dto/query-catalog.dto';

/**
 * 统一指数目录查询返回行。
 *
 * 三类指数全部来自 ths_index_catalog（单一数据源）：
 * - `tsCode/name/count` 直接来自 entity（DB 列）
 * - `category` 是派生字段：ths_index_catalog.type (I/N/M) → category (industry/concept/market)
 *
 * 设计 spec：docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md:158
 *           docs/superpowers/specs/2026-06-23-market-index-dynamic-scope-design/02-backend.md §2.3
 */
export interface IndexCatalogRow {
  tsCode: string;
  name: string;
  category: IndexCatalogCategory;
  /** 成分股数量；大盘常量无此信息 */
  count?: number | null;
}

/** ths_index_catalog.type → category 映射（spec :89-92） */
const TYPE_TO_CATEGORY: Record<'I' | 'N' | 'M', IndexCatalogCategory> = {
  I: 'industry',
  N: 'concept',
  M: 'market',
};

@Injectable()
export class IndexCatalogQueryService {
  constructor(
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
  ) {}

  /**
   * 查询统一指数目录。
   *
   * @param category 'market'|'industry'|'concept'；缺省合并三类
   * @param q name 模糊搜索（大小写不敏感，ILIKE）
   */
  async findAll(
    category?: IndexCatalogCategory,
    q?: string,
  ): Promise<IndexCatalogRow[]> {
    const trimmedQ = q?.trim();
    const wantMarket = !category || category === 'market';
    const wantIndustry = !category || category === 'industry';
    const wantConcept = !category || category === 'concept';

    const rows: IndexCatalogRow[] = [];

    if (wantMarket) {
      rows.push(...(await this.queryMarket(trimmedQ)));
    }

    const dbTypes: Array<'I' | 'N'> = [
      ...(wantIndustry ? (['I'] as const) : []),
      ...(wantConcept ? (['N'] as const) : []),
    ];

    if (dbTypes.length > 0) {
      const dbRows = await this.queryDb(dbTypes, trimmedQ);
      rows.push(...dbRows);
    }

    return rows;
  }

  /** 查 ths_index_catalog type='M'（大盘动态范围），叠加 q 过滤 */
  private async queryMarket(q: string | undefined): Promise<IndexCatalogRow[]> {
    const entities = await this.catalogRepo.find({
      where: { type: 'M' },
      order: { tsCode: 'ASC' },
    });
    return entities
      .filter((e) => matchesName(e.name, q))
      .map((e) => ({
        tsCode: e.tsCode,
        name: e.name,
        category: 'market' as const,
        count: e.count,
      }));
  }

  /** 查 ths_index_catalog，type → category 映射后返回 */
  private async queryDb(
    types: Array<'I' | 'N'>,
    q: string | undefined,
  ): Promise<IndexCatalogRow[]> {
    const qb = this.catalogRepo.createQueryBuilder('c');
    // 注意 database-sql.md：getMany() 按实体属性名水合，不限制列最稳
    qb.where('c.type IN (:...types)', { types });

    if (q) {
      qb.andWhere('c.name ILIKE :q', { q: `%${q}%` });
    }

    const entities = await qb.orderBy('c.tsCode', 'ASC').getMany();
    return entities.map((e) => ({
      tsCode: e.tsCode,
      name: e.name,
      category: TYPE_TO_CATEGORY[e.type],
      count: e.count,
    }));
  }
}

/** name 模糊匹配（大小写不敏感）；q 为空时恒匹配 */
function matchesName(name: string, q: string | undefined): boolean {
  if (!q) return true;
  return name.toLowerCase().includes(q.toLowerCase());
}
