import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StrategyConditionEntity } from '../entities/strategy-condition.entity';
import { CreateStrategyConditionDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';

export interface RunResult {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
  totalScanned: number;
}

@Injectable()
export class StrategyConditionsService {
  constructor(
    @InjectRepository(StrategyConditionEntity)
    private readonly repo: Repository<StrategyConditionEntity>,
  ) {}

  async create(userId: string, dto: CreateStrategyConditionDto): Promise<StrategyConditionEntity> {
    const entity = this.repo.create({
      ...dto,
      userId,
    });
    return this.repo.save(entity);
  }

  async findAll(userId: string, targetType?: string): Promise<StrategyConditionEntity[]> {
    const where: any = { userId };
    if (targetType) {
      where.targetType = targetType;
    }
    return this.repo.find({ where, order: { createdAt: 'DESC' } });
  }

  async findOne(id: string, userId: string): Promise<StrategyConditionEntity> {
    const entity = await this.repo.findOne({ where: { id, userId } });
    if (!entity) {
      throw new NotFoundException('Strategy condition not found');
    }
    return entity;
  }

  async update(id: string, userId: string, dto: UpdateStrategyConditionDto): Promise<StrategyConditionEntity> {
    const entity = await this.findOne(id, userId);
    Object.assign(entity, dto);
    return this.repo.save(entity);
  }

  async remove(id: string, userId: string): Promise<void> {
    const entity = await this.findOne(id, userId);
    await this.repo.remove(entity);
  }

  async run(id: string, userId: string): Promise<RunResult> {
    const entity = await this.findOne(id, userId);
    // TODO: 实现 SQL 查询逻辑
    return {
      hits: [],
      totalHits: 0,
      totalScanned: 0,
    };
  }
}
