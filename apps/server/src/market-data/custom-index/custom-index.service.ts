import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { SseTokenService } from '../../modules/quant/services/sse-token.service';
import { calcMacd, calcZdf } from '../active-mv/amv-formula';
import type { AmvSignal } from '../active-mv/active-mv.types';
import { CustomIndexDefinitionEntity } from '../../entities/custom-index/custom-index-definition.entity';
import { CustomIndexWeightVersionEntity } from '../../entities/custom-index/custom-index-weight-version.entity';
import { CustomIndexMemberEntity } from '../../entities/custom-index/custom-index-member.entity';
import { CustomIndexComputeService } from './custom-index-compute.service';
import type { CreateCustomIndexBody } from './dto/create-custom-index.dto';
import type { UpdateCustomIndexBody } from './dto/update-custom-index.dto';
import type { PreviewWeightsBody } from './dto/create-custom-index.dto';
import type { QueryCustomIndexLatestDto } from './dto/custom-index-latest.dto';
import type {
  CustomIndexAmvRow,
  CustomIndexDetail,
  CustomIndexKlineRow,
  CustomIndexLatestResult,
  CustomIndexMemberRow,
  CustomIndexMoneyFlowRow,
  MemberInput,
} from './custom-index.types';
import {
  assertWeightSum,
  generateCustomIndexTsCode,
  membersEqual,
} from './custom-index.types';

interface CircMvRow {
  ts_code: string;
  circ_mv: string | number | null;
}

interface NameRow {
  ts_code: string;
  name: string | null;
}

interface LatestRawRow {
  id: string;
  tsCode: string;
  name: string;
  tradeDate: string | null;
  close: string | number | null;
  pctChange: string | number | null;
  vol: string | number | null;
  amount: string | number | null;
  count: string | number | null;
  status: string;
  computeProgress: string | number | null;
  indexType: string;
  weightMethod: string;
  baseDate: string;
  basePoint: string | number;
  actualStartDate: string | null;
  netAmount: string | number | null;
  netAmount5d: string | number | null;
  netAmount10d: string | number | null;
  netAmount20d: string | number | null;
  buyLgAmount: string | number | null;
  buyMdAmount: string | number | null;
  buySmAmount: string | number | null;
}

