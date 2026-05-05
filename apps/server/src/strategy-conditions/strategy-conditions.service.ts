import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { StrategyConditionEntity, StrategyConditionItem } from '../entities/strategy-condition.entity';
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
    const { conditions, targetType } = entity;

    if (conditions.length === 0) {
      return { hits: [], totalHits: 0, totalScanned: 0 };
    }

    let query: string;

    if (targetType === 'a-share') {
      const whereClause = this.buildAShareQuery(conditions);
      query = `
        SELECT
          s.ts_code as "tsCode",
          s.name
        FROM a_share_symbols s
        JOIN a_share_daily_indicators i ON s.ts_code = i.ts_code
        WHERE i.trade_date = (SELECT MAX(trade_date) FROM a_share_daily_indicators)
          AND s.list_status = 'L'
          AND ${whereClause}
        ORDER BY s.ts_code
      `;
    } else {
      const whereClause = this.buildCryptoQuery(conditions);
      query = `
        SELECT
          k.symbol as "tsCode",
          k.symbol as name
        FROM klines k
        WHERE k.interval = '1d'
          AND k.open_time = (
            SELECT MAX(open_time) FROM klines WHERE symbol = k.symbol AND interval = '1d'
          )
          AND ${whereClause}
        ORDER BY k.symbol
      `;
    }

    // 构建条件描述
    const conditionDescriptions = conditions.map(c => {
      if (c.compareField) {
        return `${c.field} ${c.operator} ${c.compareField}`;
      }
      return `${c.field} ${c.operator} ${c.value}`;
    });

    const result = await this.dataSource.query(query);

    return {
      hits: result.map((row: any) => ({
        tsCode: row.tsCode,
        name: row.name,
        matchedConditions: conditionDescriptions,
      })),
      totalHits: result.length,
      totalScanned: 0,
    };
  }

  private buildAShareQuery(conditions: StrategyConditionItem[]): string {
    const whereClauses: string[] = [];

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;

      if (operator === 'cross_above' || operator === 'cross_below') {
        const direction = operator === 'cross_above' ? '<' : '>';
        whereClauses.push(`
          EXISTS (
            SELECT 1 FROM a_share_daily_indicators prev
            WHERE prev.ts_code = i.ts_code
              AND prev.trade_date = (
                SELECT MAX(trade_date) FROM a_share_daily_indicators
                WHERE trade_date < i.trade_date AND ts_code = i.ts_code
              )
              AND prev.${field} ${direction} prev.${compareField}
          )
          AND i.${field} ${operator === 'cross_above' ? '>' : '<'} i.${compareField}
        `);
      } else if (compareField) {
        whereClauses.push(`i.${field} ${this.getSqlOperator(operator)} i.${compareField}`);
      } else {
        whereClauses.push(`i.${field} ${this.getSqlOperator(operator)} ${value}`);
      }
    }

    return whereClauses.join(' AND ');
  }

  private buildCryptoQuery(conditions: StrategyConditionItem[]): string {
    const whereClauses: string[] = [];

    for (const cond of conditions) {
      const { field, operator, value, compareField } = cond;

      if (operator === 'cross_above' || operator === 'cross_below') {
        const direction = operator === 'cross_above' ? '<' : '>';
        whereClauses.push(`
          EXISTS (
            SELECT 1 FROM klines prev
            WHERE prev.symbol = k.symbol
              AND prev.interval = k.interval
              AND prev.open_time = (
                SELECT MAX(open_time) FROM klines
                WHERE open_time < k.open_time AND symbol = k.symbol AND interval = k.interval
              )
              AND prev.${field} ${direction} prev.${compareField}
          )
          AND k.${field} ${operator === 'cross_above' ? '>' : '<'} k.${compareField}
        `);
      } else if (compareField) {
        whereClauses.push(`k.${field} ${this.getSqlOperator(operator)} k.${compareField}`);
      } else {
        whereClauses.push(`k.${field} ${this.getSqlOperator(operator)} ${value}`);
      }
    }

    return whereClauses.join(' AND ');
  }

  private getSqlOperator(operator: string): string {
    const operatorMap: Record<string, string> = {
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      eq: '=',
      neq: '!=',
    };
    return operatorMap[operator] || '=';
  }
}
