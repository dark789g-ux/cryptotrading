/**
 * ETF PCF 抓取客户端单元测试。
 *
 * 覆盖：
 * - 上交所 JSONP 解析与字段归一
 * - 深交所 XML 解析与字段归一
 * - 空数据三路径（HTTP 错误 / 空 body / 空 result）
 */

import {
  fetchSsePcf,
  fetchSzsePcf,
  ETF_FETCH_INTERVAL_MS,
} from '../etf-pcf.client';

// ── Mock fetch ────────────────────────────────────────────────────────────

let mockFetchImpl: typeof global.fetch;
function mockGlobalFetch(impl: typeof global.fetch) {
  mockFetchImpl = impl;
  global.fetch = impl as any;
}
function restoreFetch() {
  global.fetch = mockFetchImpl ?? (async () => ({} as Response)) as any;
}

// ── 上交所 JSONP 测试 ─────────────────────────────────────────────────────

describe('fetchSsePcf', () => {
  afterEach(restoreFetch);

  it('解析 SSE JSONP 清单头 + 成分股并归一字段', async () => {
    const headerJson = JSON.stringify({
      pageHelp: {},
      result: [{
        FUND_NAME: '超大盘ETF',
        FUND_COMP_NAME: '博时基金',
        ETF_TYPE: '单市场股票ETF',
        CREATION_REDEMPTION_UNIT: '1000000',
        MAX_CASH_RATIO: '0.5',
        PUBLISH_IOPV: 'Y',
        CREATION_PREMIUM_RATE: '10.5',
        REDEMPTION_DISCOUNT_RATE: '9.8',
      }],
    });
    const compJson = JSON.stringify({
      pageHelp: {},
      result: [{
        INSTRUMENT_ID: '600030',
        INSTRUMENT_NAME: '中信证券',
        QUANTITY: '7400',
        SUBSTITUTION_FLAG: 'Y',
        CREATION_PREMIUM_RATE: '33.1',
        REDEMPTION_DISCOUNT_RATE: '32.5',
      }],
    });

    let callCount = 0;
    mockGlobalFetch(async (url: any) => {
      callCount++;
      const isHeader = url.includes('JBXX_C');
      return {
        ok: true,
        text: async () => isHeader ? `cb(${headerJson})` : `cb(${compJson})`,
      } as Response;
    });

    const result = await fetchSsePcf('510020', '20260630');

    expect(callCount).toBe(2);
    expect(result.errors).toHaveLength(0);
    // 1 头 + 1 成分 = 2 行
    expect(result.rows).toHaveLength(2);

    // 清单头行
    const header = result.rows[0];
    expect(header.tsCode).toBe('510020.SH');
    expect(header.tradeDate).toBe('20260630');
    expect(header.fundName).toBe('超大盘ETF');
    expect(header.manager).toBe('博时基金');
    expect(header.publishIopv).toBe(true);
    expect(header.conCode).toBe('');

    // 成分股行
    const comp = result.rows[1];
    expect(comp.tsCode).toBe('510020.SH');
    expect(comp.conCode).toBe('600030');
    expect(comp.conName).toBe('中信证券');
    expect(comp.quantity).toBe(7400);
    expect(comp.substFlag).toBe('Y');
  });

  it('HTTP 非 200 → error sse_pcf_header', async () => {
    mockGlobalFetch(async () => ({ ok: false, status: 500, text: async () => '' } as Response));
    const result = await fetchSsePcf('510020', '20260630');
    expect(result.rows).toHaveLength(0);
    expect(result.errors.some((e) => e.apiName === 'sse_pcf_header')).toBe(true);
  });

  it('空 body → error sse_pcf_header_empty', async () => {
    mockGlobalFetch(async () => ({ ok: true, text: async () => '' } as Response));
    const result = await fetchSsePcf('510020', '20260630');
    expect(result.rows).toHaveLength(0);
    expect(result.errors.some((e) => e.apiName === 'sse_pcf_header_empty')).toBe(true);
  });

  it('result 为空数组 → error sse_pcf_header_empty', async () => {
    mockGlobalFetch(async () => ({
      ok: true,
      text: async () => 'cb({"pageHelp":{},"result":[]})',
    } as Response));
    const result = await fetchSsePcf('510020', '20260630');
    expect(result.rows).toHaveLength(0);
    expect(result.errors.some((e) => e.apiName === 'sse_pcf_header_empty')).toBe(true);
  });
});

// ── 深交所 XML 测试 ─────────────────────────────────────────────────────

