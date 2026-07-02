/**
 * ETF 步骤执行器（Step 6-8）。
 *
 * Step 6: etf — ETF 目录 + 日线 + PCF + 技术指标
 * Step 7: etf-amv — ETF AMV 活跃市值
 * Step 8: etf-mf — ETF 资金净流入
 */
import type { OneClickStepKey } from './types';
import type { StepContext } from './step-runners';
import { failStep } from './step-runners';

// ── Step6 ETF 数据同步 ───────────────────────────────────────────────────
export async function runEtf(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'etf';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始 ETF 数据同步（目录+日线+PCF+指标）');
  try {
    ctx.patchStep(index, { phase: '同步 ETF 目录', percent: 10 });
    ctx.flushThrottled();

    const result = await ctx.services.etf.sync({
      startDate: ctx.range.startDate,
      endDate: ctx.range.endDate,
      syncMode: ctx.syncMode,
    });

    ctx.patchStep(index, { rowsWritten: result.success, percent: 100 });

    const errs = result.errors ?? [];
    if (errs.length > 0) {
      for (const e of errs) {
        ctx.getStep(index).errors.push({
          step: key,
          level: 'warn',
          apiName: e.apiName,
          message: e.message,
        });
        ctx.pushLog(key, 'warn', `[${e.apiName}] ${e.message}`);
      }
      ctx.setStatus(index, 'failed');
    } else {
      ctx.setStatus(index, 'success');
      ctx.pushLog(key, 'info', `ETF 数据同步完成，写入 ${result.success} 行`);
    }
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

// ── Step7 ETF AMV ────────────────────────────────────────────────────────
export async function runEtfAmv(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'etf-amv';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始 ETF AMV 同步');
  try {
    ctx.patchStep(index, { phase: '同步 ETF AMV', percent: 30 });
    ctx.flushThrottled();

    const result = await ctx.services.etfAmv.sync(
      [], // etfAmvService.sync 内部自行获取 ETF 列表
      ctx.range.startDate,
      ctx.range.endDate,
      ctx.syncMode,
    );

    ctx.patchStep(index, { rowsWritten: result.success, percent: 100 });

    const errs = result.errors ?? [];
    if (errs.length > 0) {
      for (const e of errs) {
        ctx.getStep(index).errors.push({
          step: key,
          level: 'warn',
          apiName: e.apiName,
          message: e.message,
        });
        ctx.pushLog(key, 'warn', `[${e.apiName}] ${e.message}`);
      }
      ctx.setStatus(index, 'failed');
    } else {
      ctx.setStatus(index, 'success');
      ctx.pushLog(key, 'info', `ETF AMV 完成，写入 ${result.success} 行`);
    }
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}

// ── Step8 ETF 资金净流入 ───────────────────────────────────────────────
export async function runEtfMf(ctx: StepContext, index: number): Promise<void> {
  const key: OneClickStepKey = 'etf-mf';
  ctx.setStatus(index, 'running');
  ctx.pushLog(key, 'info', '开始 ETF 资金净流入同步');
  try {
    ctx.patchStep(index, { phase: '同步 ETF 资金净流入', percent: 30 });
    ctx.flushThrottled();

    const result = await ctx.services.etfMf.sync(
      [], // etfMfService.sync 内部自行获取 ETF 列表
      ctx.range.startDate,
      ctx.range.endDate,
      ctx.syncMode,
    );

    ctx.patchStep(index, { rowsWritten: result.success, percent: 100 });

    const errs = result.errors ?? [];
    if (errs.length > 0) {
      for (const e of errs) {
        ctx.getStep(index).errors.push({
          step: key,
          level: 'warn',
          apiName: e.apiName,
          message: e.message,
        });
        ctx.pushLog(key, 'warn', `[${e.apiName}] ${e.message}`);
      }
      ctx.setStatus(index, 'failed');
    } else {
      ctx.setStatus(index, 'success');
      ctx.pushLog(key, 'info', `ETF 资金净流入完成，写入 ${result.success} 行`);
    }
  } catch (e) {
    failStep(ctx, index, key, e);
  }
}
