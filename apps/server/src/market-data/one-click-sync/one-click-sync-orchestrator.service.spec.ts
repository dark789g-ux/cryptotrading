// 「一键同步」编排器单测：mock 6 个 service，测真实编排行为
//  - done/error 事件判定 success/failed
//  - 某步 failed 不中断后续
//  - 步骤间 cancel（剩余 skipped）
//  - 单飞（已有 running 复用不新建）
//  - boot-sweep（onModuleInit 标 failed）
//
// 用内存 repo（维护一条记录）+ 事件循环 flush 轮询终态，避免依赖真 DB / 真定时器睡眠。

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { OneClickSyncOrchestratorService } from './one-click-sync-orchestrator.service';
import { OneClickSyncRunEntity } from '../../entities/market-data/one-click-sync-run.entity';
import { BaseDataSyncService } from '../base-data-sync/base-data-sync.service';
import { ASharesService } from '../a-shares/a-shares.service';
import { MoneyFlowSyncService } from '../money-flow/money-flow-sync.service';
import { ThsIndexDailySyncService } from '../ths-index-daily/ths-index-daily-sync.service';
import { ActiveMvService } from '../active-mv/active-mv.service';
import { OamvService } from '../oamv/oamv.service';
import { STEP_ORDER, type OneClickStepStatus } from './types';

// ── 内存 repo：维护若干 run 行，支持 create/save/findOne/update/createQueryBuilder.update ──
type RunRow = Partial<OneClickSyncRunEntity> & { id: string; [k: string]: unknown };

function makeInMemoryRepo() {
  const rows: RunRow[] = [];
  let seq = 0;

  function applyNowSentinels(patch: Record<string, unknown>): Record<string, unknown> {
    // TypeORM update() 接受 () => 'now()' 函数式赋值；内存里替换成真 Date。
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      out[k] = typeof v === 'function' ? new Date() : v;
    }
    return out;
  }

  const repo = {
    rows,
    create: jest.fn((data: Partial<OneClickSyncRunEntity>) => ({ ...data })),
    save: jest.fn(async (entity: Partial<OneClickSyncRunEntity>) => {
      const id = entity.id ?? `run-${++seq}`;
      const row: RunRow = {
        id,
        startedAt: new Date(),
        updatedAt: new Date(),
        finishedAt: null,
        ...entity,
      };
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(async (opts: { where?: Record<string, unknown>; order?: Record<string, 'ASC' | 'DESC'> }) => {
      const where = opts?.where ?? {};
      let matched = rows.filter((r) =>
        Object.entries(where).every(([k, v]) => r[k] === v),
      );
      if (opts?.order) {
        const [key, dir] = Object.entries(opts.order)[0];
        matched = [...matched].sort((a, b) => {
          const av = a[key] as Date;
          const bv = b[key] as Date;
          const cmp = (av?.getTime() ?? 0) - (bv?.getTime() ?? 0);
          return dir === 'DESC' ? -cmp : cmp;
        });
      }
      return matched[0] ?? null;
    }),
    find: jest.fn(async (opts?: { order?: Record<string, 'ASC' | 'DESC'>; take?: number }) => {
      let matched = [...rows];
      if (opts?.order) {
        const [key, dir] = Object.entries(opts.order)[0];
        matched.sort((a, b) => {
          const av = a[key] as Date;
          const bv = b[key] as Date;
          const cmp = (av?.getTime() ?? 0) - (bv?.getTime() ?? 0);
          return dir === 'DESC' ? -cmp : cmp;
        });
      }
      return opts?.take ? matched.slice(0, opts.take) : matched;
    }),
    update: jest.fn(async (criteria: { id: string }, patch: Record<string, unknown>) => {
      const row = rows.find((r) => r.id === criteria.id);
      if (row) Object.assign(row, applyNowSentinels(patch));
      return { affected: row ? 1 : 0 };
    }),
    createQueryBuilder: jest.fn(() => {
      let setPatch: Record<string, unknown> = {};
      let whereVal: Record<string, unknown> = {};
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn((p: Record<string, unknown>) => {
          setPatch = p;
          return qb;
        }),
        where: jest.fn((_clause: string, params: Record<string, unknown>) => {
          whereVal = params;
          return qb;
        }),
        execute: jest.fn(async () => {
          const target = rows.filter((r) => r.status === whereVal.status);
          for (const r of target) Object.assign(r, applyNowSentinels(setPatch));
          return { affected: target.length };
        }),
      };
      return qb;
    }),
  };
  return repo;
}

