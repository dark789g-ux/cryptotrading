import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, QueryFailedError, Repository } from 'typeorm';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';

@Injectable()
export class WatchlistsService {
  constructor(
    @InjectRepository(WatchlistEntity)
    private readonly watchlistRepo: Repository<WatchlistEntity>,
    @InjectRepository(WatchlistItemEntity)
    private readonly itemRepo: Repository<WatchlistItemEntity>,
  ) {}

  listWatchlists(userId: string) {
    return this.watchlistRepo.find({
      where: { userId } as any,
      relations: ['items'],
      order: { createdAt: 'DESC' },
    });
  }

  async getWatchlist(userId: string, id: string) {
    const w = await this.watchlistRepo.findOne({ where: { id, userId } as any, relations: ['items'] });
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    return w;
  }

  async createWatchlist(userId: string, dto: { name: string; symbols?: string[] }) {
    const name = this.normalizeName(dto.name);
    await this.ensureNameAvailable(userId, name);
    const entity = this.watchlistRepo.create({ userId, name } as Partial<WatchlistEntity>) as WatchlistEntity;
    const saved = await this.watchlistRepo.save(entity).catch((e) => this.handleUniqueError(e));
    if (dto.symbols?.length) {
      await this.setSymbols(saved.id, dto.symbols);
    }
    return this.getWatchlist(userId, saved.id);
  }

  async updateWatchlist(userId: string, id: string, dto: { name?: string; symbols?: string[] }) {
    const w = await this.watchlistRepo.findOneBy({ id, userId } as any);
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    if (dto.name !== undefined) {
      const name = this.normalizeName(dto.name);
      if (name !== w.name) {
        await this.ensureNameAvailable(userId, name, id);
        w.name = name;
        await this.watchlistRepo.save(w).catch((e) => this.handleUniqueError(e));
      }
    }
    if (dto.symbols !== undefined) {
      await this.setSymbols(id, dto.symbols);
    }
    return this.getWatchlist(userId, id);
  }

  async deleteWatchlist(userId: string, id: string) {
    const w = await this.watchlistRepo.findOneBy({ id, userId } as any);
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    await this.watchlistRepo.remove(w);
    return { ok: true };
  }

  private normalizeName(value: string): string {
    const name = (value ?? '').trim();
    if (!name) throw new ConflictException('自选列表名称不能为空');
    return name;
  }

  private async ensureNameAvailable(userId: string, name: string, excludeId?: string) {
    const existed = await this.watchlistRepo.findOne({
      where: excludeId ? { userId, name, id: Not(excludeId) } as any : { userId, name } as any,
    });
    if (existed) throw new ConflictException(`自选列表 "${name}" 已存在`);
  }

  private handleUniqueError(err: unknown): never {
    if (err instanceof QueryFailedError && /duplicate key|unique/i.test(err.message)) {
      throw new ConflictException('自选列表名称已存在');
    }
    throw err as Error;
  }

  private async setSymbols(watchlistId: string, symbols: string[]) {
    await this.itemRepo.delete({ watchlistId });
    const unique = Array.from(new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean)));
    if (unique.length) {
      const items = unique.map((symbol) => this.itemRepo.create({ watchlistId, symbol }));
      await this.itemRepo.save(items);
    }
  }
}
