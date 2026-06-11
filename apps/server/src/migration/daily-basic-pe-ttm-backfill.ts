import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Client } from 'pg';
import axios, { type AxiosError } from 'axios';

/**
 * 一次性回填：raw.daily_basic.pe_ttm 断层补齐。
 *
 * 背景：pe_ttm 列于 2026-04-28（commit 860cb9c）才加入同步 fields 与表结构。
 * 2023-01 ~ 2026-04 这批数据是在此之前（2026-04-26）批量灌入的，pe_ttm 全为 NULL；
 * 2022 已于 2026-06-09 用 overwrite 重新回填，但 2023-01 ~ 2026-04 漏补。
 * Tushare daily_basic 历史区间含 pe_ttm（官方文档：市盈率(TTM)，亏损的 PE 为空）。
 *
 * 本脚本只补 pe_ttm 单列，不触碰 pe/pb 等既有正确数据，不触发 daily/adj_factor 重拉
 * 与 qfq/技术指标重算级联——与走 overwrite 同步端点相比爆炸半径最小。
 *
 * 字段名以 Tushare 官方 daily_basic 文档为准：ts_code / trade_date / pe_ttm。
 * 亏损股 pe_ttm 合法为 NULL，不进硬约束：Tushare 返回 NULL 时保持 NULL（不计入更新）。
 *
 * 运行：
 *   pnpm --filter @cryptotrading/server exec ts-node -r tsconfig-paths/register \
 *     src/migration/daily-basic-pe-ttm-backfill.ts [--dry-run] [--start YYYYMMDD] [--end YYYYMMDD]
 *
 * 幂等：仅 UPDATE pe_ttm IS NULL 的行，可安全重跑。
 */

// 仓库根 .env（与 NestJS ConfigModule 同源）；已存在的 process.env 优先，不覆盖。
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const TUSHARE_ENDPOINT = 'http://api.tushare.pro';
const DEFAULT_START = '20230101';
const DEFAULT_END = '20260430';

interface TushareResponse {
  code: number;
  msg: string | null;
  data?: { fields: string[]; items: unknown[][] };
}

interface CliArgs {
  dryRun: boolean;
  startDate: string;
  endDate: string;
}

interface PeTtmRow {
  tsCode: string;
  tradeDate: string;
  peTtm: string;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let startDate = DEFAULT_START;
  let endDate = DEFAULT_END;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--start') startDate = argv[++i];
    else if (arg === '--end') endDate = argv[++i];
  }
  if (!/^\d{8}$/.test(startDate) || !/^\d{8}$/.test(endDate)) {
    throw new Error(`--start/--end 须为 YYYYMMDD：start=${startDate} end=${endDate}`);
  }
  return { dryRun, startDate, endDate };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIN_INTERVAL_MS = Math.max(Number(process.env.TUSHARE_MIN_INTERVAL_MS) || 0, 250);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
let lastRequestAt = 0;

function isRateLimitMsg(msg: string | null): boolean {
  const m = String(msg ?? '').toLowerCase();
  return ['timeout', 'timed out', 'rate', 'too many', 'limit', 'busy', 'temporar',
    '超时', '频率', '限流', '稍后', '繁忙', '服务忙'].some((p) => m.includes(p));
}

function isRetryableError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const e = err as AxiosError;
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') return true;
  if (!e.response) return true;
  return e.response.status === 429 || e.response.status >= 500;
}

/**
 * 调 Tushare daily_basic，返回 pe_ttm 非空的行。
 * 双路径空数据告警（data=null / items=[]）并以 'empty' 标记返回，调用方不得当作成功。
 */