/** 反复 flush 事件循环直到 predicate 为真或超出尝试次数（避免真睡眠）。 */
async function flushUntil(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) throw new Error('flushUntil 超时：predicate 未在限定 tick 内为真');
}

/** 制造一个「立即异步推 done 并 complete」的 Subject（模拟 SSE 步骤）。 */
function doneSubject<E>(doneEvent: E): Subject<E> {
  const s = new Subject<E>();
  setImmediate(() => {
    s.next(doneEvent);
    s.complete();
  });
  return s;
}

/** 制造一个推 error 并 complete 的 Subject。 */
function errorSubject<E>(errorEvent: E): Subject<E> {
  const s = new Subject<E>();
  setImmediate(() => {
    s.next(errorEvent);
    s.complete();
  });
  return s;
}

/** 今日 YYYYMMDD（本地午夜）—— 镜像 step-runners.todayYyyymmdd，供「水位已到今日」用例造水位。 */
function todayYmd(): string {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
}

interface Mocks {
  baseData: { startSync: jest.Mock; getStoredRange: jest.Mock };
  aShares: { startSync: jest.Mock };
  moneyFlow: { startSync: jest.Mock };
  thsIndexDaily: { startSync: jest.Mock };
  activeMv: { syncStock: jest.Mock; syncIndustry: jest.Mock; syncConcept: jest.Mock };
  oamv: { sync0amv: jest.Mock };
}

function happyMocks(): Mocks {
  return {
    baseData: {
      getStoredRange: jest.fn().mockResolvedValue({
        stkLimit: { min: '20260101', max: '20260601' },
        suspend: { min: null, max: null },
        tradeCal: { min: null, max: null },
      }),
      startSync: jest.fn(() =>
        doneSubject({ type: 'done', message: 'ok', result: { success: 10, skipped: 0, errors: [], warnings: [] } }),
      ),
    },
    aShares: {
      startSync: jest.fn(() => doneSubject({ type: 'done', message: 'A 股完成', status: 'done' })),
    },
    moneyFlow: {
      startSync: jest.fn(() =>
        doneSubject({
          type: 'done',
          message: 'ok',
          summary: {
            stocks: { success: 5, skipped: 0, errors: [] },
            industries: { success: 3, skipped: 0, errors: [] },
            sectors: { success: 2, skipped: 0, errors: [] },
            market: { success: 1, skipped: 0, errors: [] },
          },
        }),
      ),
    },
    thsIndexDaily: {
      startSync: jest.fn(() =>
        doneSubject({ type: 'done', message: 'ok', result: { success: 7, skipped: 0, errors: [] } }),
      ),
    },
    activeMv: {
      syncStock: jest.fn().mockResolvedValue({ synced: 100 }),
      syncIndustry: jest.fn().mockResolvedValue({ synced: 50 }),
      syncConcept: jest.fn().mockResolvedValue({ synced: 40 }),
    },
    oamv: { sync0amv: jest.fn().mockResolvedValue({ synced: 30 }) },
  };
}

async function buildModule(mocks: Mocks, repo: ReturnType<typeof makeInMemoryRepo>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OneClickSyncOrchestratorService,
      { provide: getRepositoryToken(OneClickSyncRunEntity), useValue: repo },
      { provide: BaseDataSyncService, useValue: mocks.baseData },
      { provide: ASharesService, useValue: mocks.aShares },
      { provide: MoneyFlowSyncService, useValue: mocks.moneyFlow },
      { provide: ThsIndexDailySyncService, useValue: mocks.thsIndexDaily },
      { provide: ActiveMvService, useValue: mocks.activeMv },
      { provide: OamvService, useValue: mocks.oamv },
    ],
  }).compile();
  module.useLogger(false);
  return module.get(OneClickSyncOrchestratorService);
}

function statusesOf(repo: ReturnType<typeof makeInMemoryRepo>, id: string): OneClickStepStatus[] {
  const row = repo.rows.find((r) => r.id === id);
  return (row?.steps ?? []).map((s) => s.status);
}

