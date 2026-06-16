// 「一键同步」8 步执行器 —— 忠实搬运前端 useOneClickSync.ts 的 range/mode + success/failed 判定。
//
// 每个 runner 接收一个 StepContext（提供 6 个底层 service + 改内存步骤态的回调 + pushLog），
// 不直接碰 DB / 实体；DB 节流刷库由编排器在事件回调里做。
//
// SSE 步骤（0-3）：订阅各 service 的 startSync() Subject，用 awaitSubject 转 Promise；
//   done 事件携带 result/summary，据此判 success/failed（照搬前端 runBaseData/runAShares/…）。
// 普通步骤（4-7）：直接 await，rowsWritten 取返回的 synced；抛错→该步 failed。

import type { Subject } from 'rxjs';
import type { BaseDataSyncService } from '../base-data-sync/base-data-sync.service';
import type { SyncEvent as BaseDataSyncEvent, StoredRange } from '../base-data-sync/base-data-sync.types';
import type { ASharesService } from '../a-shares/a-shares.service';
import type { ASharesSyncEvent } from '../a-shares/a-shares.types';
import type { MoneyFlowSyncService } from '../money-flow/money-flow-sync.service';
import type { ThsIndexDailySyncService } from '../ths-index-daily/ths-index-daily-sync.service';
import type { ThsIndexDailySyncEvent } from '../ths-index-daily/ths-index-daily.types';
import type { ActiveMvService } from '../active-mv/active-mv.service';
import type { OamvService } from '../oamv/oamv.service';
import type { MoneyFlowSyncEvent, MoneyFlowSyncResult, MoneyFlowSyncSummary } from '@cryptotrading/shared-types';
import type { OneClickErrorItem, OneClickStepKey, OneClickStepState, OneClickStepStatus } from './types';

/** 一键同步范围（YYYYMMDD），供 a-shares/money-flow/ths/AMV/0AMV 复用。 */
export interface SyncRange {
  startDate: string;
  endDate: string;
}

/** 编排器注入给各 runner 的依赖与回调。 */
export interface StepContext {
  range: SyncRange;
  services: {
    baseData: BaseDataSyncService;
    aShares: ASharesService;
    moneyFlow: MoneyFlowSyncService;
    thsIndexDaily: ThsIndexDailySyncService;
    activeMv: ActiveMvService;
    oamv: OamvService;
  };
  /** 改某步内存态后触发节流刷库（编排器实现）。 */
  patchStep: (index: number, patch: Partial<OneClickStepState>) => void;
  /** 设步骤状态（含 startedAt/finishedAt 自动盖戳）。 */
  setStatus: (index: number, status: OneClickStepStatus) => void;
  /** 追加一条日志。 */
  pushLog: (step: OneClickStepKey | 'system', level: 'info' | 'warn' | 'error', text: string) => void;
  /** 读当前 step 引用（runner 直接 push errors）。 */
  getStep: (index: number) => OneClickStepState;
  /** 节流刷库（progress 事件触发）。 */
  flushThrottled: () => void;
}

/** 订阅 Subject → 可 await 的 Promise；next 转发到 onEvent，complete resolve，error reject。 */
export function awaitSubject<E>(subject: Subject<E>, onEvent: (e: E) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    subject.subscribe({
      next: (e) => onEvent(e),
      complete: () => resolve(),
      error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
    });
  });
}

const PHASE_LABEL_MAP: Record<keyof MoneyFlowSyncSummary, string> = {
  stocks: '个股',
  industries: '行业',
  sectors: '板块',
  market: '大盘',
};

/**
 * base-data「确定性预期空」的 apiName 集合：增量区间 [水位+1, 今日] 内无开市日（周末/节假日）
 * → base-data-sync 提前返回 no_open_trade_dates。市场本就没开市、无数据可拉，属确定性预期空，
 * 一键编排判该步「无新数据 success」、不计入失败（约束①：豁免「未来日/无交易日」）。
 *
 * ★不含 stk_limit_empty / trade_cal_empty —— 那是「应有数据却空」的异常空，仍按 data-integrity
 *   规范判 failed。base-data-sync.service 始终把它们 push 进 errors 并 logger.warn（双路径 warn +
 *   显式 failedItems 在源头完整保留），本处只在 errors **全部**属本集合时才豁免，绝不吞异常空。
 */
const BASE_DATA_EXPECTED_EMPTY_API = new Set<string>(['no_open_trade_dates']);

