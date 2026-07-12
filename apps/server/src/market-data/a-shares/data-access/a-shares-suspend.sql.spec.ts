import {
  A_SHARES_LAST_QUOTE_LATERAL,
  A_SHARES_SUSPEND_LATERAL,
  SUSPEND_TYPE_ORDER,
  buildSingleStockSuspendSql,
  buildStaleAwarePriceSelect,
  buildSuspendSelectAliases,
} from './a-shares-suspend.sql';
import { buildASharesBaseQuery } from './a-shares-query.sql';
import { QueryASharesDto } from '../a-shares.types';

describe('a-shares-suspend.sql 状态机', () => {
  it('LATERAL 锚定全局 asOf（l.trade_date）且同日 R 优先于 S', () => {
    expect(A_SHARES_SUSPEND_LATERAL).toContain('sd.trade_date <= l.trade_date');
    expect(A_SHARES_SUSPEND_LATERAL).toContain('ORDER BY sd.trade_date DESC');
    expect(A_SHARES_SUSPEND_LATERAL).toContain(SUSPEND_TYPE_ORDER);
    expect(A_SHARES_SUSPEND_LATERAL).toContain("CASE WHEN le.suspend_type = 'S' THEN 'suspended' ELSE 'none' END");
  });

  it('suspendSinceDate 取最近 R 之后的连续 S 起点', () => {
    expect(A_SHARES_SUSPEND_LATERAL).toContain('MIN(sd2.trade_date) AS since_date');
    expect(A_SHARES_SUSPEND_LATERAL).toContain("sd3.suspend_type = 'R'");
    expect(A_SHARES_SUSPEND_LATERAL).toContain('sd3.trade_date < le.trade_date');
  });

  it('单股查询 asOf 来自 MAX(trade_date) FROM raw.daily_quote', () => {
    const sql = buildSingleStockSuspendSql();
    expect(sql).toContain('SELECT MAX(trade_date) AS trade_date FROM raw.daily_quote');
    expect(sql).toContain('sd.trade_date <= l.trade_date');
    expect(sql).toContain('CASE WHEN le.suspend_type = \'S\' THEN \'suspended\' ELSE \'none\' END AS status');
    expect(sql).toContain('"asOfTradeDate"');
    expect(sql).toContain('"lastQuoteTradeDate"');
  });

  it('S 无 R → suspended；同日 ORDER BY 使 R 优先', () => {
    // R=0, S=1 → same day R sorts first → latest effective event is R → 'none'
    expect(SUSPEND_TYPE_ORDER).toBe("CASE sd.suspend_type WHEN 'R' THEN 0 ELSE 1 END");
    expect(A_SHARES_SUSPEND_LATERAL).toMatch(/ORDER BY sd\.trade_date DESC, CASE sd\.suspend_type WHEN 'R' THEN 0 ELSE 1 END/);
  });
});

describe('a-shares-suspend.sql 列表 stale 回填', () => {
  it('LAST_QUOTE LATERAL 取最近 daily_quote', () => {
    expect(A_SHARES_LAST_QUOTE_LATERAL).toContain('FROM raw.daily_quote');
    expect(A_SHARES_LAST_QUOTE_LATERAL).toContain('ORDER BY trade_date DESC');
    expect(A_SHARES_LAST_QUOTE_LATERAL).toContain('LIMIT 1');
  });

  it('stale-aware 价格列：停牌且 asOf 无 quote 时 fallback lq', () => {
    const qfq = buildStaleAwarePriceSelect('qfq');
    expect(qfq.close).toContain("sus.suspend_status = 'suspended' AND q.trade_date IS NULL");
    expect(qfq.close).toContain('lq.qfq_close');
    expect(qfq.close).toContain('q.qfq_close');
    expect(qfq.tradeDate).toContain('lq.trade_date');
  });

  it('SELECT 别名含 suspendStatus / quoteIsStale', () => {
    const aliases = buildSuspendSelectAliases();
    expect(aliases).toContain('"suspendStatus"');
    expect(aliases).toContain('"suspendSinceDate"');
    expect(aliases).toContain('"suspendTiming"');
    expect(aliases).toContain('"lastQuoteTradeDate"');
    expect(aliases).toContain('"quoteIsStale"');
    expect(aliases).toContain("sus.suspend_status = 'suspended' AND q.trade_date IS NULL");
  });

  it('hydrate 查询 JOIN suspend + last_quote laterals', () => {
    const { sql } = buildASharesBaseQuery({ priceMode: 'qfq' } satisfies QueryASharesDto);
    expect(sql).toContain('raw.suspend_d');
    expect(sql).toContain(') sus ON true');
    expect(sql).toContain(') lq ON true');
    expect(sql).toContain('"suspendStatus"');
    expect(sql).toContain('"quoteIsStale"');
  });
});