describe('OneClickSyncOrchestratorService', () => {
  it('全 8 步成功 → run success，各步 success + rowsWritten 落库', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', 'user-1');
    expect(run.status).toBe('running');
    expect(run.steps).toHaveLength(8);

    await flushUntil(() => repo.rows[0]?.status !== 'running');
    const row = repo.rows[0];
    expect(row.status).toBe('success');
    expect(row.currentStep).toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect(statusesOf(repo, run.id)).toEqual(Array(8).fill('success'));
    const rows = (row.steps ?? []).map((s) => s.rowsWritten);
    expect(rows).toEqual([10, 0, 11, 7, 100, 50, 40, 30]); // a-shares 不取 rowsWritten=0；money-flow Σ=11
  });

  it('base-data 用增量默认范围（stkLimit.max+1天），不用一键 dateRange', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    const svc = await buildModule(mocks, repo);
    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');
    // stkLimit.max=20260601 → start=20260602；a-shares 用一键 dateRange
    expect(mocks.baseData.startSync).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: '20260602', syncMode: 'incremental' }),
    );
    expect(mocks.aShares.startSync).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '20260601', endDate: '20260610', syncMode: 'incremental' }),
    );
    expect(run.id).toBeDefined();
  });

  it('某步 failed（error 事件）不中断后续步骤，run 终态 failed', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    // money-flow（index 2）推 error 事件
    mocks.moneyFlow.startSync = jest.fn(() => errorSubject({ type: 'error', message: '资金流挂了' }));
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const statuses = statusesOf(repo, run.id);
    expect(statuses[2]).toBe('failed'); // money-flow 失败
    // 后续步骤照常执行成功（不中断）
    expect(statuses[3]).toBe('success');
    expect(statuses[7]).toBe('success');
    expect(repo.rows[0].status).toBe('failed');
    // 普通步骤 4-7 仍被调用
    expect(mocks.oamv.sync0amv).toHaveBeenCalledTimes(1);
  });

  it('普通步骤抛错（reject）也判 failed 且不中断后续', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    mocks.activeMv.syncStock = jest.fn().mockRejectedValue(new Error('AMV 个股炸了'));
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const statuses = statusesOf(repo, run.id);
    expect(statuses[4]).toBe('failed'); // stock-amv
    expect(statuses[5]).toBe('success'); // industry-amv 仍跑
    expect(repo.rows[0].status).toBe('failed');
    const step4 = repo.rows[0].steps?.[4];
    expect(step4?.errors?.[0]?.message).toContain('AMV 个股炸了');
  });

  it('money-flow done 事件携带非空 summary[k].errors → 该步 failed 且记录 errors，后续步骤继续', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    // money-flow（index 2）推 done 事件，但 summary.industries.errors 非空。
    // 据 step-runners applyMoneyFlowDone：errorItems 非空 → setStatus(failed)，但不抛错、不中断。
    mocks.moneyFlow.startSync = jest.fn(() =>
      doneSubject({
        type: 'done',
        message: 'ok',
        summary: {
          stocks: { success: 5, skipped: 0, errors: [] },
          industries: { success: 3, skipped: 0, errors: ['行业 884001 同步失败'] },
          sectors: { success: 2, skipped: 0, errors: [] },
          market: { success: 1, skipped: 0, errors: [] },
        },
      }),
    );
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const statuses = statusesOf(repo, run.id);
    // money-flow 这步因 done-with-errors 判 failed
    expect(statuses[2]).toBe('failed');
    // errors 被记录到该步（warn 级，apiName 映射为中文「行业」）
    const step2 = repo.rows[0].steps?.[2];
    expect(step2?.errors).toHaveLength(1);
    expect(step2?.errors?.[0]?.level).toBe('warn');
    expect(step2?.errors?.[0]?.apiName).toBe('行业');
    expect(step2?.errors?.[0]?.message).toContain('884001');
    // rowsWritten 仍按 Σ summary.success 累计（5+3+2+1=11），证明走的是 done 分支而非 error 分支
    expect(step2?.rowsWritten).toBe(11);
    // 后续步骤仍继续执行（done-with-errors 不中断，只有 cancel 才中断）
    expect(statuses[3]).toBe('success'); // ths-index-daily
    expect(statuses[7]).toBe('success'); // oamv
    expect(mocks.oamv.sync0amv).toHaveBeenCalledTimes(1);
    // 整体终态：有 failed 步 → failed（computeFinalStatus），但 8 步全部跑完
    expect(repo.rows[0].status).toBe('failed');
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(0);
    expect(repo.rows[0].finishedAt).not.toBeNull();
  });

  it('base-data done 事件携带非空 result.errors → 该步 failed，后续步骤仍跑完', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    // base-data（index 0）推 done 事件，但 result.errors 非空（对象形如 {apiName, message, params}）。
    mocks.baseData.startSync = jest.fn(() =>
      doneSubject({
        type: 'done',
        message: 'ok',
        result: {
          success: 8,
          skipped: 0,
          warnings: [],
          errors: [{ apiName: 'stk_limit_empty', message: 'stk_limit 当日 0 行', params: { trade_date: '20260601' } }],
        },
      }),
    );
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const statuses = statusesOf(repo, run.id);
    expect(statuses[0]).toBe('failed'); // base-data 因 done-with-errors 判 failed
    const step0 = repo.rows[0].steps?.[0];
    expect(step0?.errors).toHaveLength(1);
    expect(step0?.errors?.[0]?.level).toBe('warn');
    expect(step0?.errors?.[0]?.apiName).toBe('stk_limit_empty');
    expect(step0?.rowsWritten).toBe(8); // 走 done 分支，rowsWritten = result.success
    // 后续 7 步全部继续并成功
    expect(statuses.slice(1)).toEqual(Array(7).fill('success'));
    expect(repo.rows[0].status).toBe('failed');
  });

  it('base-data 水位已到今日（增量起点落未来）→ 跳过同步，该步 success 且不调 startSync', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    const today = todayYmd();
    // stkLimit.max = 今日 → start = 明日 > end(今日) → resolveBaseDataRange 判 no-new-day
    mocks.baseData.getStoredRange = jest.fn().mockResolvedValue({
      stkLimit: { min: '20260101', max: today },
      suspend: { min: null, max: null },
      tradeCal: { min: null, max: null },
    });
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const statuses = statusesOf(repo, run.id);
    expect(statuses[0]).toBe('success'); // 无新交易日 → success（非 failed）
    expect(mocks.baseData.startSync).not.toHaveBeenCalled(); // 未发起空拉取
    expect(repo.rows[0].steps?.[0]?.rowsWritten).toBe(0);
    // 后续 7 步照常成功，run 终态 success
    expect(statuses.slice(1)).toEqual(Array(7).fill('success'));
    expect(repo.rows[0].status).toBe('success');
  });

  it('base-data done errors 全为 no_open_trade_dates（区间无开市日）→ 该步 success，不落 error 项', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    // 模拟周末/节假日：base-data-sync 提前返回 no_open_trade_dates；success 仍含 trade_cal 写入行数。
    mocks.baseData.startSync = jest.fn(() =>
      doneSubject({
        type: 'done',
        message: '同步完成，1 项失败',
        result: {
          success: 2,
          skipped: 0,
          warnings: [],
          errors: [{ apiName: 'no_open_trade_dates', params: { start_date: '20260613', end_date: '20260614' } }],
        },
      }),
    );
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const statuses = statusesOf(repo, run.id);
    expect(statuses[0]).toBe('success'); // 确定性预期空 → success
    const step0 = repo.rows[0].steps?.[0];
    expect(step0?.errors ?? []).toHaveLength(0); // 预期空不落 error 项（UI 不显失败）
    expect(step0?.rowsWritten).toBe(2); // rowsWritten 仍取 result.success（trade_cal 已写）
    expect(repo.rows[0].status).toBe('success'); // 全 run success
  });

  it('base-data done errors 混入异常空（no_open_trade_dates + stk_limit_empty）→ 仍 failed（不吞异常空）', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    mocks.baseData.startSync = jest.fn(() =>
      doneSubject({
        type: 'done',
        message: 'ok',
        result: {
          success: 3,
          skipped: 0,
          warnings: [],
          errors: [
            { apiName: 'no_open_trade_dates', params: {} },
            { apiName: 'stk_limit_empty', params: { trade_date: '20260610' } },
          ],
        },
      }),
    );
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    expect(statusesOf(repo, run.id)[0]).toBe('failed'); // 混入异常空 → 不豁免
    const step0 = repo.rows[0].steps?.[0];
    expect(step0?.errors).toHaveLength(2); // 两项均记录为 warn 级 error 项
    expect(repo.rows[0].status).toBe('failed');
  });

  it('步骤间 cancel → 剩余步骤 skipped，run 终态 cancelled', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    // base-data done 时把该 run 的 cancel_requested 置 true，使下一轮循环检测到取消
    mocks.baseData.startSync = jest.fn(() => {
      const row = repo.rows[0];
      if (row) row.cancelRequested = true;
      return doneSubject({
        type: 'done',
        message: 'ok',
        result: { success: 1, skipped: 0, errors: [], warnings: [] },
      });
    });
    const svc = await buildModule(mocks, repo);

    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const statuses = statusesOf(repo, run.id);
    expect(statuses[0]).toBe('success'); // base-data 已完成（当前步跑完，无法硬中断）
    // 后续全部 skipped
    expect(statuses.slice(1)).toEqual(Array(7).fill('skipped'));
    expect(repo.rows[0].status).toBe('cancelled');
    expect(repo.rows[0].finishedAt).not.toBeNull();
    // a-shares 等后续 service 未被调用
    expect(mocks.aShares.startSync).not.toHaveBeenCalled();
  });

  it('cancelRun 端点把 cancel_requested 置 true', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    // 让 base-data 永不完成（挂起 Subject），run 维持 running 以便测 cancel 写入
    mocks.baseData.startSync = jest.fn(() => new Subject());
    const svc = await buildModule(mocks, repo);
    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.steps?.[0]?.status === 'running');

    const after = await svc.cancelRun(run.id);
    expect(after.cancelRequested).toBe(true);
    expect(repo.rows[0].cancelRequested).toBe(true);
  });

  it('单飞：已有 running 时 startRun 复用不新建', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    // base-data 挂起 → 第一个 run 维持 running
    mocks.baseData.startSync = jest.fn(() => new Subject());
    const svc = await buildModule(mocks, repo);

    const run1 = await svc.startRun('20260601', '20260610', 'u1');
    await flushUntil(() => repo.rows[0]?.steps?.[0]?.status === 'running');
    const run2 = await svc.startRun('20260701', '20260710', 'u2');

    expect(run2.id).toBe(run1.id); // 复用
    expect(repo.rows).toHaveLength(1); // 未新建第二行
    expect(run2.startDate).toBe('20260601'); // 返回的是既有 running 的范围
  });

  it('getActiveOrLatest：无活跃时返回最近一条', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    const svc = await buildModule(mocks, repo);
    const run = await svc.startRun('20260601', '20260610', null);
    await flushUntil(() => repo.rows[0]?.status !== 'running');

    const active = await svc.getActiveOrLatest();
    expect(active?.id).toBe(run.id);
    expect(active?.status).toBe('success'); // 已终态，作为「最近一条」返回
  });

  it('boot-sweep：onModuleInit 把残留 running 标 failed（服务重启中断）', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    const svc = await buildModule(mocks, repo);
    // 预置一条 running 行（模拟重启前的僵尸）
    repo.rows.push({
      id: 'zombie-1',
      status: 'running',
      startDate: '20260101',
      endDate: '20260110',
      startedAt: new Date(),
      finishedAt: null,
      steps: [],
      logs: [],
    });

    await svc.onModuleInit();

    const z = repo.rows.find((r) => r.id === 'zombie-1');
    expect(z?.status).toBe('failed');
    expect(z?.errorText).toBe('服务重启中断');
    expect(z?.finishedAt).not.toBeNull();
  });

  it('出参时间列为 UTC 墙钟串（带 Z 后缀），日志含 system 开始条', async () => {
    const repo = makeInMemoryRepo();
    const mocks = happyMocks();
    mocks.baseData.startSync = jest.fn(() => new Subject());
    const svc = await buildModule(mocks, repo);
    const run = await svc.startRun('20260601', '20260610', null);
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
    expect(run.finishedAt).toBeNull();
    expect(run.logs[0]?.step).toBe('system');
    expect(run.logs[0]?.text).toContain('20260601 ~ 20260610');
    expect(STEP_ORDER).toHaveLength(8);
  });
});
