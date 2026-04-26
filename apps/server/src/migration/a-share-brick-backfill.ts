import 'reflect-metadata';
import { Client } from 'pg';
import { calcBrickChartPoints } from '../indicators/brick-chart';

interface QuoteRow {
  tsCode: string;
  tradeDate: string;
  high: string | null;
  low: string | null;
  close: string | null;
}

interface SymbolRow {
  tsCode: string;
}

function dbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'cryptouser',
    password: process.env.DB_PASS || 'cryptopass',
    database: process.env.DB_NAME || 'cryptodb',
  };
}

async function loadSymbols(client: Client): Promise<string[]> {
  const res = await client.query<SymbolRow>(`
    SELECT DISTINCT q.ts_code AS "tsCode"
    FROM a_share_daily_quotes q
    INNER JOIN a_share_daily_indicators i
      ON i.ts_code = q.ts_code
     AND i.trade_date = q.trade_date
    WHERE q.high IS NOT NULL
      AND q.low IS NOT NULL
      AND q.close IS NOT NULL
      AND (i.brick IS NULL OR i.brick_delta IS NULL OR i.brick_xg IS NULL)
    ORDER BY q.ts_code
  `);
  return res.rows.map((row) => row.tsCode).filter((tsCode) => tsCode.length > 0);
}

async function loadQuotes(client: Client, tsCode: string): Promise<QuoteRow[]> {
  const res = await client.query<QuoteRow>(`
    SELECT
      q.ts_code AS "tsCode",
      q.trade_date AS "tradeDate",
      q.high,
      q.low,
      q.close
    FROM a_share_daily_quotes q
    INNER JOIN a_share_daily_indicators i
      ON i.ts_code = q.ts_code
     AND i.trade_date = q.trade_date
    WHERE q.ts_code = $1
      AND q.high IS NOT NULL
      AND q.low IS NOT NULL
      AND q.close IS NOT NULL
    ORDER BY q.trade_date ASC
  `, [tsCode]);
  return res.rows;
}

async function updateBrickIndicators(client: Client, tsCode: string, rows: QuoteRow[]): Promise<number> {
  if (!rows.length) return 0;
  const brickChart = calcBrickChartPoints(rows.map((row) => ({
    high: Number(row.high ?? 0),
    low: Number(row.low ?? 0),
    close: Number(row.close ?? 0),
  })));

  const chunkSize = 1000;
  let total = 0;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: Array<string | number | boolean> = [];
    const placeholders = chunk.map((row, index) => {
      const point = brickChart[start + index];
      const base = index * 5;
      values.push(tsCode, row.tradeDate, point.brick, point.delta, point.xg);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    const res = await client.query(`
      UPDATE a_share_daily_indicators AS target
      SET
        brick = source.brick::double precision,
        brick_delta = source.brick_delta::double precision,
        brick_xg = source.brick_xg::boolean,
        updated_at = now()
      FROM (
        VALUES ${placeholders.join(', ')}
      ) AS source(ts_code, trade_date, brick, brick_delta, brick_xg)
      WHERE target.ts_code = source.ts_code
        AND target.trade_date = source.trade_date
        AND (target.brick IS NULL OR target.brick_delta IS NULL OR target.brick_xg IS NULL)
    `, values);
    total += res.rowCount ?? 0;
  }
  return total;
}

async function main() {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const symbols = await loadSymbols(client);
    let total = 0;
    for (const [index, tsCode] of symbols.entries()) {
      const rows = await loadQuotes(client, tsCode);
      const updated = await updateBrickIndicators(client, tsCode, rows);
      total += updated;
      console.log(`[${index + 1}/${symbols.length}] ${tsCode}: updated=${updated}`);
    }
    console.log(`A share BRICK backfilled: symbols=${symbols.length}, rows=${total}`);
  } finally {
    await client.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
