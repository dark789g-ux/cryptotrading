/**
 * ETF 目录 service：seed 种子清单 + Tushare fund_basic 补全。
 *
 * 数据来源：
 * 1. 深交所列表接口（szse.cn API）→ SZ ETF
 * 2. Tushare fund_basic(market='E') → 沪深 ETF 清单
 * 3. 手动 seed 兜底
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EtfSymbolEntity } from '../../entities/raw/etf-symbol.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { batchUpsert, deduplicateBy, runWithRetry } from '../_shared/sync-helpers';
import type { EtfSyncErrorItem, EtfSyncResult } from './etf.types';

/** Tushare fund_basic 积分要求：2000 积分可调取，7000 满足。 */
const FUND_BASIC_FIELDS =
  'ts_code,name,management,fund_type,list_date,status,market';

@Injectable()
export class EtfCatalogService {
  private readonly logger = new Logger(EtfCatalogService.name);

  constructor(
    @InjectRepository(EtfSymbolEntity)
    private readonly repo: Repository<EtfSymbolEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tushareClient: TushareClientService,
  ) {}

  /**
   * 同步 ETF 目录：先 seed 后 Tushare fund_basic 补全。
   * 返回成功写入行数 + 错误。
   */
  async syncCatalog(): Promise<EtfSyncResult> {
    const errors: EtfSyncErrorItem[] = [];

    // 1. Tushare fund_basic（market=E 场内基金）
    this.logger.log('[etf-catalog] 开始从 Tushare fund_basic 同步 ETF 目录');
    let basicRows: Array<Record<string, string | number | null>> = [];
    try {
      basicRows = await runWithRetry(
        () => this.tushareClient.query('fund_basic', { market: 'E' }, FUND_BASIC_FIELDS),
        (attempt, err) => this.logger.warn(`[etf-catalog] fund_basic 重试 ${attempt}: ${err}`),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`[etf-catalog] fund_basic 调用失败: ${msg}`);
      errors.push({ apiName: 'fund_basic', message: msg });
      return { success: 0, errors };
    }

    // 空数据三路径 warn
    if (!basicRows || basicRows.length === 0) {
      this.logger.warn('[etf-catalog] fund_basic 返回空数据（data=null 或 items=[]），apiName=fund_basic_empty');
      errors.push({ apiName: 'fund_basic_empty', message: 'fund_basic 返回空数据' });
      return { success: 0, errors };
    }

    // 2. 过滤：只保留上市中（L）且类型为 ETF 的基金
    const etfRows = basicRows.filter((r) => {
      const status = String(r.status ?? '');
      const fundType = String(r.fund_type ?? '');
      const name = String(r.name ?? '');
      // 上市中 + 名称或类型包含 ETF
      return status === 'L' && (fundType.includes('ETF') || name.includes('ETF'));
    });

    if (etfRows.length === 0) {
      this.logger.warn('[etf-catalog] fund_basic 过滤后无 ETF 记录');
      errors.push({ apiName: 'fund_basic_no_etf', message: `fund_basic 共 ${basicRows.length} 行，过滤后 0 ETF` });
      return { success: 0, errors };
    }

    // 3. 推断 fund_type 归一化
    const entities = etfRows.map((r) => {
      const tsCode = String(r.ts_code);
      const exchange = tsCode.endsWith('.SH') ? 'SH' : 'SZ';
      return {
        tsCode,
        name: String(r.name ?? ''),
        exchange,
        fundType: normalizeFundType(String(r.fund_type ?? '')),
        manager: String(r.management ?? ''),
        indexCode: null,
        publishIopv: false,
        tracked: true,
      } as Partial<EtfSymbolEntity>;
    });

    // 4. 去重 upsert（复用 _shared/sync-helpers：repo.upsert 自动把属性名 tsCode 映射为列名 ts_code）
    const deduped = deduplicateBy(entities, ['tsCode']);
    const written = await batchUpsert(this.repo, deduped, ['tsCode']);

    this.logger.log(`[etf-catalog] 完成：fund_basic ${etfRows.length} ETF，去重 ${deduped.length}，落库 ${written}`);
    return { success: written, errors };
  }

  /**
   * 获取所有已跟踪的 ETF ts_code 列表。
   */
  async getTrackedEtfCodes(): Promise<string[]> {
    const rows = await this.repo.find({
      where: { tracked: true } as never,
      select: ['tsCode'] as never,
    });
    return rows.map((r) => r.tsCode);
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 归一化 fund_basic.fund_type：保留投资类型原值（股票型/债券型/货币型/QDII 等）。
 *
 * fund_basic.fund_type 是粗粒度「投资类型」，不区分单市场/跨市场/跨境（这些细分
 * 只在交易所 PCF ETF_TYPE 里）。R4 方案 C：不再归一为 'ETF'，原值直接落库，
 * 前端按 distinct fund_type 动态生成筛选选项，保证 radio 每项都有匹配数据。
 */
function normalizeFundType(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed || null;
}
