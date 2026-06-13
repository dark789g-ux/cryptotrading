import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, QueryFailedError, Repository } from 'typeorm';
import { WatchlistEntity } from '../../entities/watchlist/watchlist.entity';
import { WatchlistItemEntity } from '../../entities/watchlist/watchlist-item.entity';
import { TushareClientService } from '../../market-data/a-shares/services/tushare-client.service';
import { UpsertByNameDto, UpsertByNameResult } from './dto/upsert-by-name.dto';

export interface IndexOption {
  value: string;
  label: string;
}

const INDEX_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时

@Injectable()
export class WatchlistsService {
  private readonly logger = new Logger(WatchlistsService.name);
  private cachedIndexOptions: IndexOption[] | null = null;
  private indexCacheExpiresAt = 0;

  constructor(
    @InjectRepository(WatchlistEntity)
    private readonly watchlistRepo: Repository<WatchlistEntity>,
    @InjectRepository(WatchlistItemEntity)
    private readonly itemRepo: Repository<WatchlistItemEntity>,
    private readonly tushareClient: TushareClientService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async listIndexOptions(): Promise<IndexOption[]> {
    if (this.cachedIndexOptions && Date.now() < this.indexCacheExpiresAt) {
      return this.cachedIndexOptions;
    }

    const markets = ['SSE', 'SZSE', 'CSI', 'SW'];
    const results: IndexOption[] = [];
    let allFailed = true;
    let firstError: Error | null = null;

    for (const market of markets) {
      try {
        const rows = await this.tushareClient.query('index_basic', { market }, 'ts_code,name');
        allFailed = false;
        for (const row of rows) {
          const value = String(row['ts_code'] ?? '').trim();
          const label = String(row['name'] ?? '').trim();
          if (value && label) {
            results.push({ value, label });
          }
        }
      } catch (err: unknown) {
        this.logger.warn(`获取 ${market} 指数列表失败：${(err as Error).message}`);
        if (!firstError) firstError = err as Error;
      }
    }

    if (allFailed && firstError) {
      throw firstError;
    }

    const seen = new Set<string>();
    const unique = results.filter((o) => {
      if (seen.has(o.value)) return false;
      seen.add(o.value);
      return true;
    });
    unique.sort((a, b) => a.label.localeCompare(b.label, 'zh'));

    this.cachedIndexOptions = unique;
    this.indexCacheExpiresAt = Date.now() + INDEX_CACHE_TTL_MS;
    return unique;
  }

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
    const unique = Array.from(new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean)));
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(WatchlistItemEntity, { watchlistId });
      if (unique.length) {
        const items = unique.map((symbol) => manager.create(WatchlistItemEntity, { watchlistId, symbol }));
        await manager.save(WatchlistItemEntity, items);
      }
    });
  }

  /**
   * 按 (userId, name) upsert 一个 watchlist，并把入参 symbols 增量加入 items。
   *
   * - 入参 symbols 按原序去重（保留首次），压缩时记 logger.warn，但**不**计入 skipped；
   * - watchlist 不存在则按 (userId, name) 新建，复用现有 normalize/ensureNameAvailable/handleUniqueError 流程；
   * - items 通过 `INSERT ... SELECT $1, unnest($2::text[]) ON CONFLICT (watchlist_id, symbol) DO NOTHING`
   *   写入，依赖 uq_watchlist_items_watchlist_symbol；
   * - 返回值中：
   *   - `added`  = 实际新增（去重后入参且不在现有 items 内的）；
   *   - `skipped` = 去重后入参中已在 items 内的；
   *   - 入参重复"压缩"不计入 skipped。
   */
  async upsertByName(userId: string, dto: UpsertByNameDto): Promise<UpsertByNameResult> {
    if (!Array.isArray(dto?.symbols)) {
      throw new BadRequestException('symbols 必须是字符串数组');
    }
    const rawSymbols = dto.symbols.map((s) => (s ?? '').toString().trim()).filter(Boolean);
    if (rawSymbols.length === 0) {
      throw new BadRequestException('symbols 不能为空');
    }

    // 原序去重（保留首次）
    const dedupSet = new Set<string>();
    const deduped: string[] = [];
    for (const s of rawSymbols) {
      if (!dedupSet.has(s)) {
        dedupSet.add(s);
        deduped.push(s);
      }
    }
    if (deduped.length !== rawSymbols.length) {
      this.logger.warn(
        `[upsertByName] symbols 含重复：original=${rawSymbols.length} deduped=${deduped.length}`,
      );
    }

    const name = this.normalizeName(dto.name);

    // 查找或创建 watchlist
    let watchlist = await this.watchlistRepo.findOne({
      where: { userId, name } as any,
      relations: ['items'],
    });
    let created = false;
    if (!watchlist) {
      await this.ensureNameAvailable(userId, name);
      const entity = this.watchlistRepo.create({ userId, name } as Partial<WatchlistEntity>) as WatchlistEntity;
      watchlist = await this.watchlistRepo.save(entity).catch((e) => this.handleUniqueError(e));
      created = true;
    }

    const existingSymbols = new Set((watchlist.items ?? []).map((it) => it.symbol));
    const toInsert = deduped.filter((s) => !existingSymbols.has(s));
    const skipped = deduped.length - toInsert.length;

    if (toInsert.length > 0) {
      await this.dataSource.transaction(async (manager) => {
        // watchlist_id 是 uuid 单标量；symbols 是 text 数组 → ::text[]
        await manager.query(
          `INSERT INTO watchlist_items (watchlist_id, symbol)
           SELECT $1::uuid, unnest($2::text[])
           ON CONFLICT (watchlist_id, symbol) DO NOTHING`,
          [watchlist.id, toInsert],
        );
      });
    }

    return {
      watchlistId: watchlist.id,
      name: watchlist.name,
      created,
      added: toInsert.length,
      skipped,
    };
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

  private async resolveProdModelVersion(): Promise<string | null> {
    const rows = await this.dataSource.query<Array<{ model_version: string }>>(
      `SELECT model_version FROM ml.model_runs WHERE status = 'prod' ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0]?.model_version ?? null;
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

    const scoreModelVersion =
      sort?.field === 'modelScore' ? await this.resolveProdModelVersion() : null;

    const params: Array<string | number | string[]> = [interval, pageSymbols];
    let scoreJoin = '';
    if (scoreModelVersion) {
      scoreJoin = `
        LEFT JOIN ml.scores_daily sd
          ON sd.ts_code = q.ts_code
          AND sd.trade_date = q.trade_date
          AND sd.model_version = $3`;
      params.push(scoreModelVersion);
    }

    const aShareScoreSelect = scoreModelVersion ? 'sd.score AS "sortScore"' : 'NULL::numeric AS "sortScore"';

    let sql = `
      WITH page_symbols AS (
        SELECT symbol, ord::int
        FROM unnest($2::text[]) WITH ORDINALITY AS t(symbol, ord)
      ),
      crypto_latest AS (
        SELECT symbol, MAX(open_time) AS max_time
        FROM klines
        WHERE interval = $1 AND symbol IN (SELECT symbol FROM page_symbols)
        GROUP BY symbol
      ),
      crypto_rows AS (
        SELECT
          ps.ord,
          k.symbol,
          sym.base_asset AS name,
          NULL::text AS market,
          NULL::text AS industry,
          NULL::numeric AS "pctChg",
          NULL::numeric AS amount,
          NULL::numeric AS "turnoverRate",
          NULL::numeric AS pe,
          NULL::numeric AS "peTtm",
          NULL::numeric AS pb,
          NULL::numeric AS "circMv",
          NULL::text AS "tradeDate",
          NULL::jsonb AS tags,
          k.close,
          k.ma5,
          k.ma30,
          k.ma60,
          k.kdj_j AS "kdjJ",
          k.risk_reward_ratio AS "riskRewardRatio",
          k.stop_loss_pct AS "stopLossPct",
          k.open_time AS "openTime",
          k.dif,
          k.dea,
          k.macd,
          k.kdj_k AS "kdjK",
          k.kdj_d AS "kdjD",
          k.bbi,
          k.ma120,
          k.ma240,
          k.quote_volume_10 AS "quoteVolume10",
          k.atr_14 AS "atr14",
          k.loss_atr_14 AS "lossAtr14",
          k.low_9 AS "low9",
          k.high_9 AS "high9",
          NULL::numeric AS "sortScore"
        FROM page_symbols ps
        JOIN crypto_latest latest ON latest.symbol = ps.symbol
        JOIN klines k ON k.symbol = latest.symbol AND k.open_time = latest.max_time AND k.interval = $1
        LEFT JOIN symbols sym ON sym.symbol = ps.symbol
      ),
      a_share_latest AS (
        SELECT q.ts_code, MAX(q.trade_date) AS trade_date
        FROM raw.daily_quote q
        JOIN page_symbols ps ON ps.symbol = q.ts_code
        GROUP BY q.ts_code
      ),
      a_share_rows AS (
        SELECT
          ps.ord,
          q.ts_code AS symbol,
          s.name AS name,
          s.market,
          s.industry,
          COALESCE(q.qfq_pct_chg, q.pct_chg) AS "pctChg",
          q.amount,
          m.turnover_rate AS "turnoverRate",
          m.pe,
          m.pe_ttm AS "peTtm",
          m.pb,
          m.circ_mv AS "circMv",
          q.trade_date AS "tradeDate",
          COALESCE(
            (SELECT jsonb_agg(DISTINCT jsonb_build_object('id', w.id::text, 'name', w.name))
             FROM watchlist_items wi
             JOIN watchlists w ON w.id = wi.watchlist_id
             WHERE wi.symbol = ps.symbol),
            '[]'::jsonb
          ) AS tags,
          COALESCE(q.qfq_close, q.close) AS close,
          i.ma5,
          i.ma30,
          i.ma60,
          i.kdj_j AS "kdjJ",
          i.risk_reward_ratio AS "riskRewardRatio",
          i.stop_loss_pct AS "stopLossPct",
          to_date(q.trade_date, 'YYYYMMDD')::timestamp AS "openTime",
          i.dif,
          i.dea,
          i.macd,
          i.kdj_k AS "kdjK",
          i.kdj_d AS "kdjD",
          i.bbi,
          i.ma120,
          i.ma240,
          i.quote_volume_10 AS "quoteVolume10",
          i.atr_14 AS "atr14",
          i.loss_atr_14 AS "lossAtr14",
          i.low_9 AS "low9",
          i.high_9 AS "high9",
          ${aShareScoreSelect}
        FROM page_symbols ps
        JOIN a_share_latest latest ON latest.ts_code = ps.symbol
        JOIN raw.daily_quote q ON q.ts_code = latest.ts_code AND q.trade_date = latest.trade_date
        LEFT JOIN raw.daily_basic m ON m.ts_code = q.ts_code AND m.trade_date = q.trade_date
        LEFT JOIN raw.daily_indicator i ON i.ts_code = q.ts_code AND i.trade_date = q.trade_date
        LEFT JOIN a_share_symbols s ON s.ts_code = ps.symbol${scoreJoin}
      ),
      rows AS (
        SELECT * FROM crypto_rows
        UNION ALL
        SELECT * FROM a_share_rows
      )
      SELECT
        symbol,
        name,
        market,
        industry,
        "pctChg",
        amount,
        "turnoverRate",
        pe,
        "peTtm",
        pb,
        "circMv",
        "tradeDate",
        tags,
        close,
        ma5,
        ma30,
        ma60,
        "kdjJ",
        "riskRewardRatio",
        "stopLossPct",
        "openTime",
        dif,
        dea,
        macd,
        "kdjK",
        "kdjD",
        bbi,
        ma120,
        ma240,
        "quoteVolume10",
        "atr14",
        "lossAtr14",
        "low9",
        "high9"
      FROM rows
    `;

    const SORT_COL_MAP: Record<string, string> = {
      symbol: 'symbol',
      name: 'name',
      market: 'market',
      industry: 'industry',
      pctChg: '"pctChg"',
      amount: 'amount',
      turnoverRate: '"turnoverRate"',
      pe: 'pe',
      peTtm: '"peTtm"',
      pb: 'pb',
      circMv: '"circMv"',
      tradeDate: '"tradeDate"',
      close: 'close',
      ma5: 'ma5',
      ma30: 'ma30',
      ma60: 'ma60',
      kdjJ: '"kdjJ"',
      riskRewardRatio: '"riskRewardRatio"',
      stopLossPct: '"stopLossPct"',
      openTime: '"openTime"',
      dif: 'dif',
      dea: 'dea',
      macd: 'macd',
      kdjK: '"kdjK"',
      kdjD: '"kdjD"',
      bbi: 'bbi',
      ma120: 'ma120',
      ma240: 'ma240',
      quoteVolume10: '"quoteVolume10"',
      atr14: '"atr14"',
      lossAtr14: '"lossAtr14"',
      low9: '"low9"',
      high9: '"high9"',
      modelScore: '"sortScore"',
    };

    if (sort?.field === 'modelScore' && scoreModelVersion) {
      const dir = sort.order === 'descend' ? 'DESC' : 'ASC';
      sql += ` ORDER BY "sortScore" ${dir} NULLS LAST, symbol ASC`;
    } else if (sort?.field && SORT_COL_MAP[sort.field] && sort.field !== 'modelScore') {
      const dir = sort.order === 'descend' ? 'DESC' : 'ASC';
      sql += ` ORDER BY ${SORT_COL_MAP[sort.field]} ${dir} NULLS LAST`;
    } else {
      sql += ' ORDER BY ord ASC';
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

  private formatDate(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  async importFromIndex(
    userId: string,
    watchlistId: string,
    indexCode: string,
  ): Promise<{ imported: number; replaced: number }> {
    const w = await this.watchlistRepo.findOne({
      where: { id: watchlistId, userId } as any,
      relations: ['items'],
    });
    if (!w) throw new NotFoundException(`Watchlist ${watchlistId} not found`);

    const replaced = w.items?.length ?? 0;

    // index_weight 是月度数据，查近 2 个月以确保能覆盖最新发布的数据
    const endDate = this.formatDate(new Date());
    const startTs = new Date();
    startTs.setUTCDate(startTs.getUTCDate() - 60);
    const startDate = this.formatDate(startTs);

    const rows = await this.tushareClient.query(
      'index_weight',
      { index_code: indexCode, start_date: startDate, end_date: endDate },
      'con_code',
    );

    // 月度数据可能含多行同一成分，去重取唯一 con_code
    const conCodes = Array.from(
      new Set(rows.map((r) => String(r['con_code'] ?? '').trim()).filter(Boolean)),
    );

    if (conCodes.length === 0) {
      this.logger.warn(
        `index_weight 未返回数据：index_code=${indexCode} start=${startDate} end=${endDate}，rows=${rows.length}`,
      );
      throw new BadRequestException('未找到该指数成分数据');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(WatchlistItemEntity, { watchlistId });
      const items = conCodes.map((symbol) =>
        manager.create(WatchlistItemEntity, { watchlistId, symbol, displayOrder: 0 }),
      );
      await manager.save(WatchlistItemEntity, items);
    });

    return { imported: conCodes.length, replaced };
  }
}
