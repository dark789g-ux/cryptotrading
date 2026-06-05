import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ExitRuleTypeMeta, StrategyDefinition } from '@cryptotrading/shared-types';
import { StrategyDefinitionEntity } from '../../../entities/ml/strategy-definition.entity';
import {
  getExitRuleTypesMeta,
  validateExitRules,
} from './dto/create-strategy.dto';
import type { ValidatedCreateStrategy } from './dto/create-strategy.dto';
import type { ValidatedUpdateStrategy } from './dto/update-strategy.dto';

export interface ListStrategiesQuery {
  enabled?: boolean;
}

/**
 * 把 Date 格式化为 UTC 墙钟字符串 `YYYY-MM-DD HH:mm:ssZ`。
 *
 * CLAUDE.md 时间规范：出参一律 UTC 墙钟字符串，禁 toLocaleString / toISOString().slice。
 * （与 labels.service formatUtcWallClock 同实现）
 */
function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

function toResponse(row: StrategyDefinitionEntity): StrategyDefinition {
  return {
    strategy_id: row.strategyId,
    strategy_version: row.strategyVersion,
    name: row.name,
    exit_rules: row.exitRules ?? [],
    description: row.description,
    enabled: row.enabled,
    display_order: row.displayOrder,
    created_at: formatUtcWallClock(row.createdAt),
  };
}

/**
 * `apps/server/src/modules/quant/strategies/`：出场策略定义 CRUD。
 *
 * 表 `factors.strategy_definitions` 由 Alembic（quant-pipeline 侧）建表，
 * NestJS `synchronize: false`；本 service 仅做读写。
 *
 * `QuantStrategiesService` 导出供 `LabelsService` 在建 strategy_aware 标签时
 * 校验引用的策略存在且 enabled（spec 04 §6.2）。
 */
@Injectable()
export class QuantStrategiesService {
  private readonly logger = new Logger(QuantStrategiesService.name);

  constructor(
    @InjectRepository(StrategyDefinitionEntity)
    private readonly repo: Repository<StrategyDefinitionEntity>,
  ) {}

  /**
   * 列出策略定义（可选按 enabled 过滤）。
   *
   * 排序：`display_order ASC, strategy_id ASC, strategy_version ASC`（spec 04 §5）。
   */
  async list(query?: ListStrategiesQuery): Promise<StrategyDefinition[]> {
    const qb = this.repo.createQueryBuilder('s');
    if (query?.enabled !== undefined && query.enabled !== null) {
      qb.andWhere('s.enabled = :enabled', { enabled: query.enabled });
    }
    qb.orderBy('s.display_order', 'ASC')
      .addOrderBy('s.strategy_id', 'ASC')
      .addOrderBy('s.strategy_version', 'ASC');
    const rows = await qb.getMany();
    return rows.map(toResponse);
  }

  /**
   * 按 (strategy_id, strategy_version) 取单条，不存在抛 404。
   */
  async findOne(strategyId: string, strategyVersion: string): Promise<StrategyDefinition> {
    const row = await this.repo.findOne({ where: { strategyId, strategyVersion } });
    if (!row) {
      throw new NotFoundException(`strategy ${strategyId}@${strategyVersion} 不存在`);
    }
    return toResponse(row);
  }

  /**
   * 新建一条策略定义（或新建版本：同 strategy_id 递增 strategy_version）。
   *
   * - 落库前再跑一遍 exit_rules 范围 + 跨规则校验（spec 04 §5；DTO 已校验，此为纵深防御）。
   * - 已存在 (strategy_id, strategy_version) → 409 冲突（不可变版本模型）。
   */
  async create(dto: ValidatedCreateStrategy): Promise<StrategyDefinition> {
    // 纵深防御：落库前再校验一遍 exit_rules（范围 + 跨规则）
    const exitRules = validateExitRules(dto.exitRules);

    const existing = await this.repo.findOne({
      where: { strategyId: dto.strategyId, strategyVersion: dto.strategyVersion },
    });
    if (existing) {
      throw new ConflictException(
        `strategy ${dto.strategyId}@${dto.strategyVersion} 已存在。` +
          '若要新建版本请递增 strategy_version。',
      );
    }

    const entity = this.repo.create({
      strategyId: dto.strategyId,
      strategyVersion: dto.strategyVersion,
      name: dto.name,
      exitRules,
      description: dto.description ?? null,
      enabled: dto.enabled,
      displayOrder: dto.displayOrder,
    });
    const saved = await this.repo.save(entity);
    return toResponse(saved);
  }

  /**
   * PATCH 展示元数据（name / description / enabled / display_order）。
   *
   * 语义字段（exit_rules / strategy_id / strategy_version）不可原地改，
   * 由 DTO 校验层（validateUpdateStrategy）在 controller 调用时拒绝（422）。
   *
   * 行不存在 → 404。
   */
  async update(
    strategyId: string,
    strategyVersion: string,
    dto: ValidatedUpdateStrategy,
  ): Promise<StrategyDefinition> {
    const existing = await this.repo.findOne({ where: { strategyId, strategyVersion } });
    if (!existing) {
      throw new NotFoundException(`strategy ${strategyId}@${strategyVersion} 不存在`);
    }

    const patch: Partial<StrategyDefinitionEntity> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.displayOrder !== undefined) patch.displayOrder = dto.displayOrder;

    await this.repo.update({ strategyId, strategyVersion }, patch);

    const fresh = await this.repo.findOne({ where: { strategyId, strategyVersion } });
    if (!fresh) {
      this.logger.warn(
        `strategy_definitions_disappeared_after_update strategy_id=${strategyId} v=${strategyVersion}`,
      );
      const merged = Object.assign({}, existing, patch) as StrategyDefinitionEntity;
      return toResponse(merged);
    }
    return toResponse(fresh);
  }

  /**
   * 取单条原始实体（不抛 404）。供 LabelsService 校验 strategy_aware 引用用。
   *
   * 返回 null 表示不存在，调用方自行决定 fail 形态（labels 建标签时 → 422）。
   */
  async findRaw(
    strategyId: string,
    strategyVersion: string,
  ): Promise<StrategyDefinitionEntity | null> {
    return this.repo.findOne({ where: { strategyId, strategyVersion } });
  }

  /**
   * 返回出场规则 type 枚举 + 每种 params 元信息（范围/类型/默认值）。
   *
   * 后端是范围的**单一真相源**；前端 ExitRulesEditor 据此渲染动态表单、做范围提示。
   */
  getExitRuleTypes(): { items: ExitRuleTypeMeta[] } {
    return { items: getExitRuleTypesMeta() };
  }
}
