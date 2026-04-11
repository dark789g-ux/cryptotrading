import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Watchlist } from './entities/watchlist.entity';
import { WatchlistItem } from './entities/watchlist-item.entity';
import { CreateWatchlistDto } from './dto/create-watchlist.dto';
import { AddItemDto } from './dto/add-item.dto';

@Injectable()
export class WatchlistsService {
  constructor(
    @InjectRepository(Watchlist)
    private watchlistRepo: Repository<Watchlist>,
    @InjectRepository(WatchlistItem)
    private itemRepo: Repository<WatchlistItem>,
  ) {}

  async findAll() {
    return this.watchlistRepo.find({
      order: { sortOrder: 'asc' },
    });
  }

  async findOne(id: string) {
    return this.watchlistRepo.findOne({
      where: { id },
      relations: ['items'],
    });
  }

  async create(dto: CreateWatchlistDto) {
    const maxOrder = await this.watchlistRepo
      .createQueryBuilder()
      .select('MAX(sortOrder)', 'max')
      .getRawOne();

    const watchlist = this.watchlistRepo.create({
      ...dto,
      sortOrder: (maxOrder?.max || 0) + 1,
    });

    return this.watchlistRepo.save(watchlist);
  }

  async update(id: string, dto: CreateWatchlistDto) {
    await this.watchlistRepo.update(id, dto);
    return this.findOne(id);
  }

  async remove(id: string) {
    await this.watchlistRepo.delete(id);
    return { success: true };
  }

  async addItem(watchlistId: string, dto: AddItemDto) {
    const watchlist = await this.findOne(watchlistId);
    if (!watchlist) throw new Error('Watchlist not found');

    // 检查是否已存在
    const exists = watchlist.items.some(item => item.tsCode === dto.tsCode);
    if (exists) throw new Error('Stock already in watchlist');

    const maxOrder = watchlist.items.length;

    const item = this.itemRepo.create({
      ...dto,
      watchlist,
      sortOrder: maxOrder,
    });

    return this.itemRepo.save(item);
  }

  async removeItem(itemId: string) {
    await this.itemRepo.delete(itemId);
    return { success: true };
  }
}