describe('fetchSzsePcf', () => {
  afterEach(restoreFetch);

  it('解析 SZSE XML 清单头 + 成分股并归一字段', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PCFFile>
  <SecurityID>159919</SecurityID>
  <TradingDay>20260630</TradingDay>
  <Symbol>沪深300ETF嘉实</Symbol>
  <FundManagementCompany>嘉实基金</FundManagementCompany>
  <CreationRedemptionUnit>1000000</CreationRedemptionUnit>
  <MaxCashRatio>0.5</MaxCashRatio>
  <Publish>Y</Publish>
  <UnderlyingSecurityID>399300</UnderlyingSecurityID>
  <UnderlyingSymbol>沪深300</UnderlyingSymbol>
  <Components>
    <Component>
      <UnderlyingSecurityID>600030</UnderlyingSecurityID>
      <UnderlyingSymbol>中信证券</UnderlyingSymbol>
      <ComponentShare>7400</ComponentShare>
      <SubstituteFlag>Y</SubstituteFlag>
      <PremiumRatio>33.1</PremiumRatio>
      <DiscountRatio>32.5</DiscountRatio>
    </Component>
    <Component>
      <UnderlyingSecurityID>601318</UnderlyingSecurityID>
      <UnderlyingSymbol>中国平安</UnderlyingSymbol>
      <ComponentShare>5000</ComponentShare>
      <SubstituteFlag>N</SubstituteFlag>
      <PremiumRatio>25.0</PremiumRatio>
      <DiscountRatio>24.0</DiscountRatio>
    </Component>
  </Components>
</PCFFile>`;

    mockGlobalFetch(async () => ({ ok: true, text: async () => xml } as Response));

    const result = await fetchSzsePcf('159919', '20260630');

    expect(result.errors).toHaveLength(0);
    // 1 头 + 2 成分 = 3 行
    expect(result.rows).toHaveLength(3);

    // 清单头行
    const header = result.rows[0];
    expect(header.tsCode).toBe('159919.SZ');
    expect(header.tradeDate).toBe('20260630');
    expect(header.fundName).toBe('沪深300ETF嘉实');
    expect(header.manager).toBe('嘉实基金');
    expect(header.publishIopv).toBe(true);
    expect(header.conCode).toBe('');

    // 成分股行
    const comp1 = result.rows[1];
    expect(comp1.conCode).toBe('600030.SH');
    expect(comp1.conName).toBe('中信证券');
    expect(comp1.quantity).toBe(7400);
    expect(comp1.substFlag).toBe('Y');

    const comp2 = result.rows[2];
    expect(comp2.conCode).toBe('601318.SH');
    expect(comp2.conName).toBe('中国平安');
    expect(comp2.quantity).toBe(5000);
  });

  it('HTTP 非 200 → error szse_pcf_xml', async () => {
    mockGlobalFetch(async () => ({ ok: false, status: 404, text: async () => '' } as Response));
    const result = await fetchSzsePcf('159919', '20260630');
    expect(result.rows).toHaveLength(0);
    expect(result.errors.some((e) => e.apiName === 'szse_pcf_xml')).toBe(true);
  });

  it('空 body → error szse_pcf_xml_empty', async () => {
    mockGlobalFetch(async () => ({ ok: true, text: async () => '' } as Response));
    const result = await fetchSzsePcf('159919', '20260630');
    expect(result.rows).toHaveLength(0);
    expect(result.errors.some((e) => e.apiName === 'szse_pcf_xml_empty')).toBe(true);
  });

  it('仅头行无成分股 → error szse_pcf_xml_no_components', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PCFFile>
  <SecurityID>159919</SecurityID>
  <TradingDay>20260630</TradingDay>
  <Symbol>TestETF</Symbol>
  <FundManagementCompany>Test</FundManagementCompany>
</PCFFile>`;

    mockGlobalFetch(async () => ({ ok: true, text: async () => xml } as Response));
    const result = await fetchSzsePcf('159919', '20260630');
    // 头行保留，但报无成分股
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].conCode).toBe('');
    expect(result.errors.some((e) => e.apiName === 'szse_pcf_xml_no_components')).toBe(true);
  });
});

// ── 常量测试 ──────────────────────────────────────────────────────────────

describe('PCF 常量', () => {
  it('限频 ≥ 0.4s', () => {
    expect(ETF_FETCH_INTERVAL_MS).toBeGreaterThanOrEqual(400);
  });
});
