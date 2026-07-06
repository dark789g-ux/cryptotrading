import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
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

export interface IndexCatalogMemberRow {
  conCode: string;
  name: string | null;
  weight: number | null;
}

@Injectable()
export class IndexCatalogQueryService {
  constructor(
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
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

  /**
   * 只读：导入外部指数成分（Modal Step 2）。
   * 优先 index_weight 当前 active 版本，否则 ths_member_stocks；申万 .SI 走 raw.index_member。
   */
  async getMembers(tsCode: string): Promise<{ members: IndexCatalogMemberRow[] }> {
    const code = tsCode.trim();
    if (!code) {
      throw new NotFoundException('指数代码无效');
    }

    if (code.endsWith('.SI')) {
      const rows = await this.dataSource.query<
        Array<{ con_code: string; name: string | null }>
      >(
        `SELECT im.ts_code AS con_code, im.name
           FROM raw.index_member im
          WHERE im.is_new = 'Y'
            AND (im.out_date IS NULL OR im.out_date = '')
            AND (im.l1_code = $1 OR im.l2_code = $1 OR im.l3_code = $1)
          ORDER BY im.ts_code ASC`,
        [code],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`未找到指数 ${code} 成分`);
      }
      return {
        members: rows.map((r) => ({
          conCode: r.con_code,
          name: r.name,
          weight: null,
        })),
      };
    }

    const weightRows = await this.dataSource.query<
      Array<{ con_code: string; weight: string | null }>
    >(
      `SELECT w.con_code, w.weight
         FROM index_weight w
        WHERE w.index_code = $1 AND w.expire_date IS NULL
        ORDER BY w.con_code ASC`,
      [code],
    );
    if (weightRows.length > 0) {
      const names = await this.loadStockNames(weightRows.map((r) => r.con_code));
      return {
        members: weightRows.map((r) => ({
          conCode: r.con_code,
          name: names.get(r.con_code) ?? null,
          weight: r.weight != null ? Number(r.weight) : null,
        })),
      };
    }

    const thsRows = await this.dataSource.query<
      Array<{ con_code: string; con_name: string | null }>
    >(
      `SELECT t.con_code, t.con_name
         FROM ths_member_stocks t
        WHERE t.ts_code = $1
        ORDER BY t.con_code ASC`,
      [code],
    );
    if (thsRows.length === 0) {
      throw new NotFoundException(`未找到指数 ${code} 成分`);
    }
    return {
      members: thsRows.map((r) => ({
        conCode: r.con_code,
        name: r.con_name,
        weight: null,
      })),
    };
  }

  async getSwHierarchy(tsCode: string): Promise<SwIndexCatalogEntity> {
    const swCatalogRepo = this.dataSource.getRepository(SwIndexCatalogEntity);
    const row = await swCatalogRepo.findOne({ where: { tsCode } });
    if (!row) {
      throw new NotFoundException(`未找到申万指数 ${tsCode} 目录`);
    }
    return row;
  }

  private async loadStockNames(codes: string[]): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    if (codes.length === 0) return map;
    const rows = await this.dataSource.query<Array<{ ts_code: string; name: string | null }>>(
      `SELECT ts_code, name FROM a_share_symbols WHERE ts_code = ANY($1)`,
      [codes],
    );
    for (const r of rows) map.set(r.ts_code, r.name);
    return map;
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
