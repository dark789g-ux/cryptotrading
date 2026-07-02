/**
 * ETF 资金净流入 service。
 *
 * 由 ETF 成分股 money_flow_stocks 按日聚合，**逐日 PIT 匹配当日 PCF 成分股**
 * （不复用跨全部交易日的成分股并集，避免季度调样时跨期串成分股）。
 *
 * 复用 custom-index/compute 的：
 *  - aggregateMoneyFlowFromRows（纯函数，内部 resolvePitMembers 逐日 PIT）
 *  - allMemberCodes（成分股并集，用于拉 money_flow_stocks）
 * 落 money_flow_etf（同构 money_flow_industries）。
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MoneyFlowEtfEntity } from '../../entities/money-flow/money-flow-etf.entity';
import { EtfPcfEntity } from '../../entities/raw/etf-pcf.entity';
import { EtfSymbolEntity } from '../../entities/raw/etf-symbol.entity';
import { aggregateMoneyFlowFromRows } from '../custom-index/compute/custom-index-money-flow.service';
import type { MoneyFlowByDateCode } from '../custom-index/compute/custom-index-money-flow.service';
import { allMemberCodes } from '../custom-index/compute/custom-index-weight-resolver';
import type {
  CustomIndexMoneyFlowRow,
  MemberWeight,
  WeightVersion,
} from '../custom-index/compute/custom-index-compute.types';
import type { EtfSyncErrorItem, EtfSyncResult } from './etf.types';

export interface MoneyFlowStockDbRow {
  ts_code: string;
  trade_date: string;
  net_amount: string | number | null;
  buy_lg_amount: string | number | null;
  buy_md_amount: string | number | null;
  buy_sm_amount: string | number | null;
}

interface PcfMemberRow {
  trade_date: string;
  con_code: string;
}

function parseFlowAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

/**
 * 把 ETF PCF 成分股清单构造成 PIT 版本链：每个有 PCF 的交易日一份版本，
 * effectiveDate = 该交易日，members = 当日成分股（等权，MF 聚合只用 conCode 不用权重）。
 *
 * resolvePitMembers(versions, D) 取 effectiveDate <= D 的最新版本，即「最近一份 PCF」，
 * 符合 PIT 语义：D 当日只能看到当日及之前的成分股清单，绝不纳入未来调样后的成分股。
 *
 * pcfRows 须已按 trade_date ASC 排序（本 service 查询即如此）；此处再防御性 sort 一次。
 */
export function buildPcfWeightVersions(
  pcfRows: ReadonlyArray<PcfMemberRow>,
): WeightVersion[] {
  const byDate = new Map<string, Set<string>>();
  for (const row of pcfRows) {
    if (!row.con_code || !row.trade_date) continue;
    let set = byDate.get(row.trade_date);
    if (!set) {
      set = new Set<string>();
      byDate.set(row.trade_date, set);
    }
    set.add(row.con_code);
  }
  const dates = [...byDate.keys()].sort();
  return dates.map((d, i) => {
    const members: MemberWeight[] = [...(byDate.get(d) ?? [])].map((conCode) => ({
      conCode,
      weight: 1,
    }));
    return {
      id: i + 1,
      effectiveDate: d,
      expireDate: null,
      weightMethod: 'equal',
      members,
    };
  });
}

/** 把 money_flow_stocks 行聚合成 flowByDateCode[tradeDate][tsCode]。 */
export function buildFlowByDateCode(
  flowRows: ReadonlyArray<MoneyFlowStockDbRow>,
): Record<string, Record<string, MoneyFlowByDateCode>> {
  const map: Record<string, Record<string, MoneyFlowByDateCode>> = {};
  for (const row of flowRows) {
    const td = String(row.trade_date);
    const code = String(row.ts_code);
    if (!map[td]) map[td] = {};
    map[td][code] = {
      netAmount: parseFlowAmount(row.net_amount),
      buyLgAmount: parseFlowAmount(row.buy_lg_amount),
      buyMdAmount: parseFlowAmount(row.buy_md_amount),
      buySmAmount: parseFlowAmount(row.buy_sm_amount),
    };
  }
  return map;
}

/** 聚合输出（number）→ entity（numeric 列用 string）。 */
export function mfRowsToEntities(
  tsCode: string,
  aggregated: ReadonlyArray<CustomIndexMoneyFlowRow>,
): Partial<MoneyFlowEtfEntity>[] {
  return aggregated.map((r) => ({
    tsCode,
    tradeDate: r.tradeDate,
    netAmount: r.netAmount !== null ? String(r.netAmount) : null,
    buyLgAmount: r.buyLgAmount !== null ? String(r.buyLgAmount) : null,
    buyMdAmount: r.buyMdAmount !== null ? String(r.buyMdAmount) : null,
    buySmAmount: r.buySmAmount !== null ? String(r.buySmAmount) : null,
  }));
}