// ── Step0 基础数据（base-data）────────────────────────────────────────
// 用 base-data 自身的增量默认范围（不复用一键 dateRange）——镜像前端 useBaseDataSync：
//   [stkLimit.max + 1 天, 今日]；库存空时兜底 [今日-30天, 今日]。
export async function runBaseData(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'base-data';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始基础数据同步');
  try {
    const resolved = await resolveBaseDataRange(ctx.services.baseData);
    if (resolved.kind === 'no-new-day') {
      // 增量水位已 ≥ 今日：起点落在未来，无新自然日可拉 → 跳过空拉取（避免未来日伪失败）。
      ctx.patchStep(index, { rowsWritten: 0, percent: 100, message: '已是最新：无新交易日可同步' });
      ctx.setStatus(index, 'success');
      ctx.pushLog(key, 'info', '基础数据已是最新（增量起点晚于今日），无新交易日，跳过同步');
      return;
    }
    const range = resolved.range;
    let doneResult: BaseDataSyncEvent | null = null;
    const subject = ctx.services.baseData.startSync({
      start_date: range.startDate,
      end_date: range.endDate,
      syncMode: 'incremental',
    });
    await awaitSubject(subject, (e) => {
      if (e.type === 'progress') {
        ctx.patchStep(index, {
          phase: e.phase,
          percent: clampPct(e.percent),
          message: e.message,
        });
        ctx.flushThrottled();
      } else if (e.type === 'done') {
        doneResult = e;
      } else if (e.type === 'error') {
        doneResult = e;
      }
    });
    applyBaseDataDone(ctx, index, key, doneResult);
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

/** base-data 增量范围解析结果：可拉的区间，或「无新自然日可拉」（水位已 ≥ 今日）。 */
type ResolvedBaseDataRange = { kind: 'range'; range: SyncRange } | { kind: 'no-new-day' };

async function resolveBaseDataRange(service: BaseDataSyncService): Promise<ResolvedBaseDataRange> {
  const stored: StoredRange = await service.getStoredRange();
  const max = stored.stkLimit?.max ?? null;
  const end = todayYyyymmdd();
  if (max && /^\d{8}$/.test(max)) {
    const start = shiftYyyymmdd(max, 1);
    // 水位 ≥ 今日 → 起点落在未来：不再造 [明日,明日] 空区间（那会触发 stk_limit_empty 伪失败），
    // 直接告知调用方「无新自然日」。
    if (start > end) return { kind: 'no-new-day' };
    return { kind: 'range', range: { startDate: start, endDate: end } };
  }
  // 库存空：兜底近 30 天。
  return { kind: 'range', range: { startDate: shiftYyyymmdd(end, -30), endDate: end } };
}

function applyBaseDataDone(
  ctx: StepContext,
  index: number,
  key: OneClickStepKey,
  event: BaseDataSyncEvent | null,
): void {
  if (!event || event.type !== 'done') {
    ctx.setStatus(index, 'failed');
    ctx.getStep(index).errors.push({
      step: key,
      level: 'error',
      message: (event?.type === 'error' ? event.message : '') || '基础数据同步失败',
    });
    return;
  }
  const res = event.result;
  ctx.patchStep(index, { rowsWritten: res?.success ?? 0, percent: 100 });
  const warns = res?.warnings ?? [];
  if (warns.length > 0) {
    ctx.pushLog(key, 'info', `空日警告 ${warns.length} 项（suspend_d 当日无停复牌，正常）`);
  }
  const errs = res?.errors ?? [];
  if (errs.length > 0) {
    // 「确定性预期空」豁免：errors **全部**属 no_open_trade_dates（区间无开市日，如周末/节假日）
    // → 判该步 success、不计入失败、不落 error 项。混入任何异常空（stk_limit_empty 等）则不豁免。
    if (errs.every((e) => BASE_DATA_EXPECTED_EMPTY_API.has(e.apiName))) {
      ctx.patchStep(index, { message: '无新交易日：区间内无开市日，无新数据' });
      ctx.pushLog(
        key,
        'info',
        `区间内无开市日（${errs.map((e) => e.apiName).join(',')}），无新交易日数据，判为成功`,
      );
      ctx.setStatus(index, 'success');
      return;
    }
    for (const e of errs) {
      const item: OneClickErrorItem = {
        step: key,
        level: 'warn',
        apiName: e.apiName,
        message: e.message ?? JSON.stringify(e.params ?? {}),
      };
      ctx.getStep(index).errors.push(item);
      ctx.pushLog(key, 'warn', `[${item.apiName}] ${item.message}`);
    }
    ctx.setStatus(index, 'failed');
  } else {
    ctx.setStatus(index, 'success');
  }
}

// ── Step1 A 股数据（a-shares）─────────────────────────────────────────
// 照搬前端 runAShares：done 事件→success（不看 failedCount），error 事件→failed。
export async function runAShares(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'a-shares';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始 A 股数据同步');
  try {
    let finalEvent: ASharesSyncEvent | null = null;
    const subject = ctx.services.aShares.startSync({
      startDate: ctx.range.startDate,
      endDate: ctx.range.endDate,
      syncMode: 'incremental',
    });
    await awaitSubject(subject, (e) => {
      if (e.type === 'progress') {
        ctx.patchStep(index, {
          phase: e.phase ?? ctx.getStep(index).phase,
          percent: clampPct(e.percent ?? 0),
          message: e.message ?? ctx.getStep(index).message,
        });
        ctx.flushThrottled();
      } else if (e.type === 'done' || e.type === 'error') {
        finalEvent = e;
      }
    });
    applyASharesDone(ctx, index, key, finalEvent);
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

function applyASharesDone(
  ctx: StepContext,
  index: number,
  key: OneClickStepKey,
  event: ASharesSyncEvent | null,
): void {
  if (event && event.type === 'done') {
    const msg = event.message || '同步成功';
    ctx.patchStep(index, { message: msg, percent: 100 });
    ctx.setStatus(index, 'success');
    ctx.pushLog(key, 'info', `完成：${msg}`);
  } else {
    ctx.setStatus(index, 'failed');
    const message = (event?.type === 'error' ? event.message : '') || 'A 股同步失败';
    ctx.getStep(index).errors.push({ step: key, level: 'error', message });
    ctx.pushLog(key, 'error', message);
  }
}

// ── Step2 资金流向（money-flow）────────────────────────────────────────
// 照搬前端 runMoneyFlow：done.summary 各维度 errors[] → 步骤 errors；rowsWritten = Σ summary.success。
export async function runMoneyFlow(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'money-flow';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始资金流向同步');
  try {
    let finalEvent: MoneyFlowSyncEvent | null = null;
    const subject = ctx.services.moneyFlow.startSync({
      start_date: ctx.range.startDate,
      end_date: ctx.range.endDate,
      syncMode: 'incremental',
    });
    await awaitSubject(subject, (e) => {
      if (e.type === 'progress') {
        ctx.patchStep(index, {
          phase: e.phase,
          percent: clampPct(e.percent),
          message: e.message,
        });
        ctx.flushThrottled();
      } else if (e.type === 'done' || e.type === 'error') {
        finalEvent = e;
      }
    });
    applyMoneyFlowDone(ctx, index, key, finalEvent);
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

function applyMoneyFlowDone(
  ctx: StepContext,
  index: number,
  key: OneClickStepKey,
  event: MoneyFlowSyncEvent | null,
): void {
  if (!event || event.type !== 'done') {
    ctx.setStatus(index, 'failed');
    ctx.getStep(index).errors.push({
      step: key,
      level: 'error',
      message: (event?.type === 'error' ? event.message : '') || '资金流向同步失败',
    });
    return;
  }
  // done.summary 可能是 MoneyFlowSyncSummary（个股/行业/板块/大盘四维度）。
  const summary = event.summary as Partial<MoneyFlowSyncSummary> | undefined;
  let rows = 0;
  const errorItems: OneClickErrorItem[] = [];
  if (summary && typeof summary === 'object') {
    for (const [k, r] of Object.entries(summary) as Array<[string, MoneyFlowSyncResult | undefined]>) {
      if (!r) continue;
      if (typeof r.success === 'number') rows += r.success;
      const phaseLabel = PHASE_LABEL_MAP[k as keyof MoneyFlowSyncSummary] ?? k;
      for (const errText of r.errors ?? []) {
        errorItems.push({ step: key, level: 'warn', apiName: phaseLabel, message: errText });
      }
    }
  }
  ctx.patchStep(index, { rowsWritten: rows, percent: 100 });
  if (errorItems.length > 0) {
    for (const item of errorItems) {
      ctx.getStep(index).errors.push(item);
      ctx.pushLog(key, 'warn', `[${item.apiName}] ${item.message}`);
    }
    ctx.setStatus(index, 'failed');
  } else {
    ctx.setStatus(index, 'success');
  }
}

// ── Step3 指数日线（ths-index-daily）──────────────────────────────────
// 照搬前端 runThsIndexDaily：done.result.errors[] → 步骤 errors；rowsWritten = result.success。
export async function runThsIndexDaily(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'ths-index-daily';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始指数日线同步');
  try {
    let finalEvent: ThsIndexDailySyncEvent | null = null;
    const subject = ctx.services.thsIndexDaily.startSync({
      start_date: ctx.range.startDate,
      end_date: ctx.range.endDate,
      syncMode: 'incremental',
    });
    await awaitSubject(subject, (e) => {
      if (e.type === 'progress') {
        ctx.patchStep(index, {
          phase: e.phase,
          percent: clampPct(e.percent),
          message: e.message,
        });
        ctx.flushThrottled();
      } else if (e.type === 'done' || e.type === 'error') {
        finalEvent = e;
      }
    });
    applyThsIndexDone(ctx, index, key, finalEvent);
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

function applyThsIndexDone(
  ctx: StepContext,
  index: number,
  key: OneClickStepKey,
  event: ThsIndexDailySyncEvent | null,
): void {
  if (!event || event.type !== 'done') {
    ctx.setStatus(index, 'failed');
    ctx.getStep(index).errors.push({
      step: key,
      level: 'error',
      message: (event?.type === 'error' ? event.message : '') || '指数日线同步失败',
    });
    return;
  }
  const res = event.result;
  ctx.patchStep(index, { rowsWritten: res?.success ?? 0, percent: 100 });
  const errs = res?.errors ?? [];
  if (errs.length > 0) {
    for (const e of errs) {
      const item: OneClickErrorItem = {
        step: key,
        level: 'warn',
        apiName: e.apiName,
        message: e.message ?? JSON.stringify(e.params ?? {}),
      };
      ctx.getStep(index).errors.push(item);
      ctx.pushLog(key, 'warn', `[${item.apiName}] ${item.message}`);
    }
    ctx.setStatus(index, 'failed');
  } else {
    ctx.setStatus(index, 'success');
  }
}

// ── Step4-6 三类 AMV（普通 await）─────────────────────────────────────
export async function runStockAmv(ctx: StepContext, index: number): Promise<void> {
  await runAmvStep(ctx, index, 'stock-amv', '同步个股 AMV', (opts) => ctx.services.activeMv.syncStock(opts));
}

export async function runIndustryAmv(ctx: StepContext, index: number): Promise<void> {
  await runAmvStep(ctx, index, 'industry-amv', '同步行业指数 AMV', (opts) =>
    ctx.services.activeMv.syncIndustry(opts),
  );
}

export async function runConceptAmv(ctx: StepContext, index: number): Promise<void> {
  await runAmvStep(ctx, index, 'concept-amv', '同步板块（概念）AMV', (opts) =>
    ctx.services.activeMv.syncConcept(opts),
  );
}

async function runAmvStep(
  ctx: StepContext,
  index: number,
  key: OneClickStepKey,
  phaseLabel: string,
  doSync: (opts: { startDate: string; endDate: string; syncMode: 'incremental' }) => Promise<{ synced: number }>,
): Promise<void> {
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', `开始 ${phaseLabel}（增量模式）`);
  try {
    ctx.patchStep(index, {
      phase: phaseLabel,
      message: '当前为增量模式（全量回填请走各自同步页）',
      percent: 30,
    });
    ctx.flushThrottled();
    const result = await doSync({
      startDate: ctx.range.startDate,
      endDate: ctx.range.endDate,
      syncMode: 'incremental',
    });
    const synced = result?.synced ?? 0;
    ctx.patchStep(index, { rowsWritten: synced, percent: 100 });
    ctx.setStatus(index, 'success');
    ctx.pushLog(key, 'info', `${phaseLabel} 完成，写入 ${synced} 行`);
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

// ── Step7 大盘 0AMV（普通 await）──────────────────────────────────────
export async function runOamv(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'oamv';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始 0AMV 同步');
  try {
    ctx.patchStep(index, { phase: '同步 0AMV', percent: 30 });
    ctx.flushThrottled();
    const result = await ctx.services.oamv.sync0amv({
      startDate: ctx.range.startDate,
      endDate: ctx.range.endDate,
      syncMode: 'incremental',
    });
    ctx.patchStep(index, { rowsWritten: result?.synced ?? 0, percent: 100 });
    ctx.setStatus(index, 'success');
    ctx.pushLog(key, 'info', '0AMV 同步完成');
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

// ── 共用工具 ──────────────────────────────────────────────────────────
function failStep(ctx: StepContext, index: number, key: OneClickStepKey, e: unknown): void {
  ctx.setStatus(index, 'failed');
  const msg = e instanceof Error ? e.message : String(e);
  ctx.getStep(index).errors.push({ step: key, level: 'error', message: msg });
  ctx.pushLog(key, 'error', msg);
}

function clampPct(p: number): number {
  return Math.max(0, Math.min(100, Math.round(p || 0)));
}

/** 今日（本机本地午夜）YYYYMMDD —— base-data 增量默认范围用，对齐前端 todayMidnight。 */
function todayYyyymmdd(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

/** YYYYMMDD ± n 自然日（UTC 锚定纯日历算术，不受本机 TZ 影响日差）。 */
function shiftYyyymmdd(yyyymmdd: string, deltaDays: number): string {
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00Z`;
  const t = new Date(iso).getTime() + deltaDays * 86400000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
