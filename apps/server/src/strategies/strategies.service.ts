import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StrategyEntity } from '../entities/strategy/strategy.entity';
import { StrategyTypeEntity } from '../entities/strategy/strategy-type.entity';

@Injectable()
export class StrategiesService {
  constructor(
    @InjectRepository(StrategyEntity)
    private readonly strategyRepo: Repository<StrategyEntity>,
    @InjectRepository(StrategyTypeEntity)
    private readonly typeRepo: Repository<StrategyTypeEntity>,
  ) {}

  listTypes() {
    return this.typeRepo.find({ order: { id: 'ASC' } });
  }

  async listStrategies(userId: string, opts?: { sortField?: string; sortOrder?: 'ASC' | 'DESC'; page?: number; pageSize?: number }) {
    const ALLOWED = ['createdAt', 'lastBacktestAt', 'lastBacktestReturn', 'name'] as const;
    type AllowedField = typeof ALLOWED[number];
    const field: AllowedField = (ALLOWED as readonly string[]).includes(opts?.sortField ?? '')
      ? (opts!.sortField as AllowedField)
      : 'createdAt';
    const order = opts?.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.max(1, opts?.pageSize ?? 10);

    const [entities, total] = await this.strategyRepo.findAndCount({
      select: ['id', 'name', 'typeId', 'params', 'lastBacktestAt', 'lastBacktestReturn', 'createdAt'],
      where: { userId } as any,
      order: { [field]: order },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const rows = entities.map((r) => ({
      id: r.id,
      name: r.name,
      typeId: r.typeId,
      timeframe: (r.params as { timeframe?: string } | null)?.timeframe ?? null,
      lastBacktestAt: r.lastBacktestAt,
      lastBacktestReturn: r.lastBacktestReturn,
      createdAt: r.createdAt,
    }));

    return { rows, total, page, pageSize };
  }

  async getStrategy(userId: string, id: string) {
    const s = await this.strategyRepo.findOneBy({ id, userId } as any);
    if (!s) throw new NotFoundException(`Strategy ${id} not found`);
    return s;
  }

  async createStrategy(userId: string, dto: { name?: string; typeId: string; params?: object; symbols?: string[] }) {
    const type = await this.typeRepo.findOneBy({ id: dto.typeId });
    if (!type) throw new NotFoundException(`StrategyType ${dto.typeId} not found`);
    const name = dto.name?.trim() || this.buildDefaultName(type.name);
    const entity = this.strategyRepo.create({
      userId,
      name,
      typeId: dto.typeId,
      params: dto.params ?? type.paramSchema,
      symbols: dto.symbols ?? [],
    } as any);
    return this.strategyRepo.save(entity);
  }

  private buildDefaultName(typeName: string): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `${typeName}-${ts}`;
  }

  async updateStrategy(userId: string, id: string, dto: { name?: string; params?: object; symbols?: string[] }) {
    const s = await this.strategyRepo.findOneBy({ id, userId } as any);
    if (!s) throw new NotFoundException(`Strategy ${id} not found`);
    if (dto.name !== undefined) s.name = dto.name;
    if (dto.params !== undefined) s.params = dto.params;
    if (dto.symbols !== undefined) s.symbols = dto.symbols;
    return this.strategyRepo.save(s);
  }

  async deleteStrategy(userId: string, id: string) {
    const s = await this.strategyRepo.findOneBy({ id, userId } as any);
    if (!s) throw new NotFoundException(`Strategy ${id} not found`);
    await this.strategyRepo.remove(s);
    return { ok: true };
  }
}