async function fetchPeTtm(
  token: string,
  tradeDate: string,
): Promise<{ rows: PeTtmRow[]; empty: boolean; truncated: boolean }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await delay(wait);
    lastRequestAt = Date.now();
    try {
      const res = await axios.post<TushareResponse>(
        TUSHARE_ENDPOINT,
        { api_name: 'daily_basic', token, params: { trade_date: tradeDate }, fields: 'ts_code,trade_date,pe_ttm' },
        { timeout: 30000 },
      );
      const payload = res.data;
      if (payload.code !== 0) {
        if (isRateLimitMsg(payload.msg) && attempt < MAX_ATTEMPTS) {
          lastError = new Error(`daily_basic code!=0: ${payload.msg}`);
          await delay(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        throw new Error(`TuShare daily_basic 调用失败 ${tradeDate}：${payload.msg ?? payload.code}`);
      }
      const data = payload.data;
      if (!data) {
        console.warn(`[WARN] daily_basic ${tradeDate} 返回 data=null（code=0），可能积分不足或当日无数据`);
        return { rows: [], empty: true, truncated: false };
      }
      if (!data.items || data.items.length === 0) {
        console.warn(`[WARN] daily_basic ${tradeDate} 返回 items=[]（code=0），日期可能不在覆盖范围或未发布`);
        return { rows: [], empty: true, truncated: false };
      }
      const idx = {
        ts_code: data.fields.indexOf('ts_code'),
        trade_date: data.fields.indexOf('trade_date'),
        pe_ttm: data.fields.indexOf('pe_ttm'),
      };
      const rows: PeTtmRow[] = [];
      for (const item of data.items) {
        const peTtm = item[idx.pe_ttm];
        if (peTtm === null || peTtm === undefined || peTtm === '') continue; // 亏损股合法 NULL，跳过
        rows.push({
          tsCode: String(item[idx.ts_code]),
          tradeDate: String(item[idx.trade_date]),
          peTtm: String(peTtm),
        });
      }
      return { rows, empty: false, truncated: data.items.length >= 6000 };
    } catch (err: unknown) {
      lastError = err;
      if (isRetryableError(err) && attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`daily_basic ${tradeDate} 重试耗尽`);
}

async function loadGapTradeDates(client: Client, startDate: string, endDate: string): Promise<string[]> {
  const res = await client.query<{ tradeDate: string }>(`
    SELECT DISTINCT trade_date AS "tradeDate"
    FROM raw.daily_basic
    WHERE trade_date >= $1 AND trade_date <= $2 AND pe_ttm IS NULL
    ORDER BY trade_date ASC
  `, [startDate, endDate]);
  return res.rows.map((r) => r.tradeDate);
}

/** 只更新 pe_ttm IS NULL 的行（幂等），返回实际写入行数。 */
async function updatePeTtm(client: Client, rows: PeTtmRow[]): Promise<number> {
  if (!rows.length) return 0;
  const chunkSize = 1000;
  let total = 0;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: Array<string> = [];
    const placeholders = chunk.map((row, index) => {
      const base = index * 3;
      values.push(row.tsCode, row.tradeDate, row.peTtm);
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });
    const res = await client.query(`
      UPDATE raw.daily_basic AS target
      SET pe_ttm = source.pe_ttm::numeric(30,10),
          updated_at = now()
      FROM (VALUES ${placeholders.join(', ')}) AS source(ts_code, trade_date, pe_ttm)
      WHERE target.ts_code = source.ts_code
        AND target.trade_date = source.trade_date
        AND target.pe_ttm IS NULL
    `, values);
    total += res.rowCount ?? 0;
  }
  return total;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.TUSHARE_TOKEN;
  if (!token) throw new Error('TUSHARE_TOKEN 未配置（仓库根 .env），无法回填 daily_basic.pe_ttm');

  const client = new Client(dbConfig());
  await client.connect();
  try {
    const dates = await loadGapTradeDates(client, args.startDate, args.endDate);
    console.log(`[INFO] 断层窗口 ${args.startDate}~${args.endDate}：待补交易日 ${dates.length} 个${args.dryRun ? '（dry-run，不写库）' : ''}`);
    if (args.dryRun) {
      console.log(`[INFO] dry-run 结束，首尾日：${dates[0] ?? '-'} ... ${dates[dates.length - 1] ?? '-'}`);
      return;
    }

    let totalUpdated = 0;
    const emptyDates: string[] = [];
    const failedDates: Array<{ tradeDate: string; message: string }> = [];
    const truncatedDates: string[] = [];

    for (const [index, tradeDate] of dates.entries()) {
      try {
        const { rows, empty, truncated } = await fetchPeTtm(token, tradeDate);
        if (empty) {
          emptyDates.push(tradeDate);
          console.log(`[${index + 1}/${dates.length}] ${tradeDate}: 空数据，跳过`);
          continue;
        }
        if (truncated) truncatedDates.push(tradeDate);
        const updated = await updatePeTtm(client, rows);
        totalUpdated += updated;
        console.log(`[${index + 1}/${dates.length}] ${tradeDate}: fetched=${rows.length} updated=${updated}${truncated ? ' [!截断>=6000]' : ''}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failedDates.push({ tradeDate, message });
        console.error(`[${index + 1}/${dates.length}] ${tradeDate}: 失败 ${message}`);
      }
    }

    console.log('========== 回填汇总 ==========');
    console.log(`交易日总数：${dates.length}`);
    console.log(`pe_ttm 写入行数：${totalUpdated}`);
    console.log(`空数据日（Tushare 无返回）：${emptyDates.length}${emptyDates.length ? ' -> ' + emptyDates.join(',') : ''}`);
    console.log(`失败日：${failedDates.length}${failedDates.length ? ' -> ' + failedDates.map((f) => f.tradeDate).join(',') : ''}`);
    if (truncatedDates.length) console.warn(`[WARN] 疑似截断(>=6000)日：${truncatedDates.join(',')}`);
    if (failedDates.length) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
