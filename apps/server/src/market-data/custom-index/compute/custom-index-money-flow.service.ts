import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { resolvePitMembers } from './custom-index-weight-resolver';
import type {
  CustomIndexMoneyFlowRow,
  WeightVersion,
} from './custom-index-compute.types';

interface MoneyFlowStockDbRow {
  ts_code: string;
  trade_date: string;
  net_amount: string | number | null;
  buy_lg_amount: string | number | null;
  buy_md_amount: string | number | null;
  buy_sm_amount: string | number | null;
}

export interface MoneyFlowByDateCode {
  netAmount: number | null;
  buyLgAmount: number | null;
  buyMdAmount: number | null;
  buySmAmount: number | null;
}

function parseFlowAmount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

/** 纯函数：PIT 等权 SUM（缺失 skip，不补零）。 */
export function aggregateMoneyFlowFromRows(params: {
  customIndexId: string;
  versions: readonly WeightVersion[];
  tradeDates: readonly string[];
  flowByDateCode: Record<string, Record<string, MoneyFlowByDateCode>>;
}): CustomIndexMoneyFlowRow[] {
  const { customIndexId, versions, tradeDates, flowByDateCode } = params;
  const out: CustomIndexMoneyFlowRow[] = [];

  for (const tradeDate of tradeDates) {
    const members = resolvePitMembers(versions, tradeDate);
    const pitCodes = new Set(members.map((m) => m.conCode));
    const dayFlow = flowByDateCode[tradeDate] ?? {};

    let net = 0;
    let lg = 0;
    let md = 0;
    let sm = 0;
    let netHas = false;
    let lgHas = false;
    let mdHas = false;
    let smHas = false;

    for (const code of pitCodes) {
      const item = dayFlow[code];
      if (item === undefined) {
        continue;
      }
      if (item.netAmount !== null) {
        net += item.netAmount;
        netHas = true;
      }
      if (item.buyLgAmount !== null) {
        lg += item.buyLgAmount;
        lgHas = true;
      }
      if (item.buyMdAmount !== null) {
        md += item.buyMdAmount;
        mdHas = true;
      }
      if (item.buySmAmount !== null) {
        sm += item.buySmAmount;
        smHas = true;
      }
    }

    if (!netHas && !lgHas && !mdHas && !smHas) {
      continue;
    }

    out.push({
      customIndexId,
      tradeDate,
      netAmount: netHas ? net : null,
      buyLgAmount: lgHas ? lg : null,
      buyMdAmount: mdHas ? md : null,
      buySmAmount: smHas ? sm : null,
    });
  }

  return out;
}

@Injectable()
export class CustomIndexMoneyFlowService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async aggregateMoneyFlow(params: {
    customIndexId: string;
    versions: readonly WeightVersion[];
    tradeDates: readonly string[];
  }): Promise<CustomIndexMoneyFlowRow[]> {
    const { customIndexId, versions, tradeDates } = params;

    if (tradeDates.length === 0) {
      return [];
    }

    const minDate = tradeDates.reduce((a, b) => (a < b ? a : b));
    const maxDate = tradeDates.reduce((a, b) => (a > b ? a : b));

    const allCodes = new Set<string>();
    for (const version of versions) {
      for (const member of version.members) {
        allCodes.add(member.conCode);
      }
    }
    if (allCodes.size === 0) {
      return [];
    }

    const rows = await this.dataSource.query<MoneyFlowStockDbRow[]>(
      `
      SELECT ts_code, trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount
      FROM money_flow_stocks
      WHERE ts_code = ANY($1)
        AND trade_date >= $2
        AND trade_date <= $3
      ORDER BY trade_date ASC
      `,
      [Array.from(allCodes), minDate, maxDate],
    );

    const flowByDateCode: Record<string, Record<string, MoneyFlowByDateCode>> =
      {};
    for (const row of rows) {
      const td = String(row.trade_date);
      const code = String(row.ts_code);
      if (!flowByDateCode[td]) {
        flowByDateCode[td] = {};
      }
      flowByDateCode[td][code] = {
        netAmount: parseFlowAmount(row.net_amount),
        buyLgAmount: parseFlowAmount(row.buy_lg_amount),
        buyMdAmount: parseFlowAmount(row.buy_md_amount),
        buySmAmount: parseFlowAmount(row.buy_sm_amount),
      };
    }

    return aggregateMoneyFlowFromRows({
      customIndexId,
      versions,
      tradeDates,
      flowByDateCode,
    });
  }
}
