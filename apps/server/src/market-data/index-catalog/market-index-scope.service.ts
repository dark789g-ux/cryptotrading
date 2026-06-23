import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService, type TushareRow } from '../a-shares/services/tushare-client.service';
import { asString, batchUpsert } from '../_shared/sync-helpers';
import { classifyNoise, type NoiseTag } from './classifyNoise';

/**
 * 大盘宽基动态范围管理 service。
 *
 * 设计：docs/superpowers/specs/2026-06-23-market-index-dynamic-scope-design/02-backend.md §2.1
 *
 * 范围持久化到 ths_index_catalog `type='M'` 行（存在即在范围内）。
 * 复用 ThsIndexCatalogEntity + _shared/sync-helpers.batchUpsert，无新实体。
 *
 * 注：type='M' 由本 service 管理，IndexCatalogSyncService.syncCatalog 只处理 'I'/'N'，
 * 勿纳入 syncCatalog（否则会覆盖用户定稿的范围）。
 */

/** index_basic 文档已查证（tushare-sync-dev skill）：market 入参 SSE/SZSE/CSI。 */
const MARKETS = ['SSE', 'SZSE', 'CSI'] as const;

/**
 * 宽基 category 白名单（index_basic category 已查证）：
 * - 规模指数：沪深300、上证50、中证500/1000 等
 * - 综合指数：上证综指、深证成指 等
 */
const BROADBAND_CATEGORIES = new Set(['规模指数', '综合指数']);

/** 6 位纯数字 ts_code 前缀（基础宽基过滤，排除 H00300.CSI 等字母前缀）。 */
const PURE_DIGIT_PREFIX = /^\d{6}/;

/** discoverCandidates 返回的单条候选。 */
export interface MarketIndexCandidate {
  /** TS 指数代码。 */
  ts_code: string;
  /** 指数简称。 */
  name: string;
  /** 终止日期（非空=已退市）。 */
  exp_date: string | null;
  /** index_basic 返回的指数类别（规模指数/综合指数/...）。 */
  category: string;
  /** 噪声标签（前端「隐藏疑似噪声」开关过滤）。 */
  noise_tags: NoiseTag[];
  /** 是否已在当前范围（catalog type='M' 存在）。 */
  in_scope: boolean;
}

/** getScope 返回的单条范围行。 */
export interface MarketIndexScopeRow {
  ts_code: string;
  name: string;
}

/** discoverCandidates 结果（候选 + 失败项透出，遵循 data-integrity 规范）。 */
export interface DiscoverResult {
  candidates: MarketIndexCandidate[];
  /** 失败/空数据项（apiName 后缀 _empty 标识伪装成功的空数据）。 */
  failedItems: string[];
}

interface RawIndexBasicRow extends TushareRow {
  ts_code: string;
  name: string;
  exp_date?: string | null;
  category?: string | null;
}

@Injectable()
export class MarketIndexScopeService {
  private readonly logger = new Logger(MarketIndexScopeService.name);

