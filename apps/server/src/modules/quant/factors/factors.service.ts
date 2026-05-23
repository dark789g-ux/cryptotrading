import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FactorDefinitionEntity } from '../../../entities/ml/factor-definition.entity';
import type { ValidatedUpdateFactor } from './dto/update-factor.dto';

/**
 * 响应 DTO 形态：与 DB / 前端契约对齐的 snake_case。
 *
 * `DB 列 (snake_case) → entity 属性 (camelCase) → 响应 DTO (snake_case)`
 *
 * 避免前端 TS 类型既要兼容 DB 又要兼容 entity 的混乱。
 */
export interface FactorDefinitionResponse {
  factor_id: string;
  factor_version: string;
  description: string;
  formula: string | null;
  data_source: string[] | null;
  category: string;
  pit_window_days: number;
  pit_anchor: string;
  enabled: boolean;
  display_order: number;
  updated_at: string;
  updated_by: string | null;
}

export interface ListFactorsQuery {
  enabled?: boolean;
  category?: string;
}

/**
 * 把 Date 格式化为 UTC 墙钟字符串 `YYYY-MM-DD HH:mm:ssZ`。
 *
 * CLAUDE.md 时间规范：出参一律 UTC 墙钟字符串，禁 toLocaleString / toISOString().slice。
 */
function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

function toResponse(row: FactorDefinitionEntity): FactorDefinitionResponse {
  return {
    factor_id: row.factorId,
    factor_version: row.factorVersion,
    description: row.description,
    formula: row.formula,
    data_source: row.dataSource,
    category: row.category,
    pit_window_days: row.pitWindowDays,
    pit_anchor: row.pitAnchor,
    enabled: row.enabled,
    display_order: row.displayOrder,
    updated_at: formatUtcWallClock(row.updatedAt),
    updated_by: row.updatedBy,
  };
}

@Injectable()
export class FactorsService {
  private readonly logger = new Logger(FactorsService.name);

  constructor(
    @InjectRepository(FactorDefinitionEntity)
    private readonly repo: Repository<FactorDefinitionEntity>,
  ) {}

  /**
   * 列出全部因子（可选按 enabled / category 过滤）。
   *
   * 排序：`display_order ASC, factor_id ASC`——与 spec `list_active` 保持一致。
   */
  async listFactors(query?: ListFactorsQuery): Promise<FactorDefinitionResponse[]> {
    const qb = this.repo.createQueryBuilder('f');
    if (query?.enabled !== undefined && query.enabled !== null) {
      qb.andWhere('f.enabled = :enabled', { enabled: query.enabled });
    }
    if (query?.category !== undefined && query.category !== null && query.category !== '') {
      qb.andWhere('f.category = :category', { category: query.category });
    }
    qb.orderBy('f.display_order', 'ASC').addOrderBy('f.factor_id', 'ASC');
    const rows = await qb.getMany();
    return rows.map(toResponse);
  }

  /**
   * 列出 DB 中出现过的 distinct category（用于前端筛选下拉）。
   *
   * 注：不返回 spec 中固定 4 个枚举值——只返回当前 DB 实际存在的，避免空类别污染。
   */
  async listCategories(): Promise<string[]> {
    const rows: Array<{ category: string }> = await this.repo
      .createQueryBuilder('f')
      .select('DISTINCT f.category', 'category')
      .where('f.category IS NOT NULL')
      .orderBy('category', 'ASC')
      .getRawMany();
    return rows.map((r) => r.category).filter((c) => typeof c === 'string' && c.length > 0);
  }

  /**
   * 按 (factor_id, factor_version) 取单条，不存在抛 404。
   *
   * 用于 PATCH 前置校验：资源不存在直接返 404，而不是静默 update 0 行。
   */
  async findOne(factorId: string, factorVersion: string): Promise<FactorDefinitionResponse> {
    const row = await this.repo.findOne({ where: { factorId, factorVersion } });
    if (!row) {
      throw new NotFoundException(`factor ${factorId}@${factorVersion} 不存在`);
    }
    return toResponse(row);
  }

  /**
   * PATCH 单条因子元数据。
   *
   * 行为：
   * - 先 findOne 校验存在（不存在抛 404）
   * - 仅更新 dto 中显式提供的字段（partial update）
   * - **强写** `updated_at = NOW()` / `updated_by = userId`，dto 中即使误传也被忽略
   * - 返回最新整行
   */
  async update(
    factorId: string,
    factorVersion: string,
    dto: ValidatedUpdateFactor,
    userId: string,
  ): Promise<FactorDefinitionResponse> {
    const existing = await this.repo.findOne({ where: { factorId, factorVersion } });
    if (!existing) {
      throw new NotFoundException(`factor ${factorId}@${factorVersion} 不存在`);
    }

    const patch: Partial<FactorDefinitionEntity> = {};
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.formula !== undefined) patch.formula = dto.formula;
    if (dto.dataSource !== undefined) patch.dataSource = dto.dataSource;
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.pitWindowDays !== undefined) patch.pitWindowDays = dto.pitWindowDays;
    if (dto.pitAnchor !== undefined) patch.pitAnchor = dto.pitAnchor;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.displayOrder !== undefined) patch.displayOrder = dto.displayOrder;

    // 强写审计字段：updated_at = NOW()、updated_by = userId（即使 dto 误传也被覆盖）
    patch.updatedAt = new Date();
    patch.updatedBy = userId ?? null;

    await this.repo.update({ factorId, factorVersion }, patch);

    const fresh = await this.repo.findOne({ where: { factorId, factorVersion } });
    if (!fresh) {
      // 极端并发：刚才存在，update 之后又被人删了。返回最后已知值（已合并 patch）以保证响应一致。
      this.logger.warn(
        `factor_definitions_disappeared_after_update factor_id=${factorId} v=${factorVersion}`,
      );
      const merged = Object.assign({}, existing, patch) as FactorDefinitionEntity;
      return toResponse(merged);
    }
    return toResponse(fresh);
  }
}
