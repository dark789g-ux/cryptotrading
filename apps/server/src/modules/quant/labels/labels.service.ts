import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LabelDefinitionEntity } from '../../../entities/ml/label-definition.entity';
import { LABEL_BASE_TYPES, LABEL_CLASSIFY_MODES } from './dto/create-label.dto';
import type { ValidatedCreateLabel } from './dto/create-label.dto';
import type { ValidatedUpdateLabel } from './dto/update-label.dto';

/**
 * 响应 DTO 形态：snake_case，与 DB / 前端契约对齐。
 *
 * `DB 列 (snake_case) → entity 属性 (camelCase) → 响应 DTO (snake_case)`
 */
export interface LabelDefinitionResponse {
  label_id: string;
  label_version: string;
  name: string;
  base_type: string;
  base_params: Record<string, unknown>;
  classify_mode: string | null;
  classify_params: Record<string, unknown>;
  description: string | null;
  enabled: boolean;
  display_order: number;
  created_at: string;
}

export interface ListLabelsQuery {
  enabled?: boolean;
  base_type?: string;
}

/**
 * `expandForTraining` 返回的明文展开结构。
 *
 * 用于写入 `ml.jobs.params`（base_type/base_params/classify_mode/classify_params 明文 +
 * label_id/label_version 透传供 model_run 追溯）。
 */
export interface LabelExpanded {
  base_type: string;
  base_params: Record<string, unknown>;
  classify_mode: string | null;
  classify_params: Record<string, unknown>;
  label_id: string;
  label_version: string;
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

function toResponse(row: LabelDefinitionEntity): LabelDefinitionResponse {
  return {
    label_id: row.labelId,
    label_version: row.labelVersion,
    name: row.name,
    base_type: row.baseType,
    base_params: row.baseParams,
    classify_mode: row.classifyMode,
    classify_params: row.classifyParams,
    description: row.description,
    enabled: row.enabled,
    display_order: row.displayOrder,
    created_at: formatUtcWallClock(row.createdAt),
  };
}

@Injectable()
export class LabelsService {
  private readonly logger = new Logger(LabelsService.name);

  constructor(
    @InjectRepository(LabelDefinitionEntity)
    private readonly repo: Repository<LabelDefinitionEntity>,
  ) {}

  /**
   * 列出标签定义（可选按 enabled / base_type 过滤）。
   *
   * 排序：`display_order ASC, label_id ASC`
   */
  async list(query?: ListLabelsQuery): Promise<LabelDefinitionResponse[]> {
    const qb = this.repo.createQueryBuilder('l');
    if (query?.enabled !== undefined && query.enabled !== null) {
      qb.andWhere('l.enabled = :enabled', { enabled: query.enabled });
    }
    if (query?.base_type !== undefined && query.base_type !== null && query.base_type !== '') {
      qb.andWhere('l.base_type = :base_type', { base_type: query.base_type });
    }
    qb.orderBy('l.display_order', 'ASC').addOrderBy('l.label_id', 'ASC');
    const rows = await qb.getMany();
    return rows.map(toResponse);
  }

  /**
   * 按 (label_id, label_version) 取单条，不存在抛 404。
   */
  async findOne(labelId: string, labelVersion: string): Promise<LabelDefinitionResponse> {
    const row = await this.repo.findOne({ where: { labelId, labelVersion } });
    if (!row) {
      throw new NotFoundException(`label ${labelId}@${labelVersion} 不存在`);
    }
    return toResponse(row);
  }

  /**
   * 新建一条标签定义（或新建版本：同 label_id 递增 label_version）。
   *
   * 已存在 (label_id, label_version) → 409 冲突（幂等：由调用方决定版本号）。
   */
  async create(dto: ValidatedCreateLabel): Promise<LabelDefinitionResponse> {
    // 幂等检查：已存在则冲突
    const existing = await this.repo.findOne({
      where: { labelId: dto.labelId, labelVersion: dto.labelVersion },
    });
    if (existing) {
      throw new BadRequestException(
        `label ${dto.labelId}@${dto.labelVersion} 已存在。若要新建版本请递增 label_version。`,
      );
    }

    const entity = this.repo.create({
      labelId: dto.labelId,
      labelVersion: dto.labelVersion,
      name: dto.name,
      baseType: dto.baseType,
      baseParams: dto.baseParams,
      classifyMode: dto.classifyMode,
      classifyParams: dto.classifyParams,
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
   * 语义字段（base_type / base_params / classify_mode / classify_params）不可原地改，
   * 由 DTO 校验层在 controller 调用 validateUpdateLabel 时拒绝（400）。
   *
   * 行不存在 → 404。
   */
  async update(
    labelId: string,
    labelVersion: string,
    dto: ValidatedUpdateLabel,
  ): Promise<LabelDefinitionResponse> {
    const existing = await this.repo.findOne({ where: { labelId, labelVersion } });
    if (!existing) {
      throw new NotFoundException(`label ${labelId}@${labelVersion} 不存在`);
    }

    const patch: Partial<LabelDefinitionEntity> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.displayOrder !== undefined) patch.displayOrder = dto.displayOrder;

    await this.repo.update({ labelId, labelVersion }, patch);

    const fresh = await this.repo.findOne({ where: { labelId, labelVersion } });
    if (!fresh) {
      this.logger.warn(
        `label_definitions_disappeared_after_update label_id=${labelId} v=${labelVersion}`,
      );
      const merged = Object.assign({}, existing, patch) as LabelDefinitionEntity;
      return toResponse(merged);
    }
    return toResponse(fresh);
  }

  /**
   * 展开命名标签为训练明文参数。
   *
   * 用于 `QuantJobsService.create()` 在建 job 时把 labelRef 解析为
   * `ml.jobs.params` 中的明文字段：
   *   { base_type, base_params, classify_mode, classify_params, label_id, label_version }
   *
   * fail-fast 约束（spec 03-backend.md 关键约束 §5）：
   *   - 指向的 label 不存在 → 400
   *   - enabled=false → 400（禁止静默回退默认）
   */
  async expandForTraining(labelId: string, labelVersion: string): Promise<LabelExpanded> {
    const row = await this.repo.findOne({ where: { labelId, labelVersion } });

    if (!row) {
      throw new BadRequestException(
        `labelRef 指向的 label ${labelId}@${labelVersion} 不存在，无法建训练任务`,
      );
    }

    if (!row.enabled) {
      throw new BadRequestException(
        `labelRef 指向的 label ${labelId}@${labelVersion} 已停用（enabled=false），` +
          '请改用已启用的标签或先启用该标签',
      );
    }

    return {
      base_type: row.baseType,
      base_params: row.baseParams,
      classify_mode: row.classifyMode,
      classify_params: row.classifyParams,
      label_id: row.labelId,
      label_version: row.labelVersion,
    };
  }

  /**
   * 返回 base_type + classify_mode 合法枚举值，供前端下拉渲染。
   *
   * 枚举权威在 Python labels 模块，后端此处为镜像。
   */
  getBaseTypes(): { base_types: readonly string[]; classify_modes: readonly string[] } {
    return {
      base_types: LABEL_BASE_TYPES,
      classify_modes: LABEL_CLASSIFY_MODES,
    };
  }
}
