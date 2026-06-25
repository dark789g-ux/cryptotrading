import 'reflect-metadata';
import { Client } from 'pg';

function dbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'cryptouser',
    password: process.env.DB_PASS || 'cryptopass',
    database: process.env.DB_NAME || 'cryptodb',
  };
}

interface TradeDateRow {
  trade_date: string;
}

async function getTradeDates(client: Client, startDate: string, endDate: string): Promise<string[]> {
  const res = await client.query<TradeDateRow>(`
    SELECT DISTINCT trade_date
    FROM money_flow_stocks
    WHERE trade_date BETWEEN $1 AND $2
    ORDER BY trade_date
  `, [startDate, endDate]);
  return res.rows.map((r) => r.trade_date);
}

const AGGREGATION_SQL: Array<{ phase: string; sql: string }> = [
  {
    phase: 'sw_industry',
    sql: `
      INSERT INTO money_flow_industries (ts_code, trade_date, industry, pct_change, net_buy_amount, net_sell_amount, net_amount)
      SELECT s.sw_industry_l3_code AS ts_code,
             m.trade_date,
             c.name AS industry,
             NULL,
             NULL,
             NULL,
             SUM(m.net_amount)
      FROM money_flow_stocks m
      JOIN a_share_symbols s ON s.ts_code = m.ts_code
      JOIN sw_index_catalog c ON c.ts_code = s.sw_industry_l3_code AND c.level = 3
      WHERE m.trade_date = $1
        AND s.sw_industry_l3_code IS NOT NULL
      GROUP BY s.sw_industry_l3_code, m.trade_date, c.name
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        updated_at = NOW()
    `,
  },
  {
    phase: 'ths_industry',
    sql: `
      INSERT INTO money_flow_ths_industries (ts_code, trade_date, industry, pct_change, net_buy_amount, net_sell_amount, net_amount)
      SELECT t.ts_code,
             m.trade_date,
             c.name,
             NULL,
             NULL,
             NULL,
             SUM(m.net_amount)
      FROM money_flow_stocks m
      JOIN ths_member_stocks t ON t.con_code = m.ts_code
      JOIN ths_index_catalog c ON c.ts_code = t.ts_code AND c.type = 'I'
      WHERE m.trade_date = $1
      GROUP BY t.ts_code, m.trade_date, c.name
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        updated_at = NOW()
    `,
  },
  {
    phase: 'ths_sector',
    sql: `
      INSERT INTO money_flow_sectors (ts_code, trade_date, name, pct_change, net_buy_amount, net_sell_amount, net_amount)
      SELECT t.ts_code,
             m.trade_date,
             c.name,
             NULL,
             NULL,
             NULL,
             SUM(m.net_amount)
      FROM money_flow_stocks m
      JOIN ths_member_stocks t ON t.con_code = m.ts_code
      JOIN ths_index_catalog c ON c.ts_code = t.ts_code AND c.type = 'N'
      WHERE m.trade_date = $1
      GROUP BY t.ts_code, m.trade_date, c.name
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        updated_at = NOW()
    `,
  },
  {
    phase: 'index',
    sql: `
      INSERT INTO money_flow_index (ts_code, trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount)
      SELECT w.index_code AS ts_code,
             m.trade_date,
             SUM(m.net_amount),
             SUM(m.buy_lg_amount),
             SUM(m.buy_md_amount),
             SUM(m.buy_sm_amount)
      FROM money_flow_stocks m
      JOIN index_weight w ON w.con_code = m.ts_code
      WHERE m.trade_date = $1
        AND w.effective_date <= m.trade_date
        AND (w.expire_date IS NULL OR w.expire_date >= m.trade_date)
      GROUP BY w.index_code, m.trade_date
      ON CONFLICT (ts_code, trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        buy_lg_amount = EXCLUDED.buy_lg_amount,
        buy_md_amount = EXCLUDED.buy_md_amount,
        buy_sm_amount = EXCLUDED.buy_sm_amount,
        updated_at = NOW()
    `,
  },
  {
    phase: 'market',
    sql: `
      INSERT INTO money_flow_market (trade_date, net_amount, buy_lg_amount, buy_md_amount, buy_sm_amount)
      SELECT trade_date,
             SUM(net_amount),
             SUM(buy_lg_amount),
             SUM(buy_md_amount),
             SUM(buy_sm_amount)
      FROM money_flow_stocks
      WHERE trade_date = $1
      GROUP BY trade_date
      ON CONFLICT (trade_date)
      DO UPDATE SET
        net_amount = EXCLUDED.net_amount,
        buy_lg_amount = EXCLUDED.buy_lg_amount,
        buy_md_amount = EXCLUDED.buy_md_amount,
        buy_sm_amount = EXCLUDED.buy_sm_amount,
        updated_at = NOW()
    `,
  },
];

async function backfillDate(client: Client, tradeDate: string): Promise<void> {
  for (const { phase, sql } of AGGREGATION_SQL) {
    const res = await client.query(sql, [tradeDate]);
    console.log(`  ${phase}: ${res.rowCount ?? 0} rows`);
  }
}

async function main() {
  const startDate = process.argv[2];
  const endDate = process.argv[3];
  if (!startDate || !endDate) {
    console.error('Usage: ts-node backfill-money-flow-aggregation.ts <startDate> <endDate>');
    process.exitCode = 1;
    return;
  }

  const client = new Client(dbConfig());
  await client.connect();
  try {
    const tradeDates = await getTradeDates(client, startDate, endDate);
    console.log(`Backfilling ${tradeDates.length} trade dates from ${startDate} to ${endDate}`);
    for (const [index, tradeDate] of tradeDates.entries()) {
      console.log(`[${index + 1}/${tradeDates.length}] ${tradeDate}`);
      await backfillDate(client, tradeDate);
    }
    console.log('Money flow aggregation backfill done');
  } finally {
    await client.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
