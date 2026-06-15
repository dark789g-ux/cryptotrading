import { appendUsStocksSort, buildUsStocksBaseQuery } from './us-stocks-query.sql';
import { UsStockQueryBody } from '../us-stocks.types';

/** 折叠连续空白便于子串匹配。 */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

describe('us-stocks-query.sql — 基础查询结构', () => {
  const baseDto: UsStockQueryBody = { priceMode: 'qfq' };

  it('WHERE 限定 tracked=true（只列已追踪标的）', () => {
    const { sql } = buildUsStocksBaseQuery(baseDto);
    expect(squash(sql)).toContain('WHERE s.tracked = true');
  });

  it('JOIN raw.us_daily_quote + raw.us_daily_indicator（按 ticker+trade_date）', () => {
    const { sql } = buildUsStocksBaseQuery(baseDto);
    const flat = squash(sql);
    expect(flat).toContain(
      'LEFT JOIN raw.us_daily_quote q ON q.ticker = s.ticker AND q.trade_date = l.trade_date',
    );
    expect(flat).toContain(
      'LEFT JOIN raw.us_daily_indicator i ON i.ticker = s.ticker AND i.trade_date = l.trade_date',
    );
  });

  it('SELECT 别名与前端 descriptor key 对齐（snake→camel 精确）', () => {
    const { sql } = buildUsStocksBaseQuery(baseDto);
    expect(sql).toContain('s.ticker AS "ticker"');
    expect(sql).toContain('s.stock_type AS "stockType"');
    expect(sql).toContain('i.ma5 AS "ma5"');
    expect(sql).toContain('i.ma240 AS "ma240"');
    expect(sql).toContain('i.bbi AS "bbi"');
    expect(sql).toContain('i.kdj_j AS "kdjJ"');
    expect(sql).toContain('i.kdj_k AS "kdjK"');
    expect(sql).toContain('i.kdj_d AS "kdjD"');
    expect(sql).toContain('i.dif AS "dif"');
    expect(sql).toContain('i.dea AS "dea"');
    expect(sql).toContain('i.macd AS "macd"');
    expect(sql).toContain('i.atr_14 AS "atr14"');
    expect(sql).toContain('i.low_9 AS "low9"');
    expect(sql).toContain('i.high_9 AS "high9"');
    expect(sql).toContain('i.risk_reward_ratio AS "riskRewardRatio"');
    expect(sql).toContain('i.stop_loss_pct AS "stopLossPct"');
  });
});

describe('us-stocks-query.sql — priceMode 价格列选择', () => {
  it('qfq 模式选 qfq_close / qfq_pct_chg', () => {
    const { sql } = buildUsStocksBaseQuery({ priceMode: 'qfq' });
    expect(sql).toContain('q.qfq_close AS close');
    expect(sql).toContain('q.qfq_pct_chg AS "pctChg"');
  });

  it('raw 模式选原始 close / pct_chg', () => {
    const { sql } = buildUsStocksBaseQuery({ priceMode: 'raw' });
    expect(sql).toContain('q.close AS close');
    expect(sql).toContain('q.pct_chg AS "pctChg"');
    expect(sql).not.toContain('q.qfq_close AS close');
  });

  it('未传 priceMode 默认 qfq', () => {
    const { sql } = buildUsStocksBaseQuery({});
    expect(sql).toContain('q.qfq_close AS close');
  });
});

