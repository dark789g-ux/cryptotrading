// 「一键同步」Step4/5 —— 申万指数日线（SSE）+ 大盘指数日线（普通 await）。
//
// 从 step-runners.ts 拆出（单文件 ≤500 行）。事件结构与 ths-index-daily 同构，
// runSwIndexDaily 镜像 runThsIndexDaily；runMarketIndexDaily 镜像 runOamv。
// 共享工具（awaitSubject / clampPct / failStep / StepContext）从 step-runners 复用。

import type { SwIndexDailySyncEvent } from '../sw-index-daily/sw-index-daily.types';
import type { MarketIndexOnProgress } from '../ths-index-daily/market-index-sync.service';
import type { OneClickErrorItem, OneClickStepKey } from './types';
import { awaitSubject, clampPct, failStep, rethrowIfAbort, throwIfAborted, type StepContext } from './step-runners';

// ── Step4 申万指数日线（sw-index-daily，SSE）───────────────────────────
// done.result.errors[] → 步骤 errors；rowsWritten = result.success。
export async function runSwIndexDaily(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'sw-index-daily';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始申万指数日线同步');
  try {
    let finalEvent: SwIndexDailySyncEvent | null = null;
    const subject = ctx.services.swIndexDaily.startSync({
      start_date: ctx.range.startDate,
      end_date: ctx.range.endDate,
      syncMode: ctx.syncMode,
      signal: ctx.signal,
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
    }, ctx.signal);
    throwIfAborted(ctx.signal);
    applySwIndexDone(ctx, index, key, finalEvent);
  } catch (e) {
    rethrowIfAbort(e);
    failStep(ctx, index, key, e);
  }
}

function applySwIndexDone(
  ctx: StepContext,
  index: number,
  key: OneClickStepKey,
  event: SwIndexDailySyncEvent | null,
): void {
  if (!event || event.type !== 'done') {
    ctx.setStatus(index, 'failed');
    ctx.getStep(index).errors.push({
      step: key,
      level: 'error',
      message: (event?.type === 'error' ? event.message : '') || '申万指数日线同步失败',
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

// ── Step5 大盘指数日线（market-index-daily，普通 await）────────────────
// 镜像 runOamv：await service.sync({start_date, end_date})，结果 errors[] → 步骤 errors。
//
// 注意：market-index-sync.service.ts 的 DTO 当前未声明 syncMode 字段，service 内部也无
// overwrite 分支（无 syncMode/overwrite/filterExisting 关键字）—— 即此处透传 ctx.syncMode
// 实际是 no-op（service JS 运行时忽略该字段）。用对象变量传入避免 TS excess property check；
// 待 service 后续支持 syncMode 时此调用立即生效，无需再改 runner。
export async function runMarketIndexDaily(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'market-index-daily';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', `开始大盘指数日线同步（${ctx.syncMode === 'overwrite' ? '覆盖' : '增量'}模式）`);
  try {
    ctx.patchStep(index, { phase: '同步大盘指数日线', percent: 0 });
    ctx.flushThrottled();
    const onProgress: MarketIndexOnProgress = (p) => {
      ctx.patchStep(index, { phase: p.phase, percent: clampPct(p.percent), message: p.message });
      ctx.flushThrottled();
    };
    const dto = {
      start_date: ctx.range.startDate,
      end_date: ctx.range.endDate,
      syncMode: ctx.syncMode,
      signal: ctx.signal,
      onProgress,
    };
    const result = await ctx.services.marketIndexSync.sync(dto);
    ctx.patchStep(index, { rowsWritten: result?.success ?? 0, percent: 100 });
    const errs = result?.errors ?? [];
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
      ctx.pushLog(key, 'info', '大盘指数日线同步完成');
    }
  } catch (e) {
    rethrowIfAbort(e);
    failStep(ctx, index, key, e);
  }
}
