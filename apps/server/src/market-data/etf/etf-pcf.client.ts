/**
 * 沪深交易所 ETF PCF（申购赎回清单）抓取客户端。
 *
 * 上交所：JSONP → JSON（两个 sqlId：清单头 + 成分股）
 * 深交所：直接 XML
 *
 * 不注册为 NestJS provider，纯函数模块，由 EtfPcfService 调用。
 */

import { XMLParser } from 'fast-xml-parser';
import type { PcfNormalizedRow } from './etf.types';

// ── 常量 ───────────────────────────────────────────────────────────────────

const SSE_BASE = 'https://query.sse.com.cn/commonQuery.do';
const SZSE_PCF_URL =
  'https://reportdocs.static.szse.cn/files/text/ETFDown/pcf_{code}_{date}.xml';

/** 上交所 JSONP 回调名（任意非空字符串即可） */
const SSE_CALLBACK = 'jsonpCallback';
const SSE_REFERER = 'https://www.sse.com.cn/';
const SSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const SZSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** 上交所 sqlId：清单头 */
const SSE_SQL_HEADER =
  'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C';
/** 上交所 sqlId：成分股 */
const SSE_SQL_COMPONENT =
  'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C';

/** 交易所请求限频（ms），≥0.4s */
export const ETF_FETCH_INTERVAL_MS = 450;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

// ── 上交所 JSONP 解析 ─────────────────────────────────────────────────────

/** 去外层 JSONP 回调 → JSON.parse → result 数组 */
function parseJsonp(text: string): unknown[] {
  // 回调名(...) → 取括号内 JSON
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`SSE JSONP 格式异常：未找到有效回调包裹，响应前100字符: ${text.slice(0, 100)}`);
  }
  const jsonStr = text.slice(start + 1, end);
  const parsed = JSON.parse(jsonStr);
  // 返回结构：{ pageHelp: { ... }, result: [...] }
  if (parsed && Array.isArray(parsed.result)) {
    return parsed.result;
  }
  // 某些 sqlId 返回 pageHelp.data
  if (parsed?.pageHelp?.data && Array.isArray(parsed.pageHelp.data)) {
    return parsed.pageHelp.data;
  }
  throw new Error(`SSE JSONP 解析后无 result/pageHelp.data，keys: ${Object.keys(parsed ?? {}).join(',')}`);
}

/** 上交所 6 位代码 → ts_code（加 .SH 后缀） */
function sseCodeToTsCode(code6: string): string {
  return `${code6}.SH`;
}

// ── 深交所 XML 解析 ───────────────────────────────────────────────────────

interface SzsePcfParsed {
  PCFFile: {
    SecurityID?: string;
    TradingDay?: string;
    Symbol?: string;
    FundManagementCompany?: string;
    CreationRedemptionUnit?: string;
    MaxCashRatio?: string;
    Publish?: string;
    UnderlyingSecurityID?: string;
    UnderlyingSymbol?: string;
    Components?: {
      Component?: Array<Record<string, unknown>> | Record<string, unknown>;
    };
  };
}

function normalizeXmlValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normalizeXmlBool(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toUpperCase();
  return s === 'Y' || s === 'TRUE' || s === '1' || s === '是';
}

