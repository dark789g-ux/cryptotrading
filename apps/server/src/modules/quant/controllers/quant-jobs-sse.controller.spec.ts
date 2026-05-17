import { EventEmitter } from 'events';
import { Subject, firstValueFrom, lastValueFrom, take, toArray } from 'rxjs';
import { QuantJobsSseController, type SseMessageEvent } from './quant-jobs-sse.controller';
import type { MlJobProgressEvent } from '../realtime/pg-listen.service';

/**
 * Controller 单测：mock QuantJobsService + PgListenService.events$()，
 * 验证：
 *  1. 建连立即推送快照
 *  2. Subject emit 后 SSE 收到事件
 *  3. 不属于当前 job_id 的 emit 不被转发
 *  4. 终态时发 complete 后关流
 *  5. 客户端断开 → 订阅释放（teardown 调用）
 *  6. 建连时已是终态 → 立即 complete
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
    const controller = new QuantJobsSseController(jobs as any, pgListen as any);
    const req = new EventEmitter() as unknown as { on: (e: string, cb: () => void) => void };
    return { controller, subject, jobs, pgListen, req };
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
    // 让快照 Promise 解析
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
    const controller = new QuantJobsSseController(jobs as any, pgListen as any);
    const req = new EventEmitter() as any;
    const obs = controller.stream('does-not-exist', req);
    await expect(lastValueFrom(obs.pipe(take(1)))).rejects.toThrow('job not found');
  });
});