describe('us-stocks-query.sql — 筛选条件与参数序', () => {
  it('搜索 q：ILIKE ticker / name，占 $1', () => {
    const { sql, params, nextParamIndex } = buildUsStocksBaseQuery({ q: 'nvda' });
    expect(sql).toContain('s.ticker ILIKE $1 OR s.name ILIKE $1');
    expect(params).toEqual(['%nvda%']);
    expect(nextParamIndex).toBe(2);
  });

  it('theme + stockType 过滤，参数顺序 theme=$1 / stockType=$2', () => {
    const { sql, params, nextParamIndex } = buildUsStocksBaseQuery({
      theme: 'AI芯片与算力',
      stockType: '巨头型龙头',
    });
    expect(sql).toContain('AND s.theme = $1');
    expect(sql).toContain('AND s.stock_type = $2');
    expect(params).toEqual(['AI芯片与算力', '巨头型龙头']);
    expect(nextParamIndex).toBe(3);
  });

  it('数值高级筛选：经白名单映射列，参数化绑定', () => {
    const { sql, params } = buildUsStocksBaseQuery({
      priceMode: 'qfq',
      conditions: [{ field: 'kdjJ', op: 'lt', value: 0 }],
    });
    expect(sql).toContain('AND i.kdj_j < $1');
    expect(params).toEqual([0]);
  });

  it('数值高级筛选 qfq 价格字段映射到 qfq 列', () => {
    const { sql } = buildUsStocksBaseQuery({
      priceMode: 'qfq',
      conditions: [{ field: 'close', op: 'gt', value: 100 }],
    });
    expect(sql).toContain('AND q.qfq_close > $1');
  });

  it('字段对字段比较（valueType=field）不占参数位', () => {
    const { sql, params } = buildUsStocksBaseQuery({
      priceMode: 'qfq',
      conditions: [{ field: 'close', op: 'gt', valueType: 'field', compareField: 'ma60' }],
    });
    expect(sql).toContain('AND q.qfq_close > i.ma60');
    expect(params).toEqual([]);
  });

  it('未知字段 / 未知操作符的条件被跳过', () => {
    const { sql, params } = buildUsStocksBaseQuery({
      conditions: [
        { field: 'nonexistent', op: 'gt', value: 1 },
        { field: 'close', op: 'gt', value: 5 },
      ],
    });
    // 只剩合法条件
    expect(sql).toContain('AND q.qfq_close > $1');
    expect(params).toEqual([5]);
  });

  it('最多取前 10 个条件', () => {
    const conditions = Array.from({ length: 15 }, () => ({
      field: 'ma5' as const,
      op: 'gt' as const,
      value: 1,
    }));
    const { params } = buildUsStocksBaseQuery({ conditions });
    expect(params).toHaveLength(10);
  });
});

describe('us-stocks-query.sql — 排序映射', () => {
  function sortColFor(field: string, priceMode: 'raw' | 'qfq' = 'qfq'): string {
    const dto: UsStockQueryBody = { sort: { field, order: 'ascend' }, priceMode };
    const base = buildUsStocksBaseQuery(dto);
    const sorted = appendUsStocksSort(base.sql, dto);
    const m = sorted.match(/ORDER BY (.+?) ASC NULLS LAST/);
    return m ? m[1] : '';
  }

  it.each([
    ['ticker', 's.ticker'],
    ['name', 's.name'],
    ['theme', 's.theme'],
    ['stockType', 's.stock_type'],
    ['volume', 'q.volume'],
    ['tradeDate', 'q.trade_date'],
    ['ma5', 'i.ma5'],
    ['ma240', 'i.ma240'],
    ['bbi', 'i.bbi'],
    ['kdjJ', 'i.kdj_j'],
    ['dif', 'i.dif'],
    ['macd', 'i.macd'],
    ['atr14', 'i.atr_14'],
    ['low9', 'i.low_9'],
    ['high9', 'i.high_9'],
    ['riskRewardRatio', 'i.risk_reward_ratio'],
    ['stopLossPct', 'i.stop_loss_pct'],
  ])('RAW/QFQ 共用指标映射 %s → %s', (field, col) => {
    expect(sortColFor(field, 'qfq')).toBe(col);
  });

  it('close 排序按口径切换 qfq/raw 列', () => {
    expect(sortColFor('close', 'qfq')).toBe('q.qfq_close');
    expect(sortColFor('close', 'raw')).toBe('q.close');
  });

  it('pctChg 排序按口径切换', () => {
    expect(sortColFor('pctChg', 'qfq')).toBe('q.qfq_pct_chg');
    expect(sortColFor('pctChg', 'raw')).toBe('q.pct_chg');
  });

  it('未知排序字段回退 s.ticker', () => {
    expect(sortColFor('nonexistentField', 'qfq')).toBe('s.ticker');
  });

  it('降序方向正确，且 s.ticker 作稳定次序', () => {
    const dto: UsStockQueryBody = { sort: { field: 'macd', order: 'descend' }, priceMode: 'qfq' };
    const sorted = appendUsStocksSort(buildUsStocksBaseQuery(dto).sql, dto);
    expect(sorted).toContain('ORDER BY i.macd DESC NULLS LAST, s.ticker ASC');
  });
});
