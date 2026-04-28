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
      order: { displayOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async getWatchlist(userId: string, id: string) {
    const w = await this.watchlistRepo.findOne({
      where: { id, userId } as any,
      relations: ['items'],
      order: {
        items: { displayOrder: 'ASC' },
      },
    });
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

  async addSymbol(userId: string, id: string, symbol: string) {
    const w = await this.watchlistRepo.findOne({ where: { id, userId } as any, relations: ['items'] });
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    const exists = w.items?.some((item) => item.symbol === symbol);
    if (!exists) {
      const item = this.itemRepo.create({ watchlistId: id, symbol });
      await this.itemRepo.save(item);
    }
    return this.getWatchlist(userId, id);
  }

  async removeSymbol(userId: string, id: string, symbol: string) {
    const w = await this.watchlistRepo.findOneBy({ id, userId } as any);
    if (!w) throw new NotFoundException(`Watchlist ${id} not found`);
    await this.itemRepo.delete({ watchlistId: id, symbol });
    return { ok: true };
  }

  async getWatchlistQuotes(
    userId: string,
    id: string,
    interval: string,
    page: number,
    pageSize: number,
    sort?: { field?: string | null; order?: 'ascend' | 'descend' | null },
  ) {
    const w = await this.getWatchlist(userId, id);
    const symbols = w.items?.map((i) => i.symbol) ?? [];
    const total = symbols.length;

    if (total === 0) {
      return { items: [], total, page, page_size: pageSize };
    }

    const offset = (page - 1) * pageSize;
    const pageSymbols = symbols.slice(offset, offset + pageSize);

    let sql = `
      WITH latest AS (
        SELECT symbol, MAX(open_time) AS max_time
        FROM klines
        WHERE interval = $1 AND symbol = ANY($2)
        GROUP BY symbol
      )
      SELECT
        k.symbol,
        k.close,
        k.ma5,
        k.ma30,
        k.ma60,
        k.kdj_j AS "kdjJ",
        k.risk_reward_ratio AS "riskRewardRatio",
        k.stop_loss_pct AS "stopLossPct",
        k.open_time AS "openTime"
      FROM klines k
      JOIN latest ON k.symbol = latest.symbol AND k.open_time = latest.max_time AND k.interval = $1
      WHERE k.symbol = ANY($2)
    `;

    const params: Array<string | number | string[]> = [interval, pageSymbols];

    const SORT_COL_MAP: Record<string, string> = {
      symbol: 'k.symbol',
      close: 'k.close',
      ma5: 'k.ma5',
      ma30: 'k.ma30',
      ma60: 'k.ma60',
      kdjJ: 'k.kdj_j',
      riskRewardRatio: 'k.risk_reward_ratio',
      stopLossPct: 'k.stop_loss_pct',
      openTime: 'k.open_time',
    };

    if (sort?.field && SORT_COL_MAP[sort.field]) {
      const dir = sort.order === 'descend' ? 'DESC' : 'ASC';
      sql += ` ORDER BY ${SORT_COL_MAP[sort.field]} ${dir} NULLS LAST`;
    } else {
      const orderCases = pageSymbols.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ');
      sql += ` ORDER BY CASE k.symbol ${orderCases} END`;
    }

    const items = await this.watchlistRepo.query(sql, params);
    return { items, total, page, page_size: pageSize };
  }

  async reorderWatchlists(userId: string, ids: string[]) {
    for (let i = 0; i < ids.length; i++) {
      await this.watchlistRepo.update(
        { id: ids[i], userId } as any,
        { displayOrder: i },
      );
    }
    return { ok: true };
  }

  async reorderItems(userId: string, watchlistId: string, symbols: string[]) {
    const w = await this.watchlistRepo.findOne({
      where: { id: watchlistId, userId } as any,
      relations: ['items'],
    });
    if (!w) throw new NotFoundException(`Watchlist ${watchlistId} not found`);

    for (let i = 0; i < symbols.length; i++) {
      await this.itemRepo.update(
        { watchlistId, symbol: symbols[i] },
        { displayOrder: i },
      );
    }
    return { ok: true };
  }
}
