import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StrategyEntity } from '../entities/strategy.entity';
import { StrategyTypeEntity } from '../entities/strategy-type.entity';

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

  listStrategies() {
    return this.strategyRepo.find({ order: { createdAt: 'DESC' } });
  }

  async getStrategy(id: string) {
    const s = await this.strategyRepo.findOneBy({ id });
    if (!s) throw new NotFoundException(`Strategy ${id} not found`);
    return s;
  }

  async createStrategy(dto: { name: string; typeId: string; params?: object; symbols?: string[] }) {
    const type = await this.typeRepo.findOneBy({ id: dto.typeId });
    if (!type) throw new NotFoundException(`StrategyType ${dto.typeId} not found`);
    const entity = this.strategyRepo.create({
      name: dto.name,
      typeId: dto.typeId,
      params: dto.params ?? type.paramSchema,
      symbols: dto.symbols ?? [],
    });
    return this.strategyRepo.save(entity);
  }

  async updateStrategy(id: string, dto: { name?: string; params?: object; symbols?: string[] }) {
    const s = await this.strategyRepo.findOneBy({ id });
    if (!s) throw new NotFoundException(`Strategy ${id} not found`);
    if (dto.name !== undefined) s.name = dto.name;
    if (dto.params !== undefined) s.params = dto.params;
    if (dto.symbols !== undefined) s.symbols = dto.symbols;
    return this.strategyRepo.save(s);
  }

  async deleteStrategy(id: string) {
    const s = await this.strategyRepo.findOneBy({ id });
    if (!s) throw new NotFoundException(`Strategy ${id} not found`);
    await this.strategyRepo.remove(s);
    return { ok: true };
  }
}
