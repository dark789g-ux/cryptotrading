/**
 * A 股大盘指数清单（type='M'）。
 *
 * 这些指数（上证/深证/创业板/科创/沪深300 等）不来自同花顺 ths_index 接口
 * （该接口只给同花顺自家行业/概念指数 *.TI），故在此硬编码常量。
 *
 * 来源核对：与 `apps/server/src/daily-review/snapshot/snapshot-builder.service.ts:9-14`
 * 原 INDEX_LIST（4 个核心大盘）对齐，并新增 4 个宽基（沪深300/上证50/中证500/中证1000）。
 *
 * 设计 spec：docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md:141-144
 */
export interface MarketIndexEntry {
  tsCode: string;
  name: string;
  category: 'market';
}

export const MARKET_INDEX_LIST: readonly MarketIndexEntry[] = [
  { tsCode: '000001.SH', name: '上证指数', category: 'market' },
  { tsCode: '399001.SZ', name: '深证成指', category: 'market' },
  { tsCode: '399006.SZ', name: '创业板指', category: 'market' },
  { tsCode: '000688.SH', name: '科创50', category: 'market' },
  { tsCode: '000300.SH', name: '沪深300', category: 'market' },
  { tsCode: '000016.SH', name: '上证50', category: 'market' },
  { tsCode: '000905.SH', name: '中证500', category: 'market' },
  { tsCode: '000852.SH', name: '中证1000', category: 'market' },
] as const;