  constructor(
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  /**
   * 发现候选：拉 index_basic（market ∈ SSE/SZSE/CSI）→ 过滤基础宽基 → 算噪声标签 → 标注在范围内。
   *
   * data-integrity：TushareClientService.query 内部已对 data=null/items=[] 双路径 warn 并返回 []，
   * 本方法在响应 failedItems 透出 `index_basic_empty_<market>`（不把空数据当成功）。
   */
  async discoverCandidates(): Promise<DiscoverResult> {
    const failedItems: string[] = [];
    const rawRows: RawIndexBasicRow[] = [];

    for (const market of MARKETS) {
      let rows: RawIndexBasicRow[] = [];
      try {
        // category 文档查证：入参 category（str, 可选），可选值含「规模指数」「综合指数」。
        // 此处不传 category 入参（一次拉全量 market 再客户端过滤），避免每个 market×category 多次往返；
        // 客户端按返回行 category 字段二次校验（双保险）。
        rows = (await this.tushareClient.query(
          'index_basic',
          { market },
          'ts_code,name,exp_date,category',
        )) as RawIndexBasicRow[];
      } catch (e: unknown) {
        // TushareClientService 已在内部 warn，这里只在 failedItems 透出具体 market。
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`index_basic market=${market} 调用失败: ${msg}`);
        failedItems.push(`index_basic_error_${market}`);
        continue;
      }

      if (rows.length === 0) {
        // 空数据双路径 warn 兜底（query 内部已 warn，这里补 service 层 context + failedItems）。
        this.logger.warn(`index_basic market=${market} 返回空数据（data=null 或 items=[]），params={market:'${market}'}`);
        failedItems.push(`index_basic_empty_${market}`);
        continue;
      }

      rawRows.push(...rows);
    }

    // 过滤基础宽基：6 位纯数字前缀 + category ∈ {规模指数, 综合指数}。
    const broadband = rawRows.filter((r) => {
      const tsCode = asString(r.ts_code);
      const category = asString(r.category);
      return PURE_DIGIT_PREFIX.test(tsCode) && BROADBAND_CATEGORIES.has(category);
    });

    // 当前范围（catalog type='M'），用于标注 in_scope。
    const scopeTsCodes = new Set(
      (await this.getScope()).map((r) => r.ts_code),
    );

    // 算噪声标签（批级，含 duplicate）。
    const noiseInput = broadband.map((r) => ({
      ts_code: asString(r.ts_code),
      name: asString(r.name),
      exp_date: r.exp_date != null ? String(r.exp_date) : null,
    }));
    const noiseMap = new Map(
      classifyNoise(noiseInput).map((nr) => [nr.ts_code, nr.noise_tags]),
    );

    // 去重（同 ts_code 多 market 可能重复，保留首次）。
    const seen = new Set<string>();
    const candidates: MarketIndexCandidate[] = [];
    for (const r of broadband) {
      const tsCode = asString(r.ts_code);
      if (!tsCode || seen.has(tsCode)) continue;
      seen.add(tsCode);
      candidates.push({
        ts_code: tsCode,
        name: asString(r.name),
        exp_date: r.exp_date != null && r.exp_date !== '' ? String(r.exp_date) : null,
        category: asString(r.category),
        noise_tags: noiseMap.get(tsCode) ?? [],
        in_scope: scopeTsCodes.has(tsCode),
      });
    }

    return { candidates, failedItems };
  }

  /**
   * 当前范围：catalog WHERE type='M'，按 ts_code 升序。
   */
  async getScope(): Promise<MarketIndexScopeRow[]> {
    const rows = await this.catalogRepo.find({
      where: { type: 'M' },
      order: { tsCode: 'ASC' },
    });
    return rows.map((r) => ({ ts_code: r.tsCode, name: r.name }));
  }

  /**
   * 加入范围：upsert catalog type='M'。
   * exchange 取 ts_code 后缀（.SH→SSE 归一化等由消费方处理，这里存原始后缀大写）。
   */
  async addToScope(tsCode: string, name: string): Promise<void> {
    const tc = tsCode.trim();
    const nm = name.trim();
    if (!tc || !nm) {
      throw new Error('addToScope: tsCode 与 name 均不可为空');
    }
    const dotIdx = tc.indexOf('.');
    const exchange = dotIdx > 0 ? tc.slice(dotIdx + 1) : '';

    const entity = this.catalogRepo.create({
      tsCode: tc,
      name: nm,
      count: null,
      exchange,
      listDate: null,
      type: 'M',
    });
    await batchUpsert(this.catalogRepo, [entity], ['tsCode']);
  }

  /**
   * 移出范围：delete catalog type='M'。
   * 仅删 type='M' 行（不影响 I/N 行——虽 ts_code 是主键理论唯一，但加 type 守卫防御性）。
   */
  async removeFromScope(tsCode: string): Promise<void> {
    const tc = tsCode.trim();
    if (!tc) {
      throw new Error('removeFromScope: tsCode 不可为空');
    }
    await this.catalogRepo.delete({ tsCode: tc, type: 'M' });
  }
}
