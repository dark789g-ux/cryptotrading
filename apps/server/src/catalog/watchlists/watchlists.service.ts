import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchlistEntity } from '../entities/watchlist.entity';
import { WatchlistItemEntity } from '../entities/watchlist-item.entity';

@Injectable()
export class WatchlistsService {
  constructor(
    @InjectRepository(WatchlistEntity)
    private readonly watchlistRepo: Repository<WatchlistEntity>,
    @InjectRepository(WatchlistItemEntity)
    private readonly itemRepo: Repository<WatchlistItemEntity>,
  ) {}

  listWatchlists() {
    return this.watchlistRepo.find({
      relations: ['items'],
      order: { createdAt: 'DESC' },
    });
  }

  async getWatchlist(id: string) {
    const w = await this.watchlistRepo.findOne({ where: { id }, relations: ['items'] });
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    return w;
  }

  async createWatchlist(dto: { name: string; symbols?: string[] }) {
    const entity = this.watchlistRepo.create({ name: dto.name });
    const saved = await this.watchlistRepo.save(entity);
    if (dto.symbols?.length) {
      await this.setSymbols(saved.id, dto.symbols);
    }
    return this.getWatchlist(saved.id);
  }

  async updateWatchlist(id: string, dto: { name?: string; symbols?: string[] }) {
    const w = await this.watchlistRepo.findOneBy({ id });
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    if (dto.name !== undefined) {
      w.name = dto.name;
      await this.watchlistRepo.save(w);
    }
    if (dto.symbols !== undefined) {
      await this.setSymbols(id, dto.symbols);
    }
    return this.getWatchlist(id);
  }

  async deleteWatchlist(id: string) {
    const w = await this.watchlistRepo.findOneBy({ id });
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    await this.watchlistRepo.remove(w);
    return { ok: true };
  }

  private async setSymbols(watchlistId: string, symbols: string[]) {
    await this.itemRepo.delete({ watchlistId });
    if (symbols.length) {
      const items = symbols.map((symbol) => this.itemRepo.create({ watchlistId, symbol }));
      await this.itemRepo.save(items);
    }
  }
}
