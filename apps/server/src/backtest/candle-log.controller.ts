import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BacktestCandleLogEntity } from '../entities/backtest-candle-log.entity';
import { BacktestRunEntity } from '../entities/backtest-run.entity';

/** Controller 返回给前端的单行结构 */
export interface CandleLogRow {
  barIdx: number;
  ts: string;
  openEquity: number;
  closeEquity: number;
  posCount: number;
  maxPositions: number;
  entries: unknown[];
  exits: unknown[];
  inCooldown: boolean;
}

/** 将 Date 格式化为 "YYYY-MM-DD HH:MM:SS"（UTC） */
function formatTs(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 分页响应体 */
export interface CandleLogPageResponse {
  rows: CandleLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** 允许排序的列白名单 */
const ALLOWED_SORT_BY = new Set([
  'bar_idx', 'ts', 'open_equity', 'close_equity', 'pos_count',
  'equity_change', 'equity_change_pct',
]);

function parseUtcDateTime(raw?: string): Date | null {
  if (!raw || !raw.trim()) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

@Controller('backtest/runs/:runId/candle-log')
export class CandleLogController {
  private readonly logger = new Logger(CandleLogController.name);

  constructor(
    @InjectRepository(BacktestCandleLogEntity)
    private readonly candleLogRepo: Repository<BacktestCandleLogEntity>,
    @InjectRepository(BacktestRunEntity)
    private readonly runRepo: Repository<BacktestRunEntity>,
  ) {}

  @Get()
  async getPage(
    @Param('runId') runId: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('onlyWithAction') onlyWithActionRaw?: string,
    @Query('symbol') symbol?: string,
    @Query('inCooldown') inCooldownRaw?: string,
    @Query('startTs') startTsRaw?: string,
    @Query('endTs') endTsRaw?: string,
    @Query('sortBy') sortByRaw?: string,
    @Query('sortOrder') sortOrderRaw?: string,
    @Query('equityChangeMin') equityChangeMinRaw?: string,
    @Query('equityChangeMax') equityChangeMaxRaw?: string,
    @Query('equityChangePctMin') equityChangePctMinRaw?: string,
    @Query('equityChangePctMax') equityChangePctMaxRaw?: string,
  ): Promise<CandleLogPageResponse> {
    // ── 1. 校验 run 是否存在 ──
    const run = await this.runRepo.findOneBy({ id: runId });
    if (!run) {
      throw new NotFoundException(`回测运行 ${runId} 不存在`);
    }

    // ── 2. 解析 Query 参数 ──
    const page = Math.max(1, parseInt(pageRaw ?? '1', 10) || 1);
    const pageSizeParsed = parseInt(pageSizeRaw ?? '50', 10) || 50;
    const pageSize = Math.min(200, Math.max(1, pageSizeParsed));
    const onlyWithAction = onlyWithActionRaw === 'true';
    const inCooldown =
      inCooldownRaw === 'true' ? true
        : inCooldownRaw === 'false' ? false
          : null;
    const startTs = parseUtcDateTime(startTsRaw);
    const endTs = parseUtcDateTime(endTsRaw);

    // 排序列：仅允许白名单内的值，映射到实际列名
    const sortByInput = sortByRaw ?? 'bar_idx';
    const sortBy = ALLOWED_SORT_BY.has(sortByInput) ? sortByInput : 'bar_idx';
    const equityChangeMin = equityChangeMinRaw !== undefined && equityChangeMinRaw !== '' ? parseFloat(equityChangeMinRaw) : null;
    const equityChangeMax = equityChangeMaxRaw !== undefined && equityChangeMaxRaw !== '' ? parseFloat(equityChangeMaxRaw) : null;
    const equityChangePctMin = equityChangePctMinRaw !== undefined && equityChangePctMinRaw !== '' ? parseFloat(equityChangePctMinRaw) : null;
    const equityChangePctMax = equityChangePctMaxRaw !== undefined && equityChangePctMaxRaw !== '' ? parseFloat(equityChangePctMaxRaw) : null;

    // 实体别名为 cl，列名转驼峰映射
    const sortColumnMap: Record<string, string> = {
      bar_idx: 'cl.bar_idx',
      ts: 'cl.ts',
      open_equity: 'cl.open_equity',
      close_equity: 'cl.close_equity',
      pos_count: 'cl.pos_count',
      equity_change: '(cl.close_equity - cl.open_equity)',
      equity_change_pct: '(cl.close_equity - cl.open_equity) / NULLIF(cl.open_equity, 0) * 100',
    };
    const sortColumn = sortColumnMap[sortBy] ?? 'cl.bar_idx';

    const sortOrder: 'ASC' | 'DESC' =
      (sortOrderRaw ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // ── 3. 构建 QueryBuilder ──
    const qb = this.candleLogRepo
      .createQueryBuilder('cl')
      .where('cl.run_id = :runId', { runId });

    // onlyWithAction：本根有成交事件，或收盘持仓集合相对上一根发生变化（与 symbol-metrics 仅本根有交易语义对齐）
    // 不用 leftJoin 自连接：TypeORM 0.3 在 getManyAndCount + orderBy 时会对多余 join 别名取 metadata 触发 databaseName 空引用
    if (onlyWithAction) {
      qb.andWhere(
        `(jsonb_array_length(COALESCE(cl.entries_json, CAST('[]' AS jsonb))) > 0
          OR jsonb_array_length(COALESCE(cl.exits_json, CAST('[]' AS jsonb))) > 0
          OR (
            COALESCE(cl.open_symbols_json, CAST('[]' AS jsonb))
            IS DISTINCT FROM COALESCE(
              (
                SELECT prev.open_symbols_json
                FROM backtest_candle_logs prev
                WHERE prev.run_id = cl.run_id AND prev.bar_idx = cl.bar_idx - 1
                LIMIT 1
              ),
              CAST('[]' AS jsonb)
            )
          ))`,
      );
    }

    // symbol 过滤：entries 或 exits 中含有该 symbol
    if (symbol && symbol.trim()) {
      const sym = symbol.trim();
      qb.andWhere(
        `(cl.entries_json @> :symEntries::jsonb OR cl.exits_json @> :symExits::jsonb)`,
        {
          symEntries: JSON.stringify([{ symbol: sym }]),
          symExits: JSON.stringify([{ symbol: sym }]),
        },
      );
    }

    if (typeof inCooldown === 'boolean') {
      qb.andWhere('cl.in_cooldown = :inCooldown', { inCooldown });
    }

    if (startTs) {
      qb.andWhere('cl.ts >= :startTs', { startTs });
    }

    if (endTs) {
      qb.andWhere('cl.ts <= :endTs', { endTs });
    }

    if (equityChangeMin !== null && !Number.isNaN(equityChangeMin)) {
      qb.andWhere('(cl.close_equity - cl.open_equity) >= :equityChangeMin', { equityChangeMin });
    }
    if (equityChangeMax !== null && !Number.isNaN(equityChangeMax)) {
      qb.andWhere('(cl.close_equity - cl.open_equity) <= :equityChangeMax', { equityChangeMax });
    }
    if (equityChangePctMin !== null && !Number.isNaN(equityChangePctMin)) {
      qb.andWhere(
        '(cl.close_equity - cl.open_equity) / NULLIF(cl.open_equity, 0) * 100 >= :equityChangePctMin',
        { equityChangePctMin },
      );
    }
    if (equityChangePctMax !== null && !Number.isNaN(equityChangePctMax)) {
      qb.andWhere(
        '(cl.close_equity - cl.open_equity) / NULLIF(cl.open_equity, 0) * 100 <= :equityChangePctMax',
        { equityChangePctMax },
      );
    }

    // 分页 + 排序
    qb.orderBy(sortColumn, sortOrder)
      .skip((page - 1) * pageSize)
      .take(pageSize);

    // ── 4. 执行查询 ──
    let entities: BacktestCandleLogEntity[];
    let total: number;

    try {
      [entities, total] = await qb.getManyAndCount();
    } catch (err) {
      const e = err as Error;
      this.logger.error(`查询 candle-log 失败 runId=${runId}: ${e.message}`, e.stack);
      throw err;
    }

    // ── 5. 映射为响应行（numeric 列转 number） ──
    const rows: CandleLogRow[] = entities.map((e) => ({
      barIdx: e.barIdx,
      ts: formatTs(e.ts),
      openEquity: parseFloat(e.openEquity),
      closeEquity: parseFloat(e.closeEquity),
      posCount: e.posCount,
      maxPositions: e.maxPositions,
      entries: e.entriesJson,
      exits: e.exitsJson,
      inCooldown: e.inCooldown,
    }));

    return { rows, total, page, pageSize };
  }
}
