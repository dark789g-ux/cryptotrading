import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { ListQueryDto } from './dto/list-query.dto';

@Injectable()
export class DailyReviewService {
  constructor(
    @InjectRepository(DailyReviewEntity)
    private readonly repo: Repository<DailyReviewEntity>,
  ) {}

  async list(q: ListQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const qb = this.repo.createQueryBuilder('r')
      .orderBy('r.tradeDate', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async getDetail(tradeDate: string) {
    const row = await this.repo.findOne({ where: { tradeDate } });
    if (!row) throw new NotFoundException(`复盘 ${tradeDate} 不存在`);
    return row;
  }
}