const SORT_COL_MAP: Record<string, string> = {
  close: '"close"',
  pctChange: '"pctChange"',
  vol: '"vol"',
  amount: 'amount',
  tradeDate: '"tradeDate"',
  count: 'count',
  netAmount: '"netAmount"',
  netAmount5d: '"netAmount5d"',
  netAmount10d: '"netAmount10d"',
  netAmount20d: '"netAmount20d"',
  updatedAt: '"updatedAt"',
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

@Injectable()
export class CustomIndexService {
  private readonly logger = new Logger(CustomIndexService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(CustomIndexDefinitionEntity)
    private readonly definitionRepo: Repository<CustomIndexDefinitionEntity>,
    @InjectRepository(CustomIndexWeightVersionEntity)
    private readonly versionRepo: Repository<CustomIndexWeightVersionEntity>,
    @InjectRepository(CustomIndexMemberEntity)
    private readonly memberRepo: Repository<CustomIndexMemberEntity>,
    private readonly computeService: CustomIndexComputeService,
    private readonly sseTokens: SseTokenService,
  ) {}

  async getLatest(userId: string, dto: QueryCustomIndexLatestDto): Promise<CustomIndexLatestResult> {
    const q = dto.q ?? null;
    const sortField = dto.sort ?? 'pctChange';
    const order = dto.order === 'asc' ? 'ASC' : 'DESC';
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const sortCol = SORT_COL_MAP[sortField] ?? SORT_COL_MAP.pctChange;

    const params: unknown[] = [userId];
    let qFilter = '';
    if (q) {
      params.push(`%${q}%`);
      qFilter = ` AND (d.name ILIKE $${params.length} OR d.ts_code ILIKE $${params.length})`;
    }

    const countRows = await this.dataSource.query<{ cnt: string }[]>(
      `SELECT COUNT(*)::text AS cnt FROM custom_index_definitions d WHERE d.user_id = $1${qFilter}`,
      params,
    );
    const total = Number(countRows[0]?.cnt ?? 0);

    params.push(pageSize, offset);
    const rows = await this.dataSource.query<LatestRawRow[]>(
      `WITH active_ver AS (
         SELECT DISTINCT ON (v.custom_index_id)
           v.custom_index_id, v.id AS version_id, v.weight_method
         FROM custom_index_weight_versions v
         WHERE v.expire_date IS NULL
         ORDER BY v.custom_index_id, v.effective_date DESC
       ),
       member_cnt AS (
         SELECT m.version_id, COUNT(*)::int AS cnt
         FROM custom_index_members m
         GROUP BY m.version_id
       ),
       latest_quote AS (
         SELECT DISTINCT ON (q.custom_index_id)
           q.custom_index_id, q.trade_date, q.close, q.pct_change, q.vol_hand, q.amount
         FROM custom_index_daily_quotes q
         ORDER BY q.custom_index_id, q.trade_date DESC
       ),
       start_date AS (
         SELECT custom_index_id, MIN(trade_date) AS actual_start
         FROM custom_index_daily_quotes
         GROUP BY custom_index_id
       ),
       mf_roll AS (
         SELECT
           mf.custom_index_id,
           mf.trade_date,
           mf.net_amount,
           mf.buy_lg_amount,
           mf.buy_md_amount,
           mf.buy_sm_amount,
           SUM(mf.net_amount) OVER (
             PARTITION BY mf.custom_index_id ORDER BY mf.trade_date
             ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
           ) AS net_5d,
           SUM(mf.net_amount) OVER (
             PARTITION BY mf.custom_index_id ORDER BY mf.trade_date
             ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
           ) AS net_10d,
           SUM(mf.net_amount) OVER (
             PARTITION BY mf.custom_index_id ORDER BY mf.trade_date
             ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
           ) AS net_20d
         FROM custom_index_money_flow mf
       ),
       latest_mf AS (
         SELECT DISTINCT ON (r.custom_index_id)
           r.custom_index_id, r.net_amount, r.net_5d, r.net_10d, r.net_20d,
           r.buy_lg_amount, r.buy_md_amount, r.buy_sm_amount
         FROM mf_roll r
         ORDER BY r.custom_index_id, r.trade_date DESC
       )
       SELECT
         d.id AS id,
         d.ts_code AS "tsCode",
         d.name AS name,
         lq.trade_date AS "tradeDate",
         lq.close AS close,
         lq.pct_change AS "pctChange",
         lq.vol_hand AS vol,
         lq.amount AS amount,
         mc.cnt AS count,
         d.status AS status,
         d.compute_progress AS "computeProgress",
         d.index_type AS "indexType",
         COALESCE(av.weight_method, d.weight_method) AS "weightMethod",
         d.base_date AS "baseDate",
         d.base_point AS "basePoint",
         sd.actual_start AS "actualStartDate",
         lm.net_amount AS "netAmount",
         lm.net_5d AS "netAmount5d",
         lm.net_10d AS "netAmount10d",
         lm.net_20d AS "netAmount20d",
         lm.buy_lg_amount AS "buyLgAmount",
         lm.buy_md_amount AS "buyMdAmount",
         lm.buy_sm_amount AS "buySmAmount",
         d.updated_at AS "updatedAt"
       FROM custom_index_definitions d
       LEFT JOIN active_ver av ON av.custom_index_id = d.id
       LEFT JOIN member_cnt mc ON mc.version_id = av.version_id
       LEFT JOIN latest_quote lq ON lq.custom_index_id = d.id
       LEFT JOIN start_date sd ON sd.custom_index_id = d.id
       LEFT JOIN latest_mf lm ON lm.custom_index_id = d.id
       WHERE d.user_id = $1${qFilter}
       ORDER BY ${sortCol} ${order} NULLS LAST, d.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: rows.map((r) => ({
        id: r.id,
        tsCode: r.tsCode,
        name: r.name,
        category: 'custom' as const,
        tradeDate: r.tradeDate,
        close: nullableNum(r.close),
        pctChange: nullableNum(r.pctChange),
        vol: nullableNum(r.vol),
        amount: nullableNum(r.amount),
        count: nullableNum(r.count),
        status: r.status as CustomIndexDetail['status'],
        computeProgress: nullableNum(r.computeProgress),
        indexType: r.indexType as CustomIndexDetail['indexType'],
        weightMethod: r.weightMethod as CustomIndexDetail['weightMethod'],
        baseDate: r.baseDate,
        basePoint: num(r.basePoint),
        actualStartDate: r.actualStartDate,
        netAmount: nullableNum(r.netAmount),
        netAmount5d: nullableNum(r.netAmount5d),
        netAmount10d: nullableNum(r.netAmount10d),
        netAmount20d: nullableNum(r.netAmount20d),
        buyLgAmount: nullableNum(r.buyLgAmount),
        buyMdAmount: nullableNum(r.buyMdAmount),
        buySmAmount: nullableNum(r.buySmAmount),
      })),
      total,
    };
  }

  async getDetail(userId: string, id: string): Promise<CustomIndexDetail> {
    const def = await this.requireOwnedDefinition(userId, id);
    const members = await this.getActiveMembers(def.id);
    return this.toDetail(def, members);
  }

  async getMembers(
    userId: string,
    id: string,
    asOfDate?: string,
  ): Promise<{ members: CustomIndexMemberRow[] }> {
    await this.requireOwnedDefinition(userId, id);
    const members = asOfDate
      ? await this.getPitMembers(id, asOfDate)
      : await this.getActiveMembers(id);
    return { members };
  }

  async previewWeights(body: PreviewWeightsBody): Promise<{ members: Array<{ con_code: string; name: string | null; weight: number }> }> {
    const conCodes = body.members.map((m) => m.con_code);
    const weights = await this.resolveWeights(body.weight_method, conCodes, body.effective_date, body.members);
    const names = await this.loadStockNames(conCodes);
    return {
      members: conCodes.map((code, i) => ({
        con_code: code,
        name: names.get(code) ?? null,
        weight: weights[i],
      })),
    };
  }

  async create(userId: string, body: CreateCustomIndexBody): Promise<{ id: string; ts_code: string; status: string }> {
    await this.assertOpenTradeDate(body.base_date);

    const tsCode = generateCustomIndexTsCode();
    const conCodes = body.members.map((m) => m.con_code);
    const weights = await this.resolveWeights(body.weight_method, conCodes, body.effective_date, body.members);

    let definitionId = '';

    await this.dataSource.transaction(async (manager) => {
      const def = manager.create(CustomIndexDefinitionEntity, {
        userId,
        tsCode,
        name: body.name,
        description: body.description ?? null,
        indexType: body.index_type,
        baseDate: body.base_date,
        basePoint: String(body.base_point ?? 1000),
        weightMethod: body.weight_method,
        status: 'pending',
      });
      const savedDef = await manager.save(CustomIndexDefinitionEntity, def);
      definitionId = savedDef.id;

      const version = manager.create(CustomIndexWeightVersionEntity, {
        customIndexId: savedDef.id,
        effectiveDate: body.effective_date,
        expireDate: null,
        weightMethod: body.weight_method,
      });
      const savedVer = await manager.save(CustomIndexWeightVersionEntity, version);

      const memberRows = conCodes.map((code, i) =>
        manager.create(CustomIndexMemberEntity, {
          versionId: savedVer.id,
          conCode: code,
          weight: String(weights[i]),
        }),
      );
      await manager.save(CustomIndexMemberEntity, memberRows);
    });

    if (
      !this.computeService.scheduleCompute({
        customIndexId: definitionId,
        userId,
        fullRebuild: true,
      })
    ) {
      throw new ConflictException('指数正在计算中');
    }

    return { id: definitionId, ts_code: tsCode, status: 'pending' };
  }

  async update(userId: string, id: string, body: UpdateCustomIndexBody): Promise<{ id: string; status: string }> {
    const def = await this.requireOwnedDefinition(userId, id);

    if (def.status === 'computing') {
      throw new ConflictException('指数正在计算中，请稍后再试');
    }

    const metaOnly =
      body.members === undefined &&
      body.weight_method === undefined &&
      body.effective_date === undefined &&
      body.index_type === undefined;

    if (metaOnly) {
      if (body.name !== undefined) def.name = body.name;
      if (body.description !== undefined) def.description = body.description;
      await this.definitionRepo.save(def);
      return { id: def.id, status: def.status };
    }

    const activeVersion = await this.getActiveVersion(def.id);
    if (!activeVersion) {
      throw new BadRequestException('无 active 权重版本');
    }

    const currentMembers = await this.memberRepo.find({ where: { versionId: activeVersion.id } });
    const newWeightMethod = body.weight_method ?? activeVersion.weightMethod;
    const newMembersInput = body.members ?? currentMembers.map((m) => ({ con_code: m.conCode }));
    const conCodes = newMembersInput.map((m) => m.con_code);
    const effectiveDate = body.effective_date ?? activeVersion.effectiveDate;

    const indexTypeChanged = body.index_type !== undefined && body.index_type !== def.indexType;
    const weightMethodChanged = newWeightMethod !== activeVersion.weightMethod;

    const resolvedWeights = await this.resolveWeights(
      newWeightMethod,
      conCodes,
      effectiveDate,
      newMembersInput,
    );
    const newMemberRows = conCodes.map((code, i) => ({
      conCode: code,
      weight: String(resolvedWeights[i]),
    }));

    const sameMembers =
      !indexTypeChanged &&
      !weightMethodChanged &&
      membersEqual(currentMembers, newMemberRows) &&
      effectiveDate === activeVersion.effectiveDate;

    if (sameMembers) {
      throw new BadRequestException('成分与权重无变化');
    }

    if (effectiveDate !== activeVersion.effectiveDate) {
      await this.assertRebalanceEffectiveDate(effectiveDate);
    }

    if (body.name !== undefined) def.name = body.name;
    if (body.description !== undefined) def.description = body.description;
    if (body.index_type !== undefined) def.indexType = body.index_type;
    def.weightMethod = newWeightMethod;
    await this.definitionRepo.save(def);

    await this.dataSource.transaction(async (manager) => {
      if (effectiveDate !== activeVersion.effectiveDate) {
        const prevTradeDate = await this.getPrevTradeDate(effectiveDate);
        await manager.update(
          CustomIndexWeightVersionEntity,
          { id: activeVersion.id },
          { expireDate: prevTradeDate },
        );
      } else {
        // 同日覆盖：删除旧 version 成员后重建同一 version（简化：expire 旧版建新 version 同日）
        await manager.delete(CustomIndexMemberEntity, { versionId: activeVersion.id });
        const memberEntities = newMemberRows.map((m) =>
          manager.create(CustomIndexMemberEntity, {
            versionId: activeVersion.id,
            conCode: m.conCode,
            weight: m.weight,
          }),
        );
        await manager.save(CustomIndexMemberEntity, memberEntities);
        return;
      }

      const version = manager.create(CustomIndexWeightVersionEntity, {
        customIndexId: def.id,
        effectiveDate,
        expireDate: null,
        weightMethod: newWeightMethod,
      });
      const savedVer = await manager.save(CustomIndexWeightVersionEntity, version);
      const memberEntities = newMemberRows.map((m) =>
        manager.create(CustomIndexMemberEntity, {
          versionId: savedVer.id,
          conCode: m.conCode,
          weight: m.weight,
        }),
      );
      await manager.save(CustomIndexMemberEntity, memberEntities);
    });

    if (
      !this.computeService.scheduleCompute({
        customIndexId: def.id,
        userId,
        fullRebuild: indexTypeChanged,
      })
    ) {
      throw new ConflictException('指数正在计算中');
    }

    return { id: def.id, status: 'pending' };
  }

  async remove(userId: string, id: string): Promise<{ ok: true }> {
    const def = await this.requireOwnedDefinition(userId, id);
    if (def.status === 'computing') {
      throw new ConflictException('指数正在计算中，请稍后再试');
    }
    await this.definitionRepo.delete({ id: def.id, userId });
    return { ok: true };
  }

  async recompute(userId: string, id: string): Promise<{ status: string }> {
    const def = await this.requireOwnedDefinition(userId, id);
    if (def.status === 'computing') {
      throw new ConflictException('指数正在计算中');
    }
    if (
      !this.computeService.scheduleCompute({
        customIndexId: def.id,
        userId,
        fullRebuild: true,
      })
    ) {
      throw new ConflictException('指数正在计算中');
    }
    return { status: 'pending' };
  }

  async getKline(
    userId: string,
    id: string,
    startDate: string,
    endDate: string,
  ): Promise<CustomIndexKlineRow[]> {
    await this.requireOwnedDefinition(userId, id);

    const rows = await this.dataSource.query<
      Array<{
        tradeDate: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volHand: number;
        ma5: number | null;
        ma30: number | null;
        ma60: number | null;
        ma120: number | null;
        ma240: number | null;
        dif: number | null;
        dea: number | null;
        macd: number | null;
        kdjK: number | null;
        kdjD: number | null;
        kdjJ: number | null;
        bbi: number | null;
        brick: number | null;
        brickDelta: number | null;
        brickXg: boolean | null;
      }>
    >(
      `SELECT
          q.trade_date AS "tradeDate",
          q.open, q.high, q.low, q.close,
          q.vol_hand AS "volHand",
          i.ma5, i.ma30, i.ma60, i.ma120, i.ma240,
          i.dif, i.dea, i.macd,
          i.kdj_k AS "kdjK", i.kdj_d AS "kdjD", i.kdj_j AS "kdjJ",
          i.bbi, i.brick, i.brick_delta AS "brickDelta", i.brick_xg AS "brickXg"
        FROM custom_index_daily_quotes q
        LEFT JOIN custom_index_daily_indicators i
          ON i.custom_index_id = q.custom_index_id AND i.trade_date = q.trade_date
        WHERE q.custom_index_id = $1
          AND q.trade_date >= $2 AND q.trade_date <= $3
        ORDER BY q.trade_date ASC`,
      [id, startDate, endDate],
    );

    return rows.map((r) => {
      const brick = nullableNum(r.brick);
      const brickDelta = nullableNum(r.brickDelta);
      return {
        open_time: r.tradeDate,
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        close: num(r.close),
        volume: num(r.volHand) * 100,
        MA5: nullableNum(r.ma5),
        MA30: nullableNum(r.ma30),
        MA60: nullableNum(r.ma60),
        MA120: nullableNum(r.ma120),
        MA240: nullableNum(r.ma240),
        'KDJ.K': nullableNum(r.kdjK),
        'KDJ.D': nullableNum(r.kdjD),
        'KDJ.J': nullableNum(r.kdjJ),
        DIF: nullableNum(r.dif),
        DEA: nullableNum(r.dea),
        MACD: nullableNum(r.macd),
        BBI: nullableNum(r.bbi),
        brickChart:
          brick == null || brickDelta == null
            ? undefined
            : { brick, delta: brickDelta, xg: r.brickXg === true },
      };
    });
  }

  async getAmv(
    userId: string,
    id: string,
    startDate?: string,
    endDate?: string,
  ): Promise<CustomIndexAmvRow[]> {
    await this.requireOwnedDefinition(userId, id);

    const params: unknown[] = [id];
    let dateFilter = '';
    if (startDate) {
      params.push(startDate);
      dateFilter += ` AND a.trade_date >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      dateFilter += ` AND a.trade_date <= $${params.length}`;
    }

    const rows = await this.dataSource.query<
      Array<{
        tradeDate: string;
        amv: number | null;
      }>
    >(
      `SELECT
          a.trade_date AS "tradeDate",
          a.amv
        FROM custom_index_amv a
        WHERE a.custom_index_id = $1${dateFilter}
        ORDER BY a.trade_date ASC`,
      params,
    );

    const amvClose = rows.map((r) => nullableNum(r.amv) ?? NaN);
    const macd = calcMacd(amvClose, 12, 26, 9);
    const zdf = calcZdf(amvClose);

    return rows
      .map((r, i): CustomIndexAmvRow | null => {
        const c = amvClose[i];
        if (c == null || !Number.isFinite(c) || c <= 0) return null;
        return {
          tradeDate: r.tradeDate,
          amvOpen: c,
          amvHigh: c,
          amvLow: c,
          amvClose: c,
          amvDif: macd.dif[i] ?? NaN,
          amvDea: macd.dea[i] ?? NaN,
          amvMacd: macd.macd[i] ?? NaN,
          amvZdf: zdf[i],
          signal: 0 as AmvSignal,
        };
      })
      .filter((r): r is CustomIndexAmvRow => r != null);
  }

  /**
   * 查询自定义指数资金净流入时序。
   * custom_index_money_flow 表存万元，÷10000 转亿元（与 MoneyFlowService.toYi 一致）。
   */
  async getMoneyFlow(
    userId: string,
    id: string,
    startDate?: string,
    endDate?: string,
  ): Promise<CustomIndexMoneyFlowRow[]> {
    await this.requireOwnedDefinition(userId, id);

    const params: unknown[] = [id];
    let dateFilter = '';
    if (startDate) {
      params.push(startDate);
      dateFilter += ` AND mf.trade_date >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      dateFilter += ` AND mf.trade_date <= $${params.length}`;
    }

    const rows = await this.dataSource.query<
      Array<{
        tradeDate: string;
        netAmount: number | null;
        buyLgAmount: number | null;
        buyMdAmount: number | null;
        buySmAmount: number | null;
      }>
    >(
      `SELECT
          mf.trade_date AS "tradeDate",
          mf.net_amount AS "netAmount",
          mf.buy_lg_amount AS "buyLgAmount",
          mf.buy_md_amount AS "buyMdAmount",
          mf.buy_sm_amount AS "buySmAmount"
        FROM custom_index_money_flow mf
        WHERE mf.custom_index_id = $1${dateFilter}
        ORDER BY mf.trade_date ASC`,
      params,
    );

    return rows.map((r): CustomIndexMoneyFlowRow => {
      const net = nullableNum(r.netAmount);
      const lg = nullableNum(r.buyLgAmount);
      const md = nullableNum(r.buyMdAmount);
      const sm = nullableNum(r.buySmAmount);
      return {
        tradeDate: r.tradeDate,
        netAmount: net != null ? net / 10000 : null,
        buyLgAmount: lg != null ? lg / 10000 : null,
        buyMdAmount: md != null ? md / 10000 : null,
        buySmAmount: sm != null ? sm / 10000 : null,
      };
    });
  }

  async issueSseToken(
    userId: string,
    customIndexId: string,
  ): Promise<{ token: string; expires_at: string; custom_index_id: string }> {
    await this.requireOwnedDefinition(userId, customIndexId);
    const issued = this.sseTokens.issueCustomIndexToken(customIndexId, userId);
    return {
      token: issued.token,
      expires_at: formatUtcWallClock(issued.expiresAt),
      custom_index_id: customIndexId,
    };
  }

  /** SSE 流用：读取 definition 进度快照 */
  async getComputeSnapshot(userId: string, customIndexId: string) {
    const def = await this.requireOwnedDefinition(userId, customIndexId);
    return {
      custom_index_id: def.id,
      status: def.status,
      progress: def.computeProgress ?? 0,
      stage: def.computeStage,
      last_error: def.lastError,
    };
  }

  private async requireOwnedDefinition(userId: string, id: string): Promise<CustomIndexDefinitionEntity> {
    const def = await this.definitionRepo.findOne({ where: { id, userId } });
    if (!def) throw new NotFoundException('自定义指数不存在');
    return def;
  }

  private async getActiveVersion(customIndexId: string): Promise<CustomIndexWeightVersionEntity | null> {
    return this.versionRepo.findOne({
      where: { customIndexId, expireDate: IsNull() },
      order: { effectiveDate: 'DESC' },
    });
  }

  private async getActiveMembers(customIndexId: string): Promise<CustomIndexMemberRow[]> {
    const version = await this.getActiveVersion(customIndexId);
    if (!version) return [];
    return this.loadMemberRows(version.id);
  }

  private async getPitMembers(customIndexId: string, asOfDate: string): Promise<CustomIndexMemberRow[]> {
    const rows = await this.dataSource.query<{ version_id: string }[]>(
      `SELECT v.id AS version_id
         FROM custom_index_weight_versions v
        WHERE v.custom_index_id = $1
          AND v.effective_date <= $2
          AND (v.expire_date IS NULL OR v.expire_date >= $2)
        ORDER BY v.effective_date DESC
        LIMIT 1`,
      [customIndexId, asOfDate],
    );
    if (!rows[0]) return [];
    return this.loadMemberRows(rows[0].version_id);
  }

  private async loadMemberRows(versionId: string): Promise<CustomIndexMemberRow[]> {
    const members = await this.memberRepo.find({ where: { versionId }, order: { conCode: 'ASC' } });
    const names = await this.loadStockNames(members.map((m) => m.conCode));
    return members.map((m) => ({
      conCode: m.conCode,
      name: names.get(m.conCode) ?? null,
      weight: num(m.weight),
    }));
  }

  private async loadStockNames(codes: string[]): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    if (codes.length === 0) return map;
    const rows = await this.dataSource.query<NameRow[]>(
      `SELECT ts_code, name FROM a_share_symbols WHERE ts_code = ANY($1)`,
      [codes],
    );
    for (const r of rows) map.set(r.ts_code, r.name);
    return map;
  }

  private async resolveWeights(
    method: string,
    conCodes: string[],
    effectiveDate: string,
    inputs: MemberInput[],
  ): Promise<number[]> {
    if (method === 'equal') {
      const w = 1 / conCodes.length;
      return conCodes.map(() => w);
    }
    if (method === 'custom') {
      const weights = inputs.map((m) => {
        if (m.weight === undefined) {
          throw new BadRequestException('custom 权重缺失');
        }
        return m.weight;
      });
      try {
        assertWeightSum(weights);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      return weights;
    }
    // float_mv
    const rows = await this.dataSource.query<CircMvRow[]>(
      `SELECT DISTINCT ON (db.ts_code)
          db.ts_code,
          db.circ_mv
        FROM raw.daily_basic db
        WHERE db.ts_code = ANY($1)
          AND db.trade_date <= $2
        ORDER BY db.ts_code, db.trade_date DESC`,
      [conCodes, effectiveDate],
    );
    const mvMap = new Map(rows.map((r) => [r.ts_code, num(r.circ_mv)]));
    const mvs = conCodes.map((c) => mvMap.get(c) ?? 0);
    const total = mvs.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      throw new BadRequestException(`effective_date=${effectiveDate} 无可用流通市值数据`);
    }
    return mvs.map((v) => v / total);
  }

  private async assertOpenTradeDate(date: string): Promise<void> {
    const rows = await this.dataSource.query<{ ok: number }[]>(
      `SELECT 1 AS ok FROM raw.trade_cal
        WHERE exchange = 'SSE' AND cal_date = $1 AND is_open = 1`,
      [date],
    );
    if (!rows[0]) {
      throw new UnprocessableEntityException(`base_date=${date} 非 SSE 交易日`);
    }
  }

  private async assertRebalanceEffectiveDate(effectiveDate: string): Promise<void> {
    const today = formatYmdUtc(new Date());
    const nextTrade = await this.getNextTradeDateOnOrAfter(today);
    if (!nextTrade || effectiveDate < nextTrade) {
      throw new BadRequestException(`调仓 effective_date 须 ≥ 下一交易日 ${nextTrade ?? '(未知)'}`);
    }
  }

  private async getNextTradeDateOnOrAfter(fromDate: string): Promise<string | null> {
    const rows = await this.dataSource.query<{ cal_date: string }[]>(
      `SELECT cal_date FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1 AND cal_date >= $1
        ORDER BY cal_date ASC LIMIT 1`,
      [fromDate],
    );
    return rows[0]?.cal_date ?? null;
  }

  private async getPrevTradeDate(beforeDate: string): Promise<string | null> {
    const rows = await this.dataSource.query<{ cal_date: string }[]>(
      `SELECT cal_date FROM raw.trade_cal
        WHERE exchange = 'SSE' AND is_open = 1 AND cal_date < $1
        ORDER BY cal_date DESC LIMIT 1`,
      [beforeDate],
    );
    return rows[0]?.cal_date ?? null;
  }

  private toDetail(def: CustomIndexDefinitionEntity, members: CustomIndexMemberRow[]): CustomIndexDetail {
    return {
      id: def.id,
      tsCode: def.tsCode,
      name: def.name,
      description: def.description,
      indexType: def.indexType,
      baseDate: def.baseDate,
      basePoint: num(def.basePoint),
      weightMethod: def.weightMethod,
      status: def.status,
      computeProgress: def.computeProgress,
      computeStage: def.computeStage,
      lastError: def.lastError,
      createdAt: formatUtcWallClock(def.createdAt),
      updatedAt: formatUtcWallClock(def.updatedAt),
      members,
    };
  }
}

function formatYmdUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