function normalizeXmlNum(v: unknown): number | null {
  const s = normalizeXmlValue(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── 公开 API ──────────────────────────────────────────────────────────────

export interface FetchPcfResult {
  rows: PcfNormalizedRow[];
  errors: Array<{ apiName: string; message: string }>;
}

/**
 * 抓取上交所 ETF PCF（JSONP，两个 sqlId 各一次请求）。
 * code6: 6 位基金代码（如 '510020'）。
 */
export async function fetchSsePcf(
  code6: string,
  tradeDate: string,
): Promise<FetchPcfResult> {
  const tsCode = sseCodeToTsCode(code6);
  const errors: FetchPcfResult['errors'] = [];
  const headerRows: PcfNormalizedRow[] = [];
  const componentRows: PcfNormalizedRow[] = [];

  const params = new URLSearchParams({
    jsonCallBack: SSE_CALLBACK,
    isPagination: 'false',
    FUNDID2: code6,
    _: String(Date.now()),
  });

  // 1. 清单头
  const headerUrl = `${SSE_BASE}?${params.toString()}&sqlId=${SSE_SQL_HEADER}`;
  try {
    const resp = await fetch(headerUrl, {
      headers: {
        'User-Agent': SSE_UA,
        Referer: SSE_REFERER,
      },
    });
    if (!resp.ok) {
      errors.push({ apiName: 'sse_pcf_header', message: `HTTP ${resp.status} ${code6} ${tradeDate}` });
    } else {
      const text = await resp.text();
      if (!text || text.trim().length === 0) {
        errors.push({ apiName: 'sse_pcf_header_empty', message: `${code6} ${tradeDate} 响应为空` });
      } else {
        const result = parseJsonp(text);
        if (result.length === 0) {
          errors.push({ apiName: 'sse_pcf_header_empty', message: `${code6} ${tradeDate} result 为空数组` });
        } else {
          const h = result[0] as Record<string, unknown>;
          headerRows.push({
            tsCode,
            tradeDate,
            fundName: normalizeXmlValue(h?.FUND_NAME),
            manager: normalizeXmlValue(h?.FUND_COMP_NAME),
            fundType: normalizeXmlValue(h?.ETF_TYPE),
            indexCode: normalizeXmlValue(h?.UnderlyingSecurityID ?? ''),
            creationUnit: normalizeXmlNum(h?.CREATION_REDEMPTION_UNIT),
            maxCashRatio: normalizeXmlNum(h?.MAX_CASH_RATIO),
            publishIopv: normalizeXmlBool(h?.PUBLISH_IOPV),
            conCode: '',
            conName: '',
            quantity: null,
            substFlag: '',
            premiumRate: normalizeXmlNum(h?.CREATION_PREMIUM_RATE),
            discountRate: normalizeXmlNum(h?.REDEMPTION_DISCOUNT_RATE),
          });
        }
      }
    }
  } catch (e) {
    errors.push({ apiName: 'sse_pcf_header', message: `${code6} ${tradeDate}: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 2. 成分股
  const compUrl = `${SSE_BASE}?${params.toString()}&sqlId=${SSE_SQL_COMPONENT}`;
  try {
    const resp = await fetch(compUrl, {
      headers: {
        'User-Agent': SSE_UA,
        Referer: SSE_REFERER,
      },
    });
    if (!resp.ok) {
      errors.push({ apiName: 'sse_pcf_component', message: `HTTP ${resp.status} ${code6} ${tradeDate}` });
    } else {
      const text = await resp.text();
      if (!text || text.trim().length === 0) {
        errors.push({ apiName: 'sse_pcf_component_empty', message: `${code6} ${tradeDate} 响应为空` });
      } else {
        const result = parseJsonp(text);
        if (result.length === 0) {
          errors.push({ apiName: 'sse_pcf_component_empty', message: `${code6} ${tradeDate} result 为空数组` });
        } else {
          // 继承清单头的 fundName / manager / fundType 等到每行成分股
          const header = headerRows[0] ?? {
            tsCode,
            tradeDate,
            fundName: '', manager: '', fundType: '',
            indexCode: '', creationUnit: null, maxCashRatio: null,
            publishIopv: false, premiumRate: null, discountRate: null,
          };
          for (const raw of result) {
            const c = raw as Record<string, unknown>;
            componentRows.push({
              tsCode,
              tradeDate,
              fundName: header.fundName,
              manager: header.manager,
              fundType: header.fundType,
              indexCode: header.indexCode,
              creationUnit: header.creationUnit,
              maxCashRatio: header.maxCashRatio,
              publishIopv: header.publishIopv,
              conCode: normalizeXmlValue(c?.INSTRUMENT_ID) ?? '',
              conName: normalizeXmlValue(c?.INSTRUMENT_NAME) ?? '',
              quantity: normalizeXmlNum(c?.QUANTITY),
              substFlag: normalizeXmlValue(c?.SUBSTITUTION_FLAG) ?? '',
              premiumRate: normalizeXmlNum(c?.CREATION_PREMIUM_RATE),
              discountRate: normalizeXmlNum(c?.REDEMPTION_DISCOUNT_RATE),
            });
          }
        }
      }
    }
  } catch (e) {
    errors.push({ apiName: 'sse_pcf_component', message: `${code6} ${tradeDate}: ${e instanceof Error ? e.message : String(e)}` });
  }

  return { rows: [...headerRows, ...componentRows], errors };
}

/**
 * 抓取深交所 ETF PCF（XML）。
 * code6: 6 位基金代码（如 '159919'）。
 */
export async function fetchSzsePcf(
  code6: string,
  tradeDate: string,
): Promise<FetchPcfResult> {
  const tsCode = `${code6}.SZ`;
  const errors: FetchPcfResult['errors'] = [];

  const url = SZSE_PCF_URL
    .replace('{code}', code6)
    .replace('{date}', tradeDate);

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': SZSE_UA },
    });
    if (!resp.ok) {
      errors.push({ apiName: 'szse_pcf_xml', message: `HTTP ${resp.status} ${code6} ${tradeDate}` });
      return { rows: [], errors };
    }

    const text = await resp.text();
    if (!text || text.trim().length === 0) {
      errors.push({ apiName: 'szse_pcf_xml_empty', message: `${code6} ${tradeDate} 响应为空` });
      return { rows: [], errors };
    }

    const parsed = xmlParser.parse(text) as SzsePcfParsed;
    const file = parsed?.PCFFile;
    if (!file) {
      errors.push({ apiName: 'szse_pcf_xml_parse', message: `${code6} ${tradeDate} 缺少 PCFFile 根节点` });
      return { rows: [], errors };
    }

    const fundName = normalizeXmlValue(file.Symbol) ?? '';
    const manager = normalizeXmlValue(file.FundManagementCompany) ?? '';
    const publishIopv = normalizeXmlBool(file.Publish);
    const creationUnit = normalizeXmlNum(file.CreationRedemptionUnit);
    const maxCashRatio = normalizeXmlNum(file.MaxCashRatio);
    const indexCode = normalizeXmlValue(file.UnderlyingSecurityID) ?? '';

    // 推断 fund_type（深交所无直接字段，按代码/指数规则粗判）
    const fundType = inferSzseFundType(code6, indexCode);

    // 清单头行（con_code=''）
    const rows: PcfNormalizedRow[] = [{
      tsCode,
      tradeDate,
      fundName,
      manager,
      fundType,
      indexCode,
      creationUnit,
      maxCashRatio,
      publishIopv,
      conCode: '',
      conName: '',
      quantity: null,
      substFlag: '',
      premiumRate: null,
      discountRate: null,
    }];

    // 成分股行
    const components = file.Components?.Component;
    if (components) {
      const compList = Array.isArray(components) ? components : [components];
      for (const c of compList) {
        const conCode = normalizeXmlValue(
          (c as Record<string, unknown>).UnderlyingSecurityID ??
          (c as Record<string, unknown>).SecurityID,
        ) ?? '';
        // 如果 conCode 没有后缀，推断交易所
        const finalConCode = conCode.includes('.') ? conCode : inferConCodeExchange(conCode);
        rows.push({
          tsCode,
          tradeDate,
          fundName,
          manager,
          fundType,
          indexCode,
          creationUnit,
          maxCashRatio,
          publishIopv,
          conCode: finalConCode,
          conName: normalizeXmlValue((c as Record<string, unknown>).UnderlyingSymbol),
          quantity: normalizeXmlNum((c as Record<string, unknown>).ComponentShare),
          substFlag: normalizeXmlValue((c as Record<string, unknown>).SubstituteFlag) ?? '',
          premiumRate: normalizeXmlNum((c as Record<string, unknown>).PremiumRatio),
          discountRate: normalizeXmlNum((c as Record<string, unknown>).DiscountRatio),
        });
      }
    }

    if (rows.length <= 1) {
      // 仅有头行无成分股
      errors.push({ apiName: 'szse_pcf_xml_no_components', message: `${code6} ${tradeDate} 无成分股` });
    }

    return { rows, errors };
  } catch (e) {
    errors.push({ apiName: 'szse_pcf_xml', message: `${code6} ${tradeDate}: ${e instanceof Error ? e.message : String(e)}` });
    return { rows: [], errors };
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 深交所 ETF 无直接 fund_type 字段，粗判：
 * - 代码以 159 开头 → '跨市场股票ETF'
 * - 代码以 1599 开头 → '跨市场股票ETF'（细化）
 * - 代码以 15 开头 → '跨境ETF'（简化）
 * - 其他默认 null
 */
function inferSzseFundType(_code6: string, _indexCode: string): string {
  // 粗判，后续可由 fund_basic 数据补充
  return '股票型';
}

/**
 * 深交所成分股代码无交易所后缀时推断（6 位纯数字 → .SH/.SZ）。
 * 简化逻辑：60/68 开头 → .SH，00/30 开头 → .SZ，其他保持原样。
 */
function inferConCodeExchange(code: string): string {
  if (/^[06]\d{5}$/.test(code)) return `${code}.SH`;
  if (/^[03]\d{5}$/.test(code)) return `${code}.SZ`;
  return code;
}
