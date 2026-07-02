/**
 * ETF 资金净流入（etf-mf）单元测试。
 *
 * 核心覆盖 R2：逐日 PIT 匹配当日 PCF 成分股 —— 调样日前后成分股变化时，
 * 每个 tradeDate 只聚合「最近一份 PCF」的成分股，绝不纳入未来/历史串期成分股。
 *
 * 纯函数测试，不依赖 DB（aggregateMoneyFlowFromRows + buildPcfWeightVersions）。
 */
import { aggregateMoneyFlowFromRows } from '../../custom-index/compute/custom-index-money-flow.service';
import {
  buildPcfWeightVersions,
  buildFlowByDateCode,
  mfRowsToEntities,
} from '../etf-mf.service';
import type { MoneyFlowStockDbRow } from '../etf-mf.service';

const TS_CODE = '510020.SH';
const A = '000001.SZ';
const B = '000002.SZ';
const C = '600000.SH';

describe('buildPcfWeightVersions', () => {
  it('每个有 PCF 的交易日一份版本，当日成分股归为该版本 members', () => {
    const versions = buildPcfWeightVersions([
      { trade_date: '20260101', con_code: A },
      { trade_date: '20260101', con_code: B },
      { trade_date: '20260103', con_code: B },
      { trade_date: '20260103', con_code: C },
    ]);

    expect(versions).toHaveLength(2);
    expect(versions[0].effectiveDate).toBe('20260101');
    expect(versions[0].expireDate).toBeNull();
    expect(versions[0].members.map((m) => m.conCode).sort()).toEqual([A, B]);
    expect(versions[1].effectiveDate).toBe('20260103');
    expect(versions[1].members.map((m) => m.conCode).sort()).toEqual([B, C]);
  });

  it('过滤空 con_code；无有效行 → 空版本链', () => {
    expect(buildPcfWeightVersions([{ trade_date: '20260101', con_code: '' }])).toEqual([]);
    expect(buildPcfWeightVersions([])).toEqual([]);
  });
});

describe('etf-mf 逐日 PIT 聚合（调样日前后不串成分股）', () => {
  // PCF：D1={A,B}，D3 调样为 {B,C}（A 出局，C 新入）
  const versions = buildPcfWeightVersions([
    { trade_date: '20260101', con_code: A },
    { trade_date: '20260101', con_code: B },
    { trade_date: '20260103', con_code: B },
    { trade_date: '20260103', con_code: C },
  ]);

  // money_flow_stocks：D2 已有 C 的数据（未来成分股），D3 仍有 A 的残余（历史成分股）
  const flowByDateCode = buildFlowByDateCode([
    { ts_code: A, trade_date: '20260101', net_amount: '10', buy_lg_amount: '1', buy_md_amount: '2', buy_sm_amount: '3' },
    { ts_code: B, trade_date: '20260101', net_amount: '20', buy_lg_amount: '2', buy_md_amount: '4', buy_sm_amount: '6' },
    { ts_code: A, trade_date: '20260102', net_amount: '10', buy_lg_amount: '1', buy_md_amount: '2', buy_sm_amount: '3' },
    { ts_code: B, trade_date: '20260102', net_amount: '20', buy_lg_amount: '2', buy_md_amount: '4', buy_sm_amount: '6' },
    { ts_code: C, trade_date: '20260102', net_amount: '30', buy_lg_amount: '3', buy_md_amount: '6', buy_sm_amount: '9' },
    { ts_code: A, trade_date: '20260103', net_amount: '99', buy_lg_amount: '9', buy_md_amount: '9', buy_sm_amount: '9' },
    { ts_code: B, trade_date: '20260103', net_amount: '20', buy_lg_amount: '2', buy_md_amount: '4', buy_sm_amount: '6' },
    { ts_code: C, trade_date: '20260103', net_amount: '30', buy_lg_amount: '3', buy_md_amount: '6', buy_sm_amount: '9' },
  ] as MoneyFlowStockDbRow[]);

  const rows = aggregateMoneyFlowFromRows({
    customIndexId: TS_CODE,
    versions,
    tradeDates: Object.keys(flowByDateCode).sort(),
    flowByDateCode,
  });

  it('D1 用当日成分股 {A,B}：net=30', () => {
    const d1 = rows.find((r) => r.tradeDate === '20260101');
    expect(d1?.netAmount).toBe(30);
    expect(d1?.buyLgAmount).toBe(3);
    expect(d1?.buyMdAmount).toBe(6);
    expect(d1?.buySmAmount).toBe(9);
  });

  it('D2 在调样之间，PIT 仍用最近一份 PCF {A,B}：net=30（不纳入未来成分股 C 的 30）', () => {
    const d2 = rows.find((r) => r.tradeDate === '20260102');
    expect(d2?.netAmount).toBe(30);
    expect(d2?.buyLgAmount).toBe(3);
  });

  it('D3 调样后用 {B,C}：net=50（不纳入历史成分股 A 的残余 99）', () => {
    const d3 = rows.find((r) => r.tradeDate === '20260103');
    expect(d3?.netAmount).toBe(50);
    expect(d3?.buyLgAmount).toBe(5);
  });

  it('换并集聚合会在 D2 得 60、D3 得 149 —— 当前 PIT 值严格小于并集值', () => {
    // 防回归：若改回并集聚合，D2/D3 会显著偏大
    expect(rows.find((r) => r.tradeDate === '20260102')?.netAmount).toBeLessThan(60);
    expect(rows.find((r) => r.tradeDate === '20260103')?.netAmount).toBeLessThan(149);
  });
});

