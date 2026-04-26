import 'reflect-metadata';
import { Client } from 'pg';
import { calcBrickChartPoints } from '../indicators/brick-chart';
import { calcIndicators, KlineRow } from '../indicators/indicators';

interface QuoteRow {
  tsCode: string;
  tradeDate: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  vol: string | null;
  amount: string | null;
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
    SELECT DISTINCT ts_code AS "tsCode"
    FROM a_share_daily_quotes
    ORDER BY ts_code
  `);
  return res.rows.map((row) => row.tsCode).filter((tsCode) => tsCode.length > 0);
}

async function loadQuotes(client: Client, tsCode: string): Promise<QuoteRow[]> {
  const res = await client.query<QuoteRow>(`
    SELECT
      ts_code AS "tsCode",
      trade_date AS "tradeDate",
      open,
      high,
      low,
      close,
      vol,
      amount
    FROM a_share_daily_quotes
    WHERE ts_code = $1
      AND open IS NOT NULL
      AND high IS NOT NULL
      AND low IS NOT NULL
      AND close IS NOT NULL
    ORDER BY trade_date ASC
  `, [tsCode]);
  return res.rows;
}

async function upsertIndicators(client: Client, tsCode: string, rows: QuoteRow[]): Promise<number> {
  if (!rows.length) return 0;
  const withIndicators = calcIndicators(rows.map((row): KlineRow => ({
    open_time: row.tradeDate,
    open: row.open ?? 0,
    high: row.high ?? 0,
    low: row.low ?? 0,
    close: row.close ?? 0,
    volume: row.vol ?? 0,
    quote_volume: row.amount ?? 0,
  })));
  const brickChart = calcBrickChartPoints(rows.map((row) => ({
    high: Number(row.high ?? 0),
    low: Number(row.low ?? 0),
    close: Number(row.close ?? 0),
  })));

  const chunkSize = 500;
  for (let start = 0; start < withIndicators.length; start += chunkSize) {
    const chunk = withIndicators.slice(start, start + chunkSize);
    const values: Array<string | number | boolean | null> = [];
    const placeholders = chunk.map((row, index) => {
      const base = index * 24;
      const source = rows[start + index];
      values.push(
        tsCode,
        source.tradeDate,
        row.DIF,
        row.DEA,
        row.MACD,
        row['KDJ.K'],
        row['KDJ.D'],
        row['KDJ.J'],
        row.BBI,
        row.MA5,
        row.MA30,
        row.MA60,
        row.MA120,
        row.MA240,
        row['10_quote_volume'],
        row.atr_14,
        row.loss_atr_14,
        row.low_9,
        row.high_9,
        row.stop_loss_pct,
        row.risk_reward_ratio,
        brickChart[start + index]?.brick ?? null,
        brickChart[start + index]?.delta ?? null,
        brickChart[start + index]?.xg ?? null,
      );
      return `(${Array.from({ length: 24 }, (_, offset) => `$${base + offset + 1}`).join(', ')})`;
    });

    await client.query(`
      INSERT INTO a_share_daily_indicators (
        ts_code,
        trade_date,
        dif,
        dea,
        macd,
        kdj_k,
        kdj_d,
        kdj_j,
        bbi,
        ma5,
        ma30,
        ma60,
        ma120,
        ma240,
        quote_volume_10,
        atr_14,
        loss_atr_14,
        low_9,
        high_9,
        stop_loss_pct,
        risk_reward_ratio,
        brick,
        brick_delta,
        brick_xg
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (ts_code, trade_date) DO UPDATE SET
        dif = EXCLUDED.dif,
        dea = EXCLUDED.dea,
        macd = EXCLUDED.macd,
        kdj_k = EXCLUDED.kdj_k,
        kdj_d = EXCLUDED.kdj_d,
        kdj_j = EXCLUDED.kdj_j,
        bbi = EXCLUDED.bbi,
        ma5 = EXCLUDED.ma5,
        ma30 = EXCLUDED.ma30,
        ma60 = EXCLUDED.ma60,
        ma120 = EXCLUDED.ma120,
        ma240 = EXCLUDED.ma240,
        quote_volume_10 = EXCLUDED.quote_volume_10,
        atr_14 = EXCLUDED.atr_14,
        loss_atr_14 = EXCLUDED.loss_atr_14,
        low_9 = EXCLUDED.low_9,
        high_9 = EXCLUDED.high_9,
        stop_loss_pct = EXCLUDED.stop_loss_pct,
        risk_reward_ratio = EXCLUDED.risk_reward_ratio,
        brick = EXCLUDED.brick,
        brick_delta = EXCLUDED.brick_delta,
        brick_xg = EXCLUDED.brick_xg,
        updated_at = now()
    `, values);
  }
  return withIndicators.length;
}

async function main() {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const symbols = await loadSymbols(client);
    let total = 0;
    for (const tsCode of symbols) {
      const rows = await loadQuotes(client, tsCode);
      total += await upsertIndicators(client, tsCode, rows);
    }
    console.log(`A share indicators backfilled: symbols=${symbols.length}, rows=${total}`);
  } finally {
    await client.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
