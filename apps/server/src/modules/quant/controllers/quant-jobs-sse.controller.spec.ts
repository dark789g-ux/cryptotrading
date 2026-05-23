import { EventEmitter } from 'events';
import { Subject, firstValueFrom, lastValueFrom, take, toArray } from 'rxjs';
import { ForbiddenException } from '@nestjs/common';
import { QuantJobsSseController, type SseMessageEvent } from './quant-jobs-sse.controller';
import type { MlJobProgressEvent } from '../realtime/pg-listen.service';

// SSE stream 本身做 admin 二次校验（spec 2026-05-23 03-backend.md「SSE 守卫」）：
// token 解出 user_id 后查 DB 读 users.role，role!=admin → subscriber.error(ForbiddenException) 关流；
// 防 token 颁发后用户被降级（refactor 2026-05-23：由 env 白名单改为 users.role）。
const ADMIN_USER = 'admin-user-1';

/**
 * 默认 mock users 仓库：返回 admin 用户。
 * 用例可覆盖 findOne 返回不同 role / null 模拟降级或不存在场景。
 */
function makeUsersRepo(
  override: Partial<{ id: string; role: 'admin' | 'user' }> | null = { id: ADMIN_USER, role: 'admin' },
) {
  return {
    findOne: jest.fn(async () => (override === null ? null : override)),
  };
}

/**
 * 构造一个带 sseTokenPayload 的 mock req；默认 user_id = ADMIN_USER 让 admin 二次校验通过。
 */
function makeReq(opts: { adminUser?: string | null } = {}): EventEmitter & {
  sseTokenPayload?: { job_id: string; user_id: string };
} {
  const r = new EventEmitter() as EventEmitter & {
    sseTokenPayload?: { job_id: string; user_id: string };
  };
  const uid = opts.adminUser === undefined ? ADMIN_USER : opts.adminUser;
  if (uid !== null) {
    r.sseTokenPayload = { job_id: 'job-x', user_id: uid };
  }
  return r;
}

/**
 * Controller 单测：mock QuantJobsService + PgListenService.events$() + UserEntity repo，
 * 验证：
 *  1. 建连立即推送快照（在 admin 校验通过后）
 *  2. Subject emit 后 SSE 收到事件
 *  3. 不属于当前 job_id 的 emit 不被转发
 *  4. 终态时发 complete 后关流
 *  5. 客户端断开 → 订阅释放（teardown 调用）
 *  6. 建连时已是终态 → 立即 complete
 *  7. token user 已被降级 → subscriber.error(Forbidden) 关流
 */