describe('etf-mf PIT 边界', () => {
  it('早于最早 PCF 的交易日无可用版本 → 该日不输出', () => {
    const versions = buildPcfWeightVersions([
      { trade_date: '20260102', con_code: A },
    ]);
    const rows = aggregateMoneyFlowFromRows({
      customIndexId: TS_CODE,
      versions,
      tradeDates: ['20260101', '20260102'],
      flowByDateCode: {
        '20260101': { [A]: { netAmount: 10, buyLgAmount: null, buyMdAmount: null, buySmAmount: null } },
        '20260102': { [A]: { netAmount: 20, buyLgAmount: null, buyMdAmount: null, buySmAmount: null } },
      },
    });
    expect(rows.map((r) => r.tradeDate)).toEqual(['20260102']);
  });
});

describe('buildFlowByDateCode / mfRowsToEntities', () => {
  it('DB 行（字符串数值）解析为 flowByDateCode[td][code]', () => {
    const map = buildFlowByDateCode([
      { ts_code: A, trade_date: '20260101', net_amount: '10.5', buy_lg_amount: null, buy_md_amount: '2', buy_sm_amount: '3' },
    ] as MoneyFlowStockDbRow[]);
    expect(map['20260101'][A]).toEqual({
      netAmount: 10.5,
      buyLgAmount: null,
      buyMdAmount: 2,
      buySmAmount: 3,
    });
  });

  it('聚合 number → entity string（numeric 列），null 保留', () => {
    const entities = mfRowsToEntities(TS_CODE, [
      { customIndexId: TS_CODE, tradeDate: '20260101', netAmount: 30, buyLgAmount: 3, buyMdAmount: 6, buySmAmount: 9 },
      { customIndexId: TS_CODE, tradeDate: '20260102', netAmount: null, buyLgAmount: null, buyMdAmount: null, buySmAmount: null },
    ]);
    expect(entities).toEqual([
      { tsCode: TS_CODE, tradeDate: '20260101', netAmount: '30', buyLgAmount: '3', buyMdAmount: '6', buySmAmount: '9' },
      { tsCode: TS_CODE, tradeDate: '20260102', netAmount: null, buyLgAmount: null, buyMdAmount: null, buySmAmount: null },
    ]);
  });
});
