import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  aggregateMoneyFlowFromRows,
  CustomIndexMoneyFlowService,
} from './custom-index-money-flow.service';
import { computeAmvRows, calcSimpleMa } from './custom-index-amv-writer';
import {
  CUSTOM_INDEX_AMV_SCALE_K,
  type ComponentBar,
  type ComputeContext,
  type WeightVersion,
} from './custom-index-compute.types';

const CID = '11111111-1111-1111-1111-111111111111';

const versions: WeightVersion[] = [
  {
    id: 1,
    effectiveDate: '20260101',
    expireDate: null,
    weightMethod: 'equal',
    members: [
      { conCode: '000001.SZ', weight: 0.7 },
      { conCode: '000002.SZ', weight: 0.3 },
    ],
  },
];

function makeBar(conCode: string, tradeDate: string, close: number, vol: number): ComponentBar {
  return {
    conCode,
    tradeDate,
    open: close,
    high: close,
    low: close,
    close,
    preClose: close,
    vol,
    amount: close * vol,
    price: close,
    pricePrev: close,
    pricePrevRaw: close,
    openPrice: close,
    highPrice: close,
    lowPrice: close,
  };
}

describe('aggregateMoneyFlowFromRows', () => {
  it('等权 SUM，不用 member.weight 加权', () => {
    const rows = aggregateMoneyFlowFromRows({
      customIndexId: CID,
      versions,
      tradeDates: ['20260102'],
      flowByDateCode: {
        '20260102': {
          '000001.SZ': {
            netAmount: 100,
            buyLgAmount: 10,
            buyMdAmount: 20,
            buySmAmount: 30,
          },
          '000002.SZ': {
            netAmount: 50,
            buyLgAmount: 5,
            buyMdAmount: 10,
            buySmAmount: 15,
          },
        },
      },
    });

    expect(rows).toEqual([
      {
        customIndexId: CID,
        tradeDate: '20260102',
        netAmount: 150,
        buyLgAmount: 15,
        buyMdAmount: 30,
        buySmAmount: 45,
      },
    ]);
  });

  it('缺失成分 skip，不补零；全无数据则跳过该日', () => {
    const rows = aggregateMoneyFlowFromRows({
      customIndexId: CID,
      versions,
      tradeDates: ['20260102', '20260103'],
      flowByDateCode: {
        '20260102': {
          '000001.SZ': {
            netAmount: 100,
            buyLgAmount: null,
            buyMdAmount: null,
            buySmAmount: null,
          },
        },
        '20260103': {},
      },
    });

    expect(rows).toEqual([
      {
        customIndexId: CID,
        tradeDate: '20260102',
        netAmount: 100,
        buyLgAmount: null,
        buyMdAmount: null,
        buySmAmount: null,
      },
    ]);
  });
});

describe('CustomIndexMoneyFlowService', () => {
  let service: CustomIndexMoneyFlowService;
  let query: jest.Mock;

  beforeEach(async () => {
    query = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomIndexMoneyFlowService,
        { provide: getDataSourceToken(), useValue: { query } },
      ],
    }).compile();
    service = module.get(CustomIndexMoneyFlowService);
  });

  it('aggregateMoneyFlow 读 DB 后等权聚合', async () => {
    query.mockResolvedValue([
      {
        ts_code: '000001.SZ',
        trade_date: '20260102',
        net_amount: '100',
        buy_lg_amount: '10',
        buy_md_amount: '20',
        buy_sm_amount: '30',
      },
      {
        ts_code: '000002.SZ',
        trade_date: '20260102',
        net_amount: '50',
        buy_lg_amount: '5',
        buy_md_amount: '10',
        buy_sm_amount: '15',
      },
    ]);

    const rows = await service.aggregateMoneyFlow({
      customIndexId: CID,
      versions,
      tradeDates: ['20260102'],
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM money_flow_stocks'),
      [['000001.SZ', '000002.SZ'], '20260102', '20260102'],
    );
    expect(rows[0].netAmount).toBe(150);
  });

  it('tradeDates 空 → 不查库', async () => {
    const rows = await service.aggregateMoneyFlow({
      customIndexId: CID,
      versions,
      tradeDates: [],
    });
    expect(rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('computeAmvRows', () => {
  it('amv(D) = Σ(close×vol) / index_close × K', () => {
    const ctx: ComputeContext = {
      tradeDates: ['20260102'],
      barsByDate: {
        '20260102': {
          '000001.SZ': makeBar('000001.SZ', '20260102', 10, 1000),
          '000002.SZ': makeBar('000002.SZ', '20260102', 20, 500),
        },
      },
      stockMeta: {},
      adjLatest: {},
      warnings: [],
    };

    const rows = computeAmvRows({
      customIndexId: CID,
      versions,
      ctx,
      quotes: [{ tradeDate: '20260102', close: 1000 }],
    });

    const turnover = 10 * 1000 + 20 * 500;
    expect(rows).toEqual([
      {
        customIndexId: CID,
        tradeDate: '20260102',
        amv: (turnover / 1000) * CUSTOM_INDEX_AMV_SCALE_K,
        amvMa5: null,
        amvMa10: null,
        amvMa20: null,
        amvMa60: null,
      },
    ]);
  });

  it('calcSimpleMa 满 period 后输出均值', () => {
    expect(calcSimpleMa([1, 2, 3, 4, 5], 5)).toEqual([null, null, null, null, 3]);
  });
});
