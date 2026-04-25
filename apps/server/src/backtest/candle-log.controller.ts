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
import { BacktestCandleLogEntity } from '../entities/backtest/backtest-candle-log.entity';
import { BacktestRunEntity } from '../entities/backtest/backtest-run.entity';

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
  cooldownDuration: number | null;
  cooldownRemaining: number | null;
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
  'cooldown_duration', 'cooldown_remaining',
]);

function parseUtcDateTime(raw?: string): Date | null {
  if (!raw || !raw.trim()) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const TRADE_STATE_TOKENS = new Set(['position', 'entry', 'exit']);

/** 逗号分隔；白名单去重；空串或未传视为不筛选本维度 */
function parseTradeStates(raw?: string): Array<'position' | 'entry' | 'exit'> {
  if (!raw || !raw.trim()) return [];
  const seen = new Set<string>();
  const out: Array<'position' | 'entry' | 'exit'> = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (TRADE_STATE_TOKENS.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t as 'position' | 'entry' | 'exit');
    }
  }
  return out;
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
    @Query('tradeStates') tradeStatesRaw?: string,
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
    @Query('cooldownDurationMin') cooldownDurationMinRaw?: string,
    @Query('cooldownDurationMax') cooldownDurationMaxRaw?: string,
    @Query('cooldownRemainingMin') cooldownRemainingMinRaw?: string,
    @Query('cooldownRemainingMax') cooldownRemainingMaxRaw?: string,
    @Query('isSimulation') isSimulationRaw?: string,
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
    const tradeStates = parseTradeStates(tradeStatesRaw);
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
    const cooldownDurationMin = cooldownDurationMinRaw !== undefined && cooldownDurationMinRaw !== '' ? parseInt(cooldownDurationMinRaw, 10) : null;
    const cooldownDurationMax = cooldownDurationMaxRaw !== undefined && cooldownDurationMaxRaw !== '' ? parseInt(cooldownDurationMaxRaw, 10) : null;
    const cooldownRemainingMin = cooldownRemainingMinRaw !== undefined && cooldownRemainingMinRaw !== '' ? parseInt(cooldownRemainingMinRaw, 10) : null;
    const cooldownRemainingMax = cooldownRemainingMaxRaw !== undefined && cooldownRemainingMaxRaw !== '' ? parseInt(cooldownRemainingMaxRaw, 10) : null;
    const isSimulation =
      isSimulationRaw === 'true' ? true
        : isSimulationRaw === 'false' ? false
          : null;

    // 实体别名为 cl，列名转驼峰映射
    const sortColumnMap: Record<string, string> = {
      bar_idx: 'cl.bar_idx',
      ts: 'cl.ts',
      open_equity: 'cl.open_equity',
      close_equity: 'cl.close_equity',
      pos_count: 'cl.pos_count',
      equity_change: '(cl.close_equity - cl.open_equity)',
      equity_change_pct: '(cl.close_equity - cl.open_equity) / NULLIF(cl.open_equity, 0) * 100',
      cooldown_duration: 'cl.cooldown_duration',
      cooldown_remaining: 'cl.cooldown_remaining',
    };
    const sortColumn = sortColumnMap[sortBy] ?? 'cl.bar_idx';

    const sortOrder: 'ASC' | 'DESC' =
      (sortOrderRaw ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // ── 3. 构建 QueryBuilder ──
    const qb = this.candleLogRepo
      .createQueryBuilder('cl')
      .where('cl.run_id = :runId', { runId });

    if (tradeStates.length > 0) {
      const orSql: string[] = [];
      if (tradeStates.includes('position')) {
        orSql.push('cl.pos_count > 0');
      }
      if (tradeStates.includes('entry')) {
        orSql.push(
          'jsonb_array_length(COALESCE(cl.entries_json, CAST(\'[]\' AS jsonb))) > 0',
        );
      }
      if (tradeStates.includes('exit')) {
        orSql.push(
          'jsonb_array_length(COALESCE(cl.exits_json, CAST(\'[]\' AS jsonb))) > 0',
        );
      }
      if (orSql.length > 0) {
        qb.andWhere(`(${orSql.join(' OR ')})`);
      }
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

    if (cooldownDurationMin !== null && !Number.isNaN(cooldownDurationMin)) {
      qb.andWhere('cl.cooldown_duration >= :cooldownDurationMin', { cooldownDurationMin });
    }
    if (cooldownDurationMax !== null && !Number.isNaN(cooldownDurationMax)) {
      qb.andWhere('cl.cooldown_duration <= :cooldownDurationMax', { cooldownDurationMax });
    }
    if (cooldownRemainingMin !== null && !Number.isNaN(cooldownRemainingMin)) {
      qb.andWhere('cl.cooldown_remaining >= :cooldownRemainingMin', { cooldownRemainingMin });
    }
    if (cooldownRemainingMax !== null && !Number.isNaN(cooldownRemainingMax)) {
      qb.andWhere('cl.cooldown_remaining <= :cooldownRemainingMax', { cooldownRemainingMax });
    }

    if (typeof isSimulation === 'boolean') {
      qb.andWhere(
        `cl.exits_json @> :simExit::jsonb`,
        { simExit: JSON.stringify([{ isSimulation }]) },
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
      cooldownDuration: e.cooldownDuration ?? null,
      cooldownRemaining: e.cooldownRemaining ?? null,
    }));

    return { rows, total, page, pageSize };
  }
}