@Injectable()
export class EtfMfService {
  private readonly logger = new Logger(EtfMfService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 同步 ETF 资金净流入。
   * 对每只有 PCF 成分股的 ETF 逐日 PIT 聚合 money_flow_stocks。
   *
   * syncMode 仅作日志标识（与一键同步 ctx.syncMode 对齐 API）。
   * 本 service 内部用 INSERT ... ON CONFLICT DO UPDATE 全量 upsert（无 trade_date 跳过逻辑），
   * 故 syncMode='overwrite' 与 'incremental' 行为等价（每次都全量重写）。
   */
  async sync(
    etfCodes: string[],
    startDate: string,
    endDate: string,
    syncMode?: 'incremental' | 'overwrite',
  ): Promise<EtfSyncResult> {
    const mfRepo = this.dataSource.getRepository(MoneyFlowEtfEntity);
    const errors: EtfSyncErrorItem[] = [];
    let totalWritten = 0;
    this.logger.log(`[etf-mf] 开始：${etfCodes.length || '自动获取'} 只 ETF，范围 ${startDate}~${endDate}，模式 ${syncMode ?? 'incremental'}`);

    // 如果未传 ETF 代码，自动获取跟踪的 ETF
    if (etfCodes.length === 0) {
      const symbolRepo = this.dataSource.getRepository(EtfSymbolEntity);
      const tracked = await symbolRepo.find({
        where: { tracked: true } as never,
        select: ['tsCode'] as never,
      });
      etfCodes = tracked.map((r) => r.tsCode);
    }
    if (etfCodes.length === 0) return { success: 0, errors };

    for (let i = 0; i < etfCodes.length; i++) {
      const tsCode = etfCodes[i];
      try {
        const count = await this.syncOneEtf(tsCode, startDate, endDate, mfRepo);
        totalWritten += count;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`[etf-mf] ${tsCode} 异常: ${msg}`);
        errors.push({ apiName: 'etf_mf', message: `${tsCode}: ${msg}` });
      }
    }

    this.logger.log(`[etf-mf] 完成：${etfCodes.length} 只 ETF，落库 ${totalWritten} 行`);
    return { success: totalWritten, errors };
  }

  private async syncOneEtf(
    tsCode: string,
    startDate: string,
    endDate: string,
    mfRepo: Repository<MoneyFlowEtfEntity>,
  ): Promise<number> {
    // 1. 取该 ETF 在 [startDate, endDate] 内的 PCF 成分股（trade_date + con_code）
    const pcfRepo = this.dataSource.getRepository(EtfPcfEntity);
    const pcfRows = await pcfRepo
      .createQueryBuilder('p')
      .select(['p.tradeDate AS trade_date', 'p.conCode AS con_code'])
      .where('p.tsCode = :tsCode', { tsCode })
      .andWhere('p.tradeDate >= :startDate', { startDate })
      .andWhere('p.tradeDate <= :endDate', { endDate })
      .andWhere("p.conCode != ''")
      .orderBy('p.tradeDate', 'ASC')
      .getRawMany<PcfMemberRow>();

    if (pcfRows.length === 0) {
      return 0;
    }

    // 2. 构造 PIT 版本链（每个有 PCF 的交易日一份成分股清单）
    const versions = buildPcfWeightVersions(pcfRows);
    const allCodes = allMemberCodes(versions);
    if (allCodes.size === 0) {
      return 0;
    }

    // 3. 查 money_flow_stocks（覆盖成分股并集 + 日期范围）
    const flowRows = await this.dataSource.query<MoneyFlowStockDbRow[]>(
      `
      SELECT ts_code, trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount
      FROM money_flow_stocks
      WHERE ts_code = ANY($1::text[])
        AND trade_date >= $2
        AND trade_date <= $3
      ORDER BY trade_date ASC
      `,
      [[...allCodes], startDate, endDate],
    );

    if (flowRows.length === 0) return 0;

    // 4. 逐日 PIT 聚合：aggregateMoneyFlowFromRows 内部对每个 tradeDate 调
    //    resolvePitMembers(versions, tradeDate)，只纳入当日成分股清单。
    const flowByDateCode = buildFlowByDateCode(flowRows);
    const tradeDates = Object.keys(flowByDateCode).sort();
    const aggregated = aggregateMoneyFlowFromRows({
      customIndexId: tsCode,
      versions,
      tradeDates,
      flowByDateCode,
    });

    if (aggregated.length === 0) return 0;

    // 5. 转 entity + 去重 upsert
    const outRows = mfRowsToEntities(tsCode, aggregated);
    const deduped = this.dedup(outRows, ['tsCode', 'tradeDate']);
    await this.upsertInChunks(mfRepo, deduped);
    return deduped.length;
  }

  private dedup<T extends object>(entities: T[], keys: (keyof T)[]): T[] {
    const map = new Map<string, T>();
    for (const e of entities) {
      const k = keys.map((key) => String(e[key])).join('|');
      map.set(k, e);
    }
    return [...map.values()];
  }

  private async upsertInChunks(
    repo: Repository<MoneyFlowEtfEntity>,
    entities: Partial<MoneyFlowEtfEntity>[],
  ): Promise<void> {
    const CHUNK = 1000;
    for (let i = 0; i < entities.length; i += CHUNK) {
      const chunk = entities.slice(i, i + CHUNK);
      await repo
        .createQueryBuilder()
        .insert()
        .into(MoneyFlowEtfEntity)
        .values(chunk)
        .orUpdate(
          ['net_amount', 'buy_lg_amount', 'buy_md_amount', 'buy_sm_amount'],
          ['ts_code', 'trade_date'],
        )
        .execute();
    }
  }
}
