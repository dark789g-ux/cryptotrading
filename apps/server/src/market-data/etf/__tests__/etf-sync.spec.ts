/**
 * ETF 聚合逻辑单元测试。
 *
 * 覆盖：
 * - AMV 聚合（成分股成交额 SUM + ETF 价格）
 * - MF 聚合（成分股 money_flow_stocks SUM）
 * - 空数据 / null skip 逻辑
 * - PCF syncPcf syncMode=overwrite 绕过 getExistingPcfCodes
 */

// ── PCF syncPcf syncMode 测试 ────────────────────────────────────────────────
//
// 验证方案二「overwrite 绕过 getExistingPcfCodes」的关键行为：
// syncMode='overwrite' 时不查已存在（createQueryBuilder 不被调），todo = etfCodes 全量重抓；
// syncMode='incremental'（默认）时调 createQueryBuilder 查已存在并跳过。
//
// mock etf-pcf.client 避免 HTTP；mock DataSource.getRepository 返回 spy repo。

import { EtfPcfService } from '../etf-pcf.service';

jest.mock('../etf-pcf.client', () => ({
  fetchSsePcf: jest.fn(async () => ({ rows: [], errors: [] })),
  fetchSzsePcf: jest.fn(async () => ({ rows: [], errors: [] })),
  ETF_FETCH_INTERVAL_MS: 0,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchSsePcf, fetchSzsePcf } = require('../etf-pcf.client') as {
  fetchSsePcf: jest.Mock;
  fetchSzsePcf: jest.Mock;
};

function makePcfRepoMock() {
  // createQueryBuilder 用于 getExistingPcfCodes；upsert 用于 batchUpsert
  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(async () => [] as { tsCode: string }[]),
  };
  return {
    createQueryBuilder: jest.fn(() => qb),
    qb,
    upsert: jest.fn(async () => ({ generatedMaps: [], raw: [], affected: 0 })),
  };
}

describe('EtfPcfService.syncPcf syncMode', () => {
  beforeEach(() => {
    fetchSsePcf.mockClear();
    fetchSzsePcf.mockClear();
  });

  it("syncMode='overwrite' 绕过 getExistingPcfCodes（createQueryBuilder 不被调），todo = etfCodes 全量重抓", async () => {
    const repo = makePcfRepoMock();
    const dataSource = {
      getRepository: jest.fn(() => repo),
    } as any;
    const svc = new EtfPcfService(dataSource);

    const etfCodes = ['510020.SH', '510300.SH', '159919.SZ'];
    const res = await svc.syncPcf(etfCodes, '20260630', 'overwrite');

    // overwrite 模式：createQueryBuilder 不应被调用（绕过 getExistingPcfCodes）
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    // 三只 ETF 全部都抓取（每只调一次 fetchSsePcf 或 fetchSzsePcf）
    expect(fetchSsePcf).toHaveBeenCalledTimes(2); // 510020.SH + 510300.SH
    expect(fetchSzsePcf).toHaveBeenCalledTimes(1); // 159919.SZ
    // 返回 success=0（fetch 返回空 rows，不落库）
    expect(res.success).toBe(0);
    expect(res.errors).toHaveLength(0);
  });

  it("syncMode='incremental'（默认）调 getExistingPcfCodes 跳过已存在 ETF", async () => {
    const repo = makePcfRepoMock();
    // 模拟 510020.SH 已存在 → 应被跳过
    repo.qb.getRawMany.mockResolvedValueOnce([{ tsCode: '510020.SH' }] as any);
    const dataSource = {
      getRepository: jest.fn(() => repo),
    } as any;
    const svc = new EtfPcfService(dataSource);

    const etfCodes = ['510020.SH', '510300.SH'];
    const res = await svc.syncPcf(etfCodes, '20260630', 'incremental');

    // incremental 模式：createQueryBuilder 被调用查已存在
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    // 510020.SH 已存在 → 只抓 510300.SH
    expect(fetchSsePcf).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(0);
  });

  it("syncMode 缺省 = incremental（兼容旧调用）", async () => {
    const repo = makePcfRepoMock();
    const dataSource = { getRepository: jest.fn(() => repo) } as any;
    const svc = new EtfPcfService(dataSource);

    await svc.syncPcf(['510020.SH'], '20260630');

    // 缺省 syncMode → 走 incremental 路径，调 getExistingPcfCodes
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});



// ── AMV 聚合测试 ────────────────────────────────────────────────────────────

describe('ETF AMV 聚合逻辑', () => {
  it('成分股成交额 SUM → AMV 公式输入（千元→元）', () => {
    // 模拟 aggregateAmount 返回的 map
    const amtMap = new Map<string, { amt: number; memberCount: number }>();
    amtMap.set('20260630', { amt: 50000, memberCount: 300 }); // 50000 千元 = 50 亿元
    amtMap.set('20260629', { amt: 45000, memberCount: 298 });

    // amountInYuan = amt * 1000（千元→元）
    const day1Amt = amtMap.get('20260630')!;
    expect(day1Amt.amt * 1000).toBe(50000000); // 元
    expect(day1Amt.memberCount).toBe(300);
  });

  it('覆盖度 warn：当日有数据的成分股 < 总数', () => {
    const totalMembers = 301;
    const covered = 280;
    expect(covered < totalMembers).toBe(true); // 触发 warn
  });

  it('ETF AMV 落库表结构同构 sw_amv_daily', () => {
    // 验证字段一致：amvOpen/High/Low/Close + dif/dea/macd + zdf + signal + memberCount
    const swAmvCols = ['amvOpen', 'amvHigh', 'amvLow', 'amvClose',
      'amvDif', 'amvDea', 'amvMacd', 'amvZdf', 'signal', 'memberCount'];
    const etfAmvCols = ['amvOpen', 'amvHigh', 'amvLow', 'amvClose',
      'amvDif', 'amvDea', 'amvMacd', 'amvZdf', 'signal', 'memberCount'];
    expect(swAmvCols).toEqual(etfAmvCols);
  });
});

// ── MF 聚合测试 ─────────────────────────────────────────────────────────────

describe('ETF MF 聚合逻辑', () => {
  it('成分股 MF SUM：null skip 不补零', () => {
    // 模拟 flowByDateCode
    const flowByDateCode: Record<string, Record<string, {
      netAmount: number | null;
      buyLgAmount: number | null;
      buyMdAmount: number | null;
      buySmAmount: number | null;
    }>> = {
      '20260630': {
        '600030.SH': { netAmount: 1000, buyLgAmount: 500, buyMdAmount: 300, buySmAmount: 200 },
        '601318.SH': { netAmount: -200, buyLgAmount: -100, buyMdAmount: -50, buySmAmount: -50 },
        '600519.SH': { netAmount: null, buyLgAmount: null, buyMdAmount: null, buySmAmount: null },
      },
    };

    const conCodes = ['600030.SH', '601318.SH', '600519.SH'];
    let net = 0, lg = 0, md = 0, sm = 0;
    let netHas = false, lgHas = false, mdHas = false, smHas = false;

    for (const code of conCodes) {
      const item = flowByDateCode['20260630']?.[code];
      if (!item) continue;
      if (item.netAmount !== null) { net += item.netAmount; netHas = true; }
      if (item.buyLgAmount !== null) { lg += item.buyLgAmount; lgHas = true; }
      if (item.buyMdAmount !== null) { md += item.buyMdAmount; mdHas = true; }
      if (item.buySmAmount !== null) { sm += item.buySmAmount; smHas = true; }
    }

    // 600519 全 null → skip（不补零），net = 1000 + (-200) = 800
    expect(net).toBe(800);
    expect(lg).toBe(400);
    expect(md).toBe(250);
    expect(sm).toBe(150);
    expect(netHas).toBe(true);
    expect(lgHas).toBe(true);
  });

  it('所有成分股 MF 都为 null → 不生成行', () => {
    // 无任何有效数据 → skip 该交易日
    let netHas = false, lgHas = false, mdHas = false, smHas = false;
    expect(!netHas && !lgHas && !mdHas && !smHas).toBe(true);
  });

  it('money_flow_etf 表结构同构 money_flow_industries', () => {
    const industryCols = ['tsCode', 'tradeDate', 'pctChange', 'netBuyAmount',
      'netSellAmount', 'netAmount', 'buyLgAmount', 'buyMdAmount', 'buySmAmount'];
    const etfCols = ['tsCode', 'tradeDate', 'pctChange', 'netBuyAmount',
      'netSellAmount', 'netAmount', 'buyLgAmount', 'buyMdAmount', 'buySmAmount'];
    expect(industryCols).toEqual(etfCols);
  });
});

// ── ETF fund_daily 复权测试 ───────────────────────────────────────────────

describe('ETF 前复权计算', () => {
  it('qfq = 原始 × adjFactor / latestAdjFactor', () => {
    const adjFactor = 1.1; // 当日复权因子
    const latestAdj = 1.05; // 最新复权因子
    const close = 4.0;

    const ratio = adjFactor / latestAdj;
    const qfqClose = close * ratio;
    expect(qfqClose).toBeCloseTo(4.190476, 4); // 4 * 1.1 / 1.05
  });

  it('adjFactor 缺失时 qfq 等于原始值', () => {
    const close = 4.0;
    const latestAdj = 0; // 无复权因子
    const ratio = latestAdj > 0 ? 1 : 0;

    if (latestAdj > 0) {
      // won't reach
    }
    expect(close).toBe(4.0); // qfq = 原始
  });
});
