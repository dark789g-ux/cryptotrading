import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Not, QueryFailedError, Repository } from 'typeorm';
import { AShareFilterPresetEntity } from '../../../entities/a-share/a-share-filter-preset.entity';
import {
  ASharesFilterPresetDto,
  ASharesFilterPresetFilters,
  QueryCondition,
} from '../a-shares.types';

const OPS: QueryCondition['op'][] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

@Injectable()
export class ASharesFilterPresetsService {
  constructor(
    @InjectRepository(AShareFilterPresetEntity)
    private readonly presetRepo: Repository<AShareFilterPresetEntity>,
  ) {}

  async list(): Promise<ASharesFilterPresetDto[]> {
    const rows = await this.presetRepo.find({ order: { updatedAt: 'DESC' } });
    return rows.map((row) => this.toDto(row));
  }

  async create(dto: { name: string; filters: unknown }): Promise<ASharesFilterPresetDto> {
    const name = this.normalizeName(dto.name);
    await this.ensureNameAvailable(name);
    const filters = this.normalizeFilters(dto.filters);
    const entity = this.presetRepo.create({ id: uuidv4(), name, filters });
    const saved = await this.presetRepo.save(entity).catch((err) => this.handleUniqueError(err));
    return this.toDto(saved);
  }

  async update(id: string, dto: { name?: string; filters?: unknown }): Promise<ASharesFilterPresetDto> {
    const row = await this.presetRepo.findOneBy({ id });
    if (!row) throw new NotFoundException(`Filter preset ${id} not found`);

    if (dto.name !== undefined) {
      const name = this.normalizeName(dto.name);
      if (name !== row.name) {
        await this.ensureNameAvailable(name, id);
        row.name = name;
      }
    }
    if (dto.filters !== undefined) {
      row.filters = this.normalizeFilters(dto.filters);
    }

    const saved = await this.presetRepo.save(row).catch((err) => this.handleUniqueError(err));
    return this.toDto(saved);
  }

  async remove(id: string): Promise<{ ok: true }> {
    const row = await this.presetRepo.findOneBy({ id });
    if (!row) throw new NotFoundException(`Filter preset ${id} not found`);
    await this.presetRepo.remove(row);
    return { ok: true };
  }

  private normalizeName(value: string): string {
    const name = (value ?? '').trim();
    if (!name) throw new ConflictException('筛选方案名称不能为空');
    return name;
  }

  private async ensureNameAvailable(name: string, excludeId?: string) {
    const existed = await this.presetRepo.findOne({
      where: excludeId ? { name, id: Not(excludeId) } : { name },
    });
    if (existed) throw new ConflictException(`筛选方案 "${name}" 已存在`);
  }

  private normalizeFilters(value: unknown): ASharesFilterPresetFilters {
    if (!this.isRecord(value)) throw new BadRequestException('筛选条件格式错误');
    const priceMode = value.priceMode === 'raw' ? 'raw' : value.priceMode === 'qfq' ? 'qfq' : null;
    if (!priceMode) throw new BadRequestException('priceMode 只能是 qfq 或 raw');

    return {
      searchQuery: typeof value.searchQuery === 'string' ? value.searchQuery : '',
      selectedMarket: this.nullableString(value.selectedMarket),
      selectedIndustry: this.nullableString(value.selectedIndustry),
      priceMode,
      pctChangeMin: this.nullableFiniteNumber(value.pctChangeMin, 'pctChangeMin'),
      turnoverRateMin: this.nullableFiniteNumber(value.turnoverRateMin, 'turnoverRateMin'),
      advancedConditions: this.normalizeConditions(value.advancedConditions),
    };
  }

  private normalizeConditions(value: unknown): QueryCondition[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new BadRequestException('advancedConditions 必须是数组');
    return value.map((item) => {
      if (!this.isRecord(item)) throw new BadRequestException('advancedConditions 条件格式错误');
      if (typeof item.field !== 'string' || !item.field.trim()) {
        throw new BadRequestException('advancedConditions.field 不能为空');
      }
      if (!OPS.includes(item.op as QueryCondition['op'])) {
        throw new BadRequestException('advancedConditions.op 无效');
      }
      if (item.valueType === 'field') {
        if (typeof item.compareField !== 'string' || !item.compareField.trim()) {
          throw new BadRequestException('advancedConditions.compareField 不能为空');
        }
        return {
          field: item.field.trim(),
          op: item.op as QueryCondition['op'],
          valueType: 'field',
          compareField: item.compareField.trim(),
        };
      }
      const valueNumber = Number(item.value);
      if (!Number.isFinite(valueNumber)) {
        throw new BadRequestException('advancedConditions.value 必须是有限数字');
      }
      return { field: item.field.trim(), op: item.op as QueryCondition['op'], valueType: 'number', value: valueNumber };
    });
  }

  private nullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? value : null;
  }

  private nullableFiniteNumber(value: unknown, field: string): number | null {
    if (value === null || value === undefined) return null;
    const valueNumber = Number(value);
    if (!Number.isFinite(valueNumber)) throw new BadRequestException(`${field} 必须是有限数字`);
    return valueNumber;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private handleUniqueError(err: unknown): never {
    if (err instanceof QueryFailedError && /duplicate key|unique/i.test(err.message)) {
      throw new ConflictException('筛选方案名称已存在');
    }
    throw err as Error;
  }

  private toDto(row: AShareFilterPresetEntity): ASharesFilterPresetDto {
    return {
      id: row.id,
      name: row.name,
      filters: this.normalizeFilters(row.filters),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