describe('QuantJobsSseController (M4 真实 SSE + PG LISTEN)', () => {
  const JOB_ID = '11111111-2222-3333-4444-555555555555';

  function makeRow(over: Partial<{
    status: string;
    progress: number;
    stage: string | null;
    heartbeatAt: Date | null;
  }> = {}) {
    return {
      id: JOB_ID,
      status: 'running',
      progress: 10,
      stage: 'fold-1',
      heartbeatAt: null,
      ...over,
    };
  }

  function makeSetup(initialRow = makeRow()) {
    const subject = new Subject<MlJobProgressEvent>();
    const jobs = {
      findOne: jest.fn(async (_id: string) => initialRow),
    };
    const pgListen = {
      events$: () => subject.asObservable(),
    };
    const users = makeUsersRepo();
    const controller = new QuantJobsSseController(jobs as any, pgListen as any, users as any);
    const req = makeReq() as unknown as { on: (e: string, cb: () => void) => void };
    return { controller, subject, jobs, pgListen, users, req };
  }

  // 把 controller 返回的 Observable 收集前 N 条事件
  async function collect(obs: ReturnType<QuantJobsSseController['stream']>, n: number) {
    return await firstValueFrom(obs.pipe(take(n), toArray()));
  }

  it('建连瞬间立即推一条快照事件（findOne 调用一次）', async () => {
    const { controller, jobs, req } = makeSetup(makeRow({ progress: 7 }));
    const obs = controller.stream(JOB_ID, req as any);
    const events = await collect(obs, 1);
    expect(jobs.findOne).toHaveBeenCalledWith(JOB_ID);
    expect(events[0].data).toMatchObject({
      job_id: JOB_ID,
      status: 'running',
      progress: 7,
      stage: 'fold-1',
    });
  });

  it('快照后 Subject emit → 订阅者收到转发事件', async () => {
    const { controller, subject, req } = makeSetup();
    const obs = controller.stream(JOB_ID, req as any);
    // 收集 2 条：快照 + 一次 emit
    const collected: SseMessageEvent[] = [];
    const sub = obs.subscribe((e) => collected.push(e));
    // 让快照 Promise 解析（admin 校验 + findOne 两段 microtask，多 flush 几次）
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    subject.next({ job_id: JOB_ID, progress: 30, stage: 'training' });
    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();
    expect(collected.length).toBeGreaterThanOrEqual(2);
    expect(collected[1].data).toEqual({
      job_id: JOB_ID,
      progress: 30,
      stage: 'training',
    });
  });

  it('不属于该 job_id 的 emit 不被转发', async () => {
    const { controller, subject, req } = makeSetup();
    const obs = controller.stream(JOB_ID, req as any);
    const collected: SseMessageEvent[] = [];
    const sub = obs.subscribe((e) => collected.push(e));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // 不同 job_id：过滤掉
    subject.next({
      job_id: '99999999-2222-3333-4444-555555555555',
      progress: 50,
      stage: 'other',
    });
    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();
    // 只有一条快照
    expect(collected.length).toBe(1);
    expect(collected[0].data).toMatchObject({ job_id: JOB_ID });
  });

  it('Subject emit progress=100 且 status 终态 → 发 complete event 后关流', async () => {
    const initial = makeRow({ status: 'running', progress: 80 });
    // 第二次 findOne（progress=100 时重新查 status）返回 success
    const successRow = makeRow({ status: 'success', progress: 100, stage: 'done' });
    const { controller, subject, jobs, req } = makeSetup(initial);
    (jobs.findOne as jest.Mock)
      .mockResolvedValueOnce(initial) // 第一次：快照
      .mockResolvedValueOnce(successRow); // 第二次：terminal recheck

    const obs = controller.stream(JOB_ID, req as any);
    const completed = jest.fn();
    const collected: SseMessageEvent[] = [];
    const sub = obs.subscribe({
      next: (e) => collected.push(e),
      complete: completed,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    subject.next({ job_id: JOB_ID, progress: 100, stage: 'done' });
    // 等待 async recheck
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();

    expect(collected.length).toBeGreaterThanOrEqual(3);
    const completeEvt = collected.find((e) => e.type === 'complete');
    expect(completeEvt).toBeTruthy();
    expect(completeEvt?.data).toMatchObject({ job_id: JOB_ID, status: 'success' });
    expect(completed).toHaveBeenCalled();
  });

  it('建连时已是终态 → 快照后立即 complete + 关流', async () => {
    const terminal = makeRow({ status: 'failed', progress: 100, stage: 'crashed' });
    const { controller, req } = makeSetup(terminal);
    const obs = controller.stream(JOB_ID, req as any);
    const collected: SseMessageEvent[] = [];
    const completed = jest.fn();
    const sub = obs.subscribe({
      next: (e) => collected.push(e),
      complete: completed,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();
    expect(collected.find((e) => e.type === 'complete')).toBeTruthy();
    expect(completed).toHaveBeenCalled();
  });

  it('客户端断开（req close）→ teardown 取消订阅，后续 Subject emit 不再转发', async () => {
    const { controller, subject, req } = makeSetup();
    const obs = controller.stream(JOB_ID, req as any);
    const collected: SseMessageEvent[] = [];
    const sub = obs.subscribe((e) => collected.push(e));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // 触发 req 的 close 事件（模拟浏览器断开 EventSource）
    (req as unknown as EventEmitter).emit('close');
    await new Promise((r) => setImmediate(r));

    // 之后 emit 不会进入 collected
    subject.next({ job_id: JOB_ID, progress: 99, stage: 'late' });
    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();

    // 应当只有快照那一条
    expect(collected.length).toBe(1);
  });

  it('findOne 抛 NotFoundException → subscriber.error 透出', async () => {
    const subject = new Subject<MlJobProgressEvent>();
    const jobs = {
      findOne: jest.fn(async () => {
        throw new Error('job not found');
      }),
    };
    const pgListen = { events$: () => subject.asObservable() };
    const users = makeUsersRepo();
    const controller = new QuantJobsSseController(jobs as any, pgListen as any, users as any);
    const req = makeReq() as any;
    const obs = controller.stream('does-not-exist', req);
    await expect(lastValueFrom(obs.pipe(take(1)))).rejects.toThrow('job not found');
  });

  describe('admin 二次校验（spec 03-backend.md「SSE 守卫」）', () => {
    it('token 内 user_id 对应的 user.role !== admin → subscriber.error(Forbidden) 关流', async () => {
      const subject = new Subject<MlJobProgressEvent>();
      const jobs = { findOne: jest.fn(async () => makeRow()) };
      const pgListen = { events$: () => subject.asObservable() };
      // token 颁发后被降级：DB 现在返回 role=user
      const users = makeUsersRepo({ id: 'non-admin', role: 'user' });
      const controller = new QuantJobsSseController(jobs as any, pgListen as any, users as any);
      const req = makeReq({ adminUser: 'non-admin' }) as any;
      const obs = controller.stream(JOB_ID, req);
      await expect(lastValueFrom(obs.pipe(take(1)))).rejects.toBeInstanceOf(ForbiddenException);
      // findOne(jobs) 不应被调用，因为 admin 校验先失败
      expect(jobs.findOne).not.toHaveBeenCalled();
    });

    it('token user 在 DB 中不存在（被删号） → subscriber.error(Forbidden)', async () => {
      const subject = new Subject<MlJobProgressEvent>();
      const jobs = { findOne: jest.fn(async () => makeRow()) };
      const pgListen = { events$: () => subject.asObservable() };
      const users = makeUsersRepo(null);
      const controller = new QuantJobsSseController(jobs as any, pgListen as any, users as any);
      const req = makeReq({ adminUser: 'ghost-user' }) as any;
      const obs = controller.stream(JOB_ID, req);
      await expect(lastValueFrom(obs.pipe(take(1)))).rejects.toBeInstanceOf(ForbiddenException);
      expect(jobs.findOne).not.toHaveBeenCalled();
    });

    it('req.sseTokenPayload 缺失 → 同步 ForbiddenException（防御兜底）', () => {
      const subject = new Subject<MlJobProgressEvent>();
      const jobs = { findOne: jest.fn(async () => makeRow()) };
      const pgListen = { events$: () => subject.asObservable() };
      const users = makeUsersRepo();
      const controller = new QuantJobsSseController(jobs as any, pgListen as any, users as any);
      const req = makeReq({ adminUser: null }) as any;
      expect(() => controller.stream(JOB_ID, req)).toThrow(ForbiddenException);
      expect(users.findOne).not.toHaveBeenCalled();
    });
  });
});
