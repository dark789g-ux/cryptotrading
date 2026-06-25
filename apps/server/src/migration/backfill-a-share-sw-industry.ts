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

async function main() {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const res = await client.query(`
      UPDATE a_share_symbols s
      SET
        sw_industry_l1_code = im.l1_code,
        sw_industry_l2_code = im.l2_code,
        sw_industry_l3_code = im.l3_code
      FROM (
        SELECT DISTINCT ON (ts_code)
          ts_code, l1_code, l2_code, l3_code
        FROM raw.index_member
        WHERE is_new = 'Y' OR out_date IS NULL
        ORDER BY ts_code, in_date DESC
      ) im
      WHERE s.ts_code = im.ts_code
    `);
    console.log(`A share SW industry backfilled: rows=${res.rowCount ?? 0}`);
  } finally {
    await client.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
