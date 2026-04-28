import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError, Not } from 'typeorm';
import { SymbolPresetEntity } from '../../entities/symbol/symbol-preset.entity';
import { SymbolPresetItemEntity } from '../../entities/symbol/symbol-preset-item.entity';

type PresetDto = {
  id: string;
  name: string;
  symbols: string[];
  createdAt: Date;
};

@Injectable()
export class SymbolPresetsService {
  constructor(
    @InjectRepository(SymbolPresetEntity)
    private readonly presetRepo: Repository<SymbolPresetEntity>,
    @InjectRepository(SymbolPresetItemEntity)
    private readonly itemRepo: Repository<SymbolPresetItemEntity>,
  ) {}

  async list(userId: string): Promise<PresetDto[]> {
    const rows = await this.presetRepo.find({
      where: { userId } as any,
      relations: ['items'],
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(userId: string, id: string): Promise<PresetDto> {
    const row = await this.presetRepo.findOne({ where: { id, userId } as any, relations: ['items'] });
    if (!row) throw new NotFoundException(`Preset ${id} not found`);
    return this.toDto(row);
  }

  async create(userId: string, dto: { name: string; symbols?: string[] }): Promise<PresetDto> {
    const name = (dto.name ?? '').trim();
    if (!name) throw new ConflictException('预设名称不能为空');
    await this.ensureNameAvailable(userId, name);
    const entity = this.presetRepo.create({ userId, name } as Partial<SymbolPresetEntity>) as SymbolPresetEntity;
    const saved = await this.presetRepo.save(entity).catch((e) => this.handleUniqueError(e));
    if (dto.symbols?.length) {
      await this.setSymbols(saved.id, dto.symbols);
    }
    return this.get(userId, saved.id);
  }

  async update(userId: string, id: string, dto: { name?: string; symbols?: string[] }): Promise<PresetDto> {
    const row = await this.presetRepo.findOneBy({ id, userId } as any);
    if (!row) throw new NotFoundException(`Preset ${id} not found`);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new ConflictException('预设名称不能为空');
      if (name !== row.name) {
        await this.ensureNameAvailable(userId, name, id);
        row.name = name;
        await this.presetRepo.save(row).catch((e) => this.handleUniqueError(e));
      }
    }
    if (dto.symbols !== undefined) {
      await this.setSymbols(id, dto.symbols);
    }
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<{ ok: true }> {
    const row = await this.presetRepo.findOneBy({ id, userId } as any);
    if (!row) throw new NotFoundException(`Preset ${id} not found`);
    await this.presetRepo.remove(row);
    return { ok: true };
  }

  private async ensureNameAvailable(userId: string, name: string, excludeId?: string) {
    const existed = await this.presetRepo.findOne({
      where: excludeId ? { userId, name, id: Not(excludeId) } as any : { userId, name } as any,
    });
    if (existed) throw new ConflictException(`预设名称 "${name}" 已存在`);
  }

  private handleUniqueError(err: unknown): never {
    if (err instanceof QueryFailedError && /duplicate key|unique/i.test(err.message)) {
      throw new ConflictException('预设名称已存在');
    }
    throw err as Error;
  }

  private async setSymbols(presetId: string, symbols: string[]) {
    await this.itemRepo.delete({ presetId });
    const unique = Array.from(new Set(symbols));
    if (unique.length) {
      const items = unique.map((symbol) => this.itemRepo.create({ presetId, symbol }));
      await this.itemRepo.save(items);
    }
  }

  private toDto(row: SymbolPresetEntity): PresetDto {
    return {
      id: row.id,
      name: row.name,
      symbols: (row.items ?? []).map((i) => i.symbol),
      createdAt: row.createdAt,
    };
  }
}
